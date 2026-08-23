// Connector Health Alerts (RADAR-DEMAND-DATA-SPEC.md #23): brotes
// sanitarios reportados en WHO Disease Outbreak News, vía la API JSON del
// sitio de WHO (gratis, sin key). Cancelador de demanda a nivel país: un
// brote mediático re-rutea turismo aunque el riesgo real sea acotado —
// la severidad pondera lo que asusta al viajero.
//
// Un DON puede nombrar varios países ("… Congo & Uganda"): se emite una
// señal por país matcheado. Títulos sin país mapeable ("Multi-locations",
// "Global") se descartan — sin geo no hay render ni correlación.

import { v4 as uuid } from "uuid";
import { HEALTH_CONFIG } from "../core/intelligence.config";
import { countryNameToIso } from "../core/countryNames";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const WHO_API =
  "https://www.who.int/api/emergencies/diseaseoutbreaknews" +
  "?sf_provider=dynamicProvider372&sf_culture=en" +
  "&%24orderby=PublicationDateAndTime%20desc" +
  "&%24select=Title,OverrideTitle,PublicationDateAndTime,DonId,UrlName,ItemDefaultUrl";

interface WhoDon {
  Title: string;
  OverrideTitle?: string;
  PublicationDateAndTime: string;
  DonId: string;
  UrlName?: string;
  ItemDefaultUrl?: string;
}

// "Ebola disease caused by X - Democratic Republic of the Congo"
// "Ebola…, Democratic Republic of the Congo & Uganda"  → [CD, UG]
export function extractCountries(title: string): Array<{ name: string; iso: string }> {
  // El país viene al final, tras el último " - " o la última coma.
  const bySep = title.split(/ [-–] /);
  const tail = bySep.length > 1 ? bySep[bySep.length - 1] : title.split(/,(?=[^,]*$)/).pop() ?? "";
  return tail
    .split(/\s*(?:&|,| and )\s*/i)
    .map((raw) => ({ name: raw.trim(), iso: countryNameToIso(raw) ?? "" }))
    .filter((c) => c.iso !== "");
}

export function severityFor(title: string): number {
  for (const { pattern, weight } of HEALTH_CONFIG.severityByKeyword) {
    if (pattern.test(title)) return weight;
  }
  return HEALTH_CONFIG.defaultSeverity;
}

export function createHealthAlertsConnector(): Connector {
  return {
    name: "health-alerts",

    async healthCheck() {
      try {
        const res = await fetchJson<{ value: WhoDon[] }>(`${WHO_API}&%24top=1&%24format=json`, {
          retries: 0,
        });
        return {
          ok: Array.isArray(res.value) && res.value.length > 0,
          detail: "who.int DON API OK (sin key)",
        };
      } catch (err) {
        return { ok: false, detail: `who.int inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const res = await fetchJson<{ value: WhoDon[] }>(
        `${WHO_API}&%24top=${HEALTH_CONFIG.maxItems}&%24format=json`,
      );
      const signals: Signal[] = [];
      let unresolved = 0;

      for (const don of res.value ?? []) {
        const title = don.OverrideTitle || don.Title;
        if (!title || !don.PublicationDateAndTime) continue;
        const published = don.PublicationDateAndTime.slice(0, 10);
        const countries = extractCountries(title);
        if (countries.length === 0) {
          unresolved++;
          continue;
        }
        const severity = severityFor(title);
        const url = `https://www.who.int/emergencies/disease-outbreak-news/item/${don.UrlName ?? don.DonId}`;

        for (const country of countries) {
          signals.push({
            id: uuid(),
            type: "health_alert",
            source: "who-don",
            scope: { geo: { countryCode: country.iso } },
            timeWindow: {
              start: `${published}T00:00:00Z`,
              end: new Date(
                new Date(`${published}T00:00:00Z`).getTime() +
                  HEALTH_CONFIG.windowDays * 86_400_000,
              ).toISOString(),
            },
            magnitude: severity,
            confidence: SOURCE_CONFIDENCE["who-don"],
            rawPayload: {
              title,
              country: country.name,
              donId: don.DonId,
              published,
              url,
            },
            ingestedAt: "",
            dedupeKey: `health:${don.DonId}:${country.iso}`,
          });
        }
      }

      return {
        signals,
        meta: {
          fetched: res.value?.length ?? 0,
          unresolved,
          produced: signals.length,
        },
      };
    },
  };
}
