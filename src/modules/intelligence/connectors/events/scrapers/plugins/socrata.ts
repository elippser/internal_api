// Fábrica de plugins Socrata (SODA API).
//
// Los portales de open data de ciudades norteamericanas corren sobre Socrata
// con un contrato REST idéntico:
//   GET {portal}/resource/{datasetId}.json?$limit=&$offset=&$where=
// Igual que Opendatasoft: API oficial, sin auth obligatoria, y cuando el
// dataset publica coordenadas los eventos se dispersan bien en el mapa.
//
// Criterio de inclusión: solo datasets con lat/lng propia y con fechas
// futuras verificadas. Los que exigen geocoding externo (NYC Permitted
// Events, Chicago Park Permits) quedan fuera hasta tener esa capa.

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

export interface SocrataDataset {
  sourceLabel: string;
  marketCode: string;
  portal: string; // ej. "https://data.cityofnewyork.us"
  datasetId: string; // ej. "w3wp-dpdi"
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  fields: {
    title: string;
    start: string;
    end?: string;
    venue?: string;
    url?: string;
    category?: string;
    // Formas de geo soportadas, ver readGeo().
    geoPoint?: string; // columna GeoJSON Point
    geoPair?: string; // columna string "lat, lng"
    latField?: string;
    lngField?: string;
  };
  defaultCategory?: string;
  enabled?: boolean;
}

const PAGE_SIZE = 1000;
const MAX_RECORDS = 5000;

function readGeo(
  row: Record<string, any>,
  f: SocrataDataset["fields"],
): { lat: number; lng: number } | null {
  let lat: number | undefined;
  let lng: number | undefined;

  if (f.geoPoint && row[f.geoPoint]?.coordinates) {
    // GeoJSON: [lng, lat] — el orden inverso es el error clásico.
    const [x, y] = row[f.geoPoint].coordinates;
    lng = Number(x);
    lat = Number(y);
  } else if (f.geoPair && typeof row[f.geoPair] === "string") {
    const [a, b] = row[f.geoPair].split(",").map((s: string) => Number(s.trim()));
    lat = a;
    lng = b;
  } else if (f.latField && f.lngField) {
    lat = Number(row[f.latField]);
    lng = Number(row[f.lngField]);
  }

  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function createSocrataPlugin(cfg: SocrataDataset): ScraperPlugin {
  return {
    marketCode: cfg.marketCode,
    sourceLabel: cfg.sourceLabel,
    kind: "api",
    enabled: cfg.enabled !== false,

    async scrape(): Promise<Signal[]> {
      const f = cfg.fields;
      const ctx = {
        sourceLabel: cfg.sourceLabel,
        countryCode: cfg.countryCode,
        city: cfg.city,
        lat: cfg.lat,
        lng: cfg.lng,
        kind: "api" as const,
        defaultCategory: cfg.defaultCategory ?? "miscellaneous",
      };
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
      const signals: Signal[] = [];

      try {
        for (let offset = 0; offset < MAX_RECORDS; offset += PAGE_SIZE) {
          const params = new URLSearchParams({
            $limit: String(PAGE_SIZE),
            $offset: String(offset),
            $where: `${f.start} >= '${today}'`,
            $order: f.start,
          });
          const rows = await fetchJson<Array<Record<string, any>>>(
            `${cfg.portal}/resource/${cfg.datasetId}.json?${params}`,
            // Un app token sube el límite de throttling, pero es opcional.
            process.env.SOCRATA_APP_TOKEN
              ? { headers: { "X-App-Token": process.env.SOCRATA_APP_TOKEN } }
              : {},
          );
          if (!Array.isArray(rows)) break;

          for (const row of rows) {
            const name = String(row[f.title] ?? "").trim();
            const rawStart = row[f.start];
            if (!name || !rawStart) continue;
            const startDate = String(rawStart).slice(0, 10);
            if (startDate < today || startDate > horizon) continue;

            const geo = readGeo(row, f);
            const ev: ScrapedEvent = {
              name,
              startDate,
              endDate: f.end && row[f.end] ? String(row[f.end]).slice(0, 10) : undefined,
              venue: f.venue && row[f.venue] ? String(row[f.venue]) : undefined,
              url: f.url && row[f.url] ? String(row[f.url]?.url ?? row[f.url]) : undefined,
              category: f.category && row[f.category] ? String(row[f.category]) : undefined,
              ...(geo ? { lat: geo.lat, lng: geo.lng } : {}),
            };
            const signal = scrapedToSignal(ev, ctx);
            if (signal) signals.push(signal);
          }
          if (rows.length < PAGE_SIZE) break;
        }
        return signals;
      } catch (err) {
        console.error(
          `[intelligence] socrata ${cfg.sourceLabel} falló:`,
          (err as Error).message,
        );
        return signals;
      }
    },
  };
}

export const SOCRATA_DATASETS: SocrataDataset[] = [
  {
    sourceLabel: "us-nyc-parks",
    marketCode: "US",
    portal: "https://data.cityofnewyork.us",
    datasetId: "w3wp-dpdi",
    city: "Nueva York",
    countryCode: "US",
    lat: 40.7128,
    lng: -74.006,
    fields: {
      title: "title",
      start: "startdate",
      end: "enddate",
      venue: "parknames",
      url: "link",
      geoPair: "coordinates", // string "lat, lng"
    },
  },
  {
    sourceLabel: "us-sf-our415",
    marketCode: "US",
    portal: "https://data.sfgov.org",
    datasetId: "8i3s-ih2a",
    city: "San Francisco",
    countryCode: "US",
    lat: 37.7749,
    lng: -122.4194,
    fields: {
      title: "event_name",
      start: "event_start_date",
      end: "event_end_date",
      venue: "site_location_name",
      category: "events_category",
      latField: "latitude",
      lngField: "longitude",
    },
  },
  {
    // Agenda cultural de Catalunya. Es la vía correcta para Barcelona: el
    // portal municipal está detrás de un WAF con captcha.
    sourceLabel: "es-catalunya-agenda",
    marketCode: "ES",
    portal: "https://analisi.transparenciacatalunya.cat",
    datasetId: "rhpv-yr4f",
    city: "Barcelona",
    countryCode: "ES",
    lat: 41.3874,
    lng: 2.1686,
    fields: {
      title: "denominaci",
      start: "data_inici",
      end: "data_fi",
      venue: "espai",
      url: "enlla",
      category: "ambit",
      latField: "latitud",
      lngField: "longitud",
    },
  },
  {
    sourceLabel: "us-chicago-library",
    marketCode: "US",
    portal: "https://data.cityofchicago.org",
    datasetId: "vsdy-d8k7",
    city: "Chicago",
    countryCode: "US",
    lat: 41.8781,
    lng: -87.6298,
    fields: {
      title: "title",
      start: "start",
      end: "end",
      venue: "location_name",
      url: "event_page",
      geoPoint: "location",
    },
  },
];

export const socrataPlugins: ScraperPlugin[] = SOCRATA_DATASETS.map(createSocrataPlugin);
