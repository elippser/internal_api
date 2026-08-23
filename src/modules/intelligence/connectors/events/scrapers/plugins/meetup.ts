// Plugin Meetup (GraphQL) — long tail de eventos chicos, global.
//
// Cubre lo que Ticketmaster no ve: talleres, tours, encuentros, actividades
// locales. Verificado (ago-2026): el endpoint gql-ext responde sin auth y
// devuelve venue.lat/lon reales en Londres, Barcelona, París y Tokio.
//
// Advertencias que condicionan el diseño:
//  - Es acceso NO DOCUMENTADO a un endpoint que oficialmente pide cuenta Pro:
//    puede cerrarse sin aviso. Por eso hay circuit breaker y la fuente nunca
//    es crítica — si muere, devuelve [] y el resto del pipeline sigue.
//  - `query` es obligatorio: no se puede barrer "todo en este radio", hay que
//    iterar keywords.
//  - El campo es `lon` (no `lng`) y `country` viene con casing inconsistente.

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";
import { sweepCities, type SweepPoint } from "../../../../core/cities.catalog";

const ENDPOINT = "https://api.meetup.com/gql-ext";
const THROTTLE_MS = 350;
const MAX_CONSECUTIVE_FAILURES = 3;

// Términos que capturan las categorías con impacto en ocupación hotelera.
const KEYWORDS = ["music", "festival", "food", "art", "conference"];

const QUERY = `query Search($q:String!,$lat:Float!,$lon:Float!,$radius:Float!,$start:DateTime!){
  eventSearch(filter:{query:$q,lat:$lat,lon:$lon,radius:$radius,startDateRange:$start},first:40){
    totalCount
    edges{node{id title dateTime endTime eventUrl venue{name lat lon city country}}}
  }
}`;

interface MeetupNode {
  id: string;
  title?: string;
  dateTime?: string;
  endTime?: string;
  eventUrl?: string;
  venue?: { name?: string; lat?: number; lon?: number; city?: string; country?: string };
}

interface MeetupResponse {
  data?: { eventSearch?: { totalCount?: number; edges?: Array<{ node: MeetupNode }> } };
  errors?: Array<{ message?: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const meetupPlugin: ScraperPlugin = {
  marketCode: "GLOBAL",
  sourceLabel: "meetup",
  kind: "api",
  // Fuente oportunista: se apaga con IH_SCRAPERS_DISABLED=meetup si molesta.
  enabled: true,

  async scrape(): Promise<Signal[]> {
    const signals: Signal[] = [];
    const seen = new Set<string>();
    // Solo mercados tier 1: el barrido es keyword×ciudad y no conviene
    // gastar cientos de requests en un endpoint no contractual.
    // …salvo los puntos de barrido de las properties (pocos y con radio chico).
    const cities = sweepCities().filter((c) => c.tier === 1 || (c as SweepPoint).isWatchpoint);
    const start = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let consecutiveFailures = 0;

    for (const city of cities) {
      for (const keyword of KEYWORDS) {
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error("[intelligence] meetup: circuit breaker abierto, se aborta el barrido");
          return signals;
        }
        try {
          await sleep(THROTTLE_MS);
          const res = await fetchJson<MeetupResponse>(ENDPOINT, {
            method: "POST",
            retries: 0,
            timeoutMs: 15_000,
            headers: {
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            },
            body: {
              query: QUERY,
              variables: {
                q: keyword,
                lat: city.lat,
                lon: city.lng,
                radius: Math.round(city.radiusKm * 0.621371), // la API espera millas
                start,
              },
            },
          });
          if (res.errors?.length) throw new Error(res.errors[0]?.message ?? "GraphQL error");
          consecutiveFailures = 0;

          for (const edge of res.data?.eventSearch?.edges ?? []) {
            const n = edge.node;
            const lat = n.venue?.lat;
            const lon = n.venue?.lon;
            if (!n.title || !n.dateTime) continue;
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            const hasGeo =
              typeof lat === "number" && typeof lon === "number" && !(lat === 0 && lon === 0);

            const ev: ScrapedEvent = {
              name: n.title,
              startDate: n.dateTime.slice(0, 10),
              endDate: n.endTime ? n.endTime.slice(0, 10) : undefined,
              venue: n.venue?.name ?? undefined,
              url: n.eventUrl ?? undefined,
              category: keyword === "conference" ? "conference" : "miscellaneous",
              ...(hasGeo ? { lat, lng: lon } : {}),
            };
            const signal = scrapedToSignal(ev, {
              sourceLabel: "meetup",
              // El casing de country es inconsistente en esta API.
              countryCode: (n.venue?.country ?? city.countryCode).toUpperCase(),
              city: n.venue?.city ?? city.label,
              lat: city.lat,
              lng: city.lng,
              kind: "api",
              // Eventos chicos y auto-publicados: menos confianza que un
              // open data oficial, aunque el transporte sea una API.
              confidence: 0.5,
            });
            if (signal) signals.push(signal);
          }
        } catch (err) {
          consecutiveFailures++;
          console.error(
            `[intelligence] meetup ${city.label}/${keyword} falló:`,
            (err as Error).message,
          );
        }
      }
    }
    return signals;
  },
};
