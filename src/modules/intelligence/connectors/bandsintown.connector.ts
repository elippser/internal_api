// Connector Bandsintown (RADAR-DEMAND-DATA-SPEC.md #17): fechas de gira de
// artistas de estadio/arena — los shows que agotan la hotelería de una
// ciudad y se anuncian con 6-12 meses de lead.
//
// La API pública de Bandsintown fue cerrada (requiere app_id registrado);
// el connector queda gated por IH_BANDSINTOWN_APP_ID y reporta degradado
// sin ella, igual que AeroDataBox. Artist-centric: sigue el catálogo de
// BANDSINTOWN_CONFIG.artists (top touring, override por env) y devuelve
// venue con lat/lng exactos — sin geocodificación propia.
//
// Complementa a Ticketmaster: TM cubre lo que vende TM; Bandsintown agrega
// las fechas anunciadas antes del on-sale y mercados donde TM no opera.

import { v4 as uuid } from "uuid";
import { BANDSINTOWN_CONFIG } from "../core/intelligence.config";
import { EVENT_SEGMENT_WEIGHTS } from "../core/intelligence.config";
// La API devuelve el país como nombre en inglés; sin match, el scope queda
// solo con lat/lng.
import { countryNameToIso } from "../core/countryNames";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const BASE = "https://rest.bandsintown.com";

interface BitVenue {
  name: string;
  city: string;
  region?: string;
  country: string;
  latitude: string | number;
  longitude: string | number;
}

interface BitEvent {
  id: string;
  datetime: string; // ISO local del venue
  title?: string;
  url?: string;
  venue: BitVenue;
  lineup?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBandsintownConnector(): Connector {
  return {
    name: "bandsintown",

    async healthCheck() {
      if (!BANDSINTOWN_CONFIG.appId) {
        return {
          ok: false,
          detail: "Sin IH_BANDSINTOWN_APP_ID (la API pública fue cerrada; requiere app_id registrado)",
        };
      }
      try {
        const res = await fetchJson<unknown>(
          `${BASE}/artists/${encodeURIComponent("Coldplay")}?app_id=${encodeURIComponent(BANDSINTOWN_CONFIG.appId)}`,
          { retries: 0 },
        );
        const ok = typeof res === "object" && res !== null && !("Message" in (res as object));
        return { ok, detail: ok ? "bandsintown OK" : "bandsintown rechaza el app_id configurado" };
      } catch (err) {
        return { ok: false, detail: `bandsintown inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      if (!BANDSINTOWN_CONFIG.appId) {
        return {
          signals: [],
          meta: { skipped: "Sin IH_BANDSINTOWN_APP_ID", artists: BANDSINTOWN_CONFIG.artists.length },
        };
      }

      const signals: Signal[] = [];
      const errors: string[] = [];
      const perArtist: Record<string, number> = {};
      const musicWeight = EVENT_SEGMENT_WEIGHTS.music ?? 0.8;

      for (const artist of BANDSINTOWN_CONFIG.artists) {
        try {
          await sleep(250);
          const events = await fetchJson<BitEvent[] | { Message?: string }>(
            `${BASE}/artists/${encodeURIComponent(artist.name)}/events?app_id=${encodeURIComponent(BANDSINTOWN_CONFIG.appId)}&date=upcoming`,
          );
          if (!Array.isArray(events)) {
            errors.push(`${artist.name}: ${(events as { Message?: string }).Message ?? "respuesta no-array"}`);
            continue;
          }
          perArtist[artist.name] = events.length;

          for (const ev of events) {
            const lat = Number(ev.venue?.latitude);
            const lng = Number(ev.venue?.longitude);
            const date = (ev.datetime ?? "").slice(0, 10);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

            const countryCode = countryNameToIso(ev.venue.country) ?? undefined;
            signals.push({
              id: uuid(),
              type: "event",
              source: "bandsintown",
              scope: {
                geo: {
                  lat,
                  lng,
                  ...(countryCode ? { countryCode } : {}),
                  city: ev.venue.city || undefined,
                },
              },
              timeWindow: {
                start: `${date}T00:00:00Z`,
                end: `${date}T23:59:59Z`,
              },
              magnitude: Math.min(1, musicWeight * artist.weight),
              confidence: SOURCE_CONFIDENCE.bandsintown,
              rawPayload: {
                name: ev.title || `${artist.name} — ${ev.venue.city}`,
                venue: ev.venue.name ?? null,
                segment: "music",
                category: "music",
                artist: artist.name,
                lineup: ev.lineup ?? [artist.name],
                url: ev.url ?? null,
              },
              ingestedAt: "",
              dedupeKey: `event:bandsintown:${ev.id}`,
            });
          }
        } catch (err) {
          errors.push(`${artist.name}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          artists: BANDSINTOWN_CONFIG.artists.length,
          perArtist,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
