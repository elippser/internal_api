// Fábrica de plugins Opendatasoft Explore API v2.1.
//
// Decenas de ciudades y entes de turismo publican su agenda cultural sobre
// la misma plataforma (Opendatasoft), con idéntico contrato REST:
//   GET {portal}/api/explore/v2.1/catalog/datasets/{dataset}/records
// Son APIs oficiales, sin auth, con lat/lng por evento — la mejor relación
// calidad/esfuerzo para llenar el mapa fuera de la cobertura de Ticketmaster.
//
// Verificado (ago-2026): opendata.paris.fr/que-faire-a-paris- → 2821 eventos.

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

export interface OdsDataset {
  sourceLabel: string;
  marketCode: string;
  portal: string; // ej. "https://opendata.paris.fr"
  dataset: string; // ej. "que-faire-a-paris-"
  city: string;
  countryCode: string;
  // Coordenada de respaldo si un registro no trae la suya.
  lat: number;
  lng: number;
  // Nombres de campo del dataset (varían entre portales).
  fields?: {
    title?: string;
    start?: string;
    end?: string;
    geo?: string;
    venue?: string;
    url?: string;
    category?: string;
  };
  enabled?: boolean;
}

const PAGE_SIZE = 100;
const MAX_RECORDS = 1200;

interface OdsResponse {
  total_count: number;
  results: Array<Record<string, any>>;
}

// El campo geo puede venir como {lat,lon}, {latitude,longitude} o [lat,lon].
function readGeo(value: any): { lat: number; lng: number } | null {
  if (!value) return null;
  let lat: number | undefined;
  let lng: number | undefined;
  if (Array.isArray(value) && value.length === 2) {
    [lat, lng] = value.map(Number);
  } else if (typeof value === "object") {
    lat = Number(value.lat ?? value.latitude);
    lng = Number(value.lon ?? value.lng ?? value.longitude);
  }
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  // 0,0 es el marcador de "sin ubicación" en varios de estos datasets
  // (eventos virtuales); dejarlo pasa pondría puntos en el golfo de Guinea.
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function createOdsPlugin(cfg: OdsDataset): ScraperPlugin {
  const f = {
    title: cfg.fields?.title ?? "title",
    start: cfg.fields?.start ?? "date_start",
    end: cfg.fields?.end ?? "date_end",
    geo: cfg.fields?.geo ?? "lat_lon",
    venue: cfg.fields?.venue ?? "address_name",
    url: cfg.fields?.url ?? "url",
    category: cfg.fields?.category ?? null,
  };

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
        kind: "api" as const,
        defaultCategory: "miscellaneous",
      };
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
      const signals: Signal[] = [];

      try {
        for (let offset = 0; offset < MAX_RECORDS; offset += PAGE_SIZE) {
          const params = new URLSearchParams({
            limit: String(PAGE_SIZE),
            offset: String(offset),
            order_by: f.start,
            where: `${f.start} >= date'${today}'`,
          });
          const res = await fetchJson<OdsResponse>(
            `${cfg.portal}/api/explore/v2.1/catalog/datasets/${cfg.dataset}/records?${params}`,
          );
          const rows = res.results ?? [];
          for (const row of rows) {
            const name = String(row[f.title] ?? "").trim();
            const rawStart = row[f.start];
            if (!name || !rawStart) continue;
            const startDate = String(rawStart).slice(0, 10);
            if (startDate < today || startDate > horizon) continue;

            const geo = readGeo(row[f.geo]);
            const ev: ScrapedEvent = {
              name,
              startDate,
              endDate: row[f.end] ? String(row[f.end]).slice(0, 10) : undefined,
              venue: row[f.venue] ? String(row[f.venue]) : undefined,
              url: row[f.url] ? String(row[f.url]) : undefined,
              category: f.category && row[f.category] ? String(row[f.category]) : undefined,
              ...(geo ? { lat: geo.lat, lng: geo.lng } : {}),
            };
            const signal = scrapedToSignal(ev, ctx);
            if (signal) signals.push(signal);
          }
          if (rows.length < PAGE_SIZE || offset + PAGE_SIZE >= (res.total_count ?? 0)) break;
        }
        return signals;
      } catch (err) {
        console.error(
          `[intelligence] ods ${cfg.sourceLabel} falló:`,
          (err as Error).message,
        );
        return signals; // lo ya obtenido sigue siendo válido
      }
    },
  };
}

// Datasets Opendatasoft activos. Ampliar acá suma una ciudad entera al mapa
// sin escribir código nuevo.
export const ODS_DATASETS: OdsDataset[] = [
  {
    sourceLabel: "fr-paris-opendata",
    marketCode: "FR",
    portal: "https://opendata.paris.fr",
    dataset: "que-faire-a-paris-",
    city: "París",
    countryCode: "FR",
    lat: 48.8566,
    lng: 2.3522,
  },
  {
    // Espejo de OpenAgenda publicado por la región Île-de-France: cubre
    // París y periferia sin necesitar la API key de OpenAgenda.
    sourceLabel: "fr-iledefrance-openagenda",
    marketCode: "FR",
    portal: "https://data.iledefrance.fr",
    dataset: "evenements-publics-cibul",
    city: "París",
    countryCode: "FR",
    lat: 48.8566,
    lng: 2.3522,
    fields: {
      title: "title_fr",
      start: "firstdate_begin",
      end: "lastdate_end",
      geo: "location_coordinates",
      venue: "location_name",
      url: "canonicalurl",
    },
  },
];

export const odsPlugins: ScraperPlugin[] = ODS_DATASETS.map(createOdsPlugin);
