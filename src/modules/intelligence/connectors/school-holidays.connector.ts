// Connector School Holidays (RADAR-DEMAND-DATA-SPEC.md #8): vacaciones
// escolares de mercados emisores vía OpenHolidays API (gratis, sin key,
// dato oficial de ministerios de educación → confidence 0.95).
//
// Por qué importa: en Europa el calendario escolar decide CUÁNDO viaja la
// familia — se conoce con ~1 año de antelación y explica picos que los
// feriados nacionales no ven (ej. vacances de février francesas escalonadas
// por zona). Cadencia mensual: los calendarios casi no cambian intra-año.

import { v4 as uuid } from "uuid";
import { SCHOOL_HOLIDAYS_CONFIG } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const OPENHOLIDAYS_BASE = "https://openholidaysapi.org";

interface OpenHolidayPeriod {
  id: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  type: string; // "School" | ...
  name: Array<{ language: string; text: string }>;
  nationwide: boolean;
  subdivisions?: Array<{ code: string; shortName: string }>;
}

const pickName = (names: OpenHolidayPeriod["name"]): string =>
  names.find((n) => n.language === "EN")?.text ?? names[0]?.text ?? "School holiday";

export function createSchoolHolidaysConnector(): Connector {
  return {
    name: "school-holidays",

    async healthCheck() {
      try {
        const year = new Date().getUTCFullYear();
        const res = await fetchJson<OpenHolidayPeriod[]>(
          `${OPENHOLIDAYS_BASE}/SchoolHolidays?countryIsoCode=DE&languageIsoCode=EN&validFrom=${year}-01-01&validTo=${year}-12-31`,
          { retries: 0 },
        );
        return {
          ok: Array.isArray(res) && res.length > 0,
          detail: "openholidaysapi.org OK (sin key)",
        };
      } catch (err) {
        return { ok: false, detail: `openholidaysapi.org inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const now = new Date();
      const validFrom = now.toISOString().slice(0, 10);
      const validTo = new Date(
        now.getTime() + SCHOOL_HOLIDAYS_CONFIG.monthsAhead * 30 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);

      const signals: Signal[] = [];
      const errors: string[] = [];
      const perCountry: Record<string, number> = {};

      await Promise.allSettled(
        SCHOOL_HOLIDAYS_CONFIG.countryCodes.map(async (countryCode) => {
          try {
            const periods = await fetchJson<OpenHolidayPeriod[]>(
              `${OPENHOLIDAYS_BASE}/SchoolHolidays?countryIsoCode=${countryCode}&languageIsoCode=EN&validFrom=${validFrom}&validTo=${validTo}`,
            );
            perCountry[countryCode] = periods.length;
            for (const p of periods) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) continue;
              const name = pickName(p.name);
              signals.push({
                id: uuid(),
                type: "school_holiday",
                source: "openholidays",
                scope: { geo: { countryCode } },
                timeWindow: {
                  start: `${p.startDate}T00:00:00Z`,
                  end: `${p.endDate ?? p.startDate}T23:59:59Z`,
                },
                // Nacional = todo el mercado emisor de vacaciones a la vez.
                // Regional (ej. länder alemanes escalonados) mueve una
                // fracción, pero sostenida en el tiempo.
                magnitude: p.nationwide ? 0.9 : 0.5,
                confidence: SOURCE_CONFIDENCE.openholidays,
                rawPayload: {
                  name,
                  nationwide: p.nationwide,
                  subdivisions: (p.subdivisions ?? []).map((s) => s.shortName),
                  providerId: p.id,
                },
                ingestedAt: "",
                dedupeKey: `school:${countryCode}:${p.startDate}:${name
                  .toLowerCase()
                  .replace(/\s+/g, "-")
                  .replace(/[^a-z0-9-]/g, "")
                  .slice(0, 60)}`,
              });
            }
          } catch (err) {
            errors.push(`${countryCode}: ${(err as Error).message}`);
          }
        }),
      );

      return {
        signals,
        meta: {
          countries: SCHOOL_HOLIDAYS_CONFIG.countryCodes,
          window: { validFrom, validTo },
          perCountry,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
