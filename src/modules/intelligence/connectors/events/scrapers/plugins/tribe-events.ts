// Fábrica de plugins "The Events Calendar" (plugin Tribe de WordPress).
//
// Es el calendario de eventos más difundido del mundo WordPress, y muchos
// entes de turismo y venues lo dejan expuesto por REST sin auth:
//   GET {site}/wp-json/tribe/events/v1/events?start_date=&end_date=&page=
// Verificado (ago-2026): choosechicago.com → 6.183 eventos futuros.
//
// El venue trae dirección postal; algunas instalaciones publican además
// venue.geo_lat/geo_lng. Se usan cuando están, y si no el evento cae al
// centro de la ciudad con dispersión (rawPayload.approxLocation = true).

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

export interface TribeSite {
  sourceLabel: string;
  marketCode: string;
  site: string; // ej. "https://www.choosechicago.com"
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  // Radio urbano para dispersar eventos sin coordenada propia.
  spreadKm?: number;
  windowDays?: number;
  maxPages?: number;
  enabled?: boolean;
}

const PER_PAGE = 50;

interface TribeVenue {
  venue?: string;
  address?: string;
  city?: string;
  country?: string;
  geo_lat?: number | string;
  geo_lng?: number | string;
}

interface TribeEvent {
  id: number;
  title?: string;
  url?: string;
  start_date?: string; // "2026-08-01 19:30:00"
  end_date?: string;
  venue?: TribeVenue | unknown[];
  categories?: Array<{ name?: string }>;
}

interface TribeResponse {
  events?: TribeEvent[];
  total?: number;
  total_pages?: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function createTribePlugin(cfg: TribeSite): ScraperPlugin {
  return {
    marketCode: cfg.marketCode,
    sourceLabel: cfg.sourceLabel,
    kind: "api",
    enabled: cfg.enabled !== false,

    async scrape(): Promise<Signal[]> {
      const ctx = {
        sourceLabel: cfg.sourceLabel,
        countryCode: cfg.countryCode,
        city: cfg.city,
        lat: cfg.lat,
        lng: cfg.lng,
        fallbackSpreadKm: cfg.spreadKm ?? 6,
        kind: "api" as const,
        defaultCategory: "miscellaneous",
      };
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(
        Date.now() + (cfg.windowDays ?? 120) * 86_400_000,
      ).toISOString().slice(0, 10);
      const maxPages = cfg.maxPages ?? 20;
      const signals: Signal[] = [];

      try {
        for (let page = 1; page <= maxPages; page++) {
          const params = new URLSearchParams({
            start_date: today,
            end_date: horizon,
            per_page: String(PER_PAGE),
            page: String(page),
          });
          const res = await fetchJson<TribeResponse>(
            `${cfg.site}/wp-json/tribe/events/v1/events?${params}`,
            {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
              },
            },
          );
          const events = res.events ?? [];
          for (const ev of events) {
            const name = decodeEntities(String(ev.title ?? ""));
            if (!name || !ev.start_date) continue;
            const startDate = ev.start_date.slice(0, 10);
            if (startDate < today || startDate > horizon) continue;

            // Tribe devuelve [] en vez de objeto cuando no hay venue.
            const venue = (Array.isArray(ev.venue) ? undefined : ev.venue) as TribeVenue | undefined;
            const gLat = venue?.geo_lat !== undefined ? Number(venue.geo_lat) : NaN;
            const gLng = venue?.geo_lng !== undefined ? Number(venue.geo_lng) : NaN;
            const hasGeo = isFinite(gLat) && isFinite(gLng) && !(gLat === 0 && gLng === 0);

            const scraped: ScrapedEvent = {
              name,
              startDate,
              endDate: ev.end_date ? ev.end_date.slice(0, 10) : undefined,
              venue: venue?.venue ? decodeEntities(venue.venue) : undefined,
              url: ev.url,
              category: ev.categories?.[0]?.name?.toLowerCase(),
              ...(hasGeo ? { lat: gLat, lng: gLng } : {}),
            };
            const signal = scrapedToSignal(scraped, ctx);
            if (signal) signals.push(signal);
          }
          const totalPages = res.total_pages ?? 1;
          if (events.length < PER_PAGE || page >= totalPages) break;
        }
        return signals;
      } catch (err) {
        console.error(
          `[intelligence] tribe ${cfg.sourceLabel} falló:`,
          (err as Error).message,
        );
        return signals;
      }
    },
  };
}

export const TRIBE_SITES: TribeSite[] = [
  {
    sourceLabel: "us-chicago-choose",
    marketCode: "US",
    site: "https://www.choosechicago.com",
    city: "Chicago",
    countryCode: "US",
    lat: 41.8781,
    lng: -87.6298,
    spreadKm: 8,
  },
];

export const tribePlugins: ScraperPlugin[] = TRIBE_SITES.map(createTribePlugin);
