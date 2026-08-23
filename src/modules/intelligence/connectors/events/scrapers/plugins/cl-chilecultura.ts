// Plugin Chile Cultura — API JSON oficial del Ministerio de las Culturas.
// Verificado (ago-2026): GET /api/v1.0/eventos/search?page=1 devuelve
// total_count 473, 100 por página, solo eventos vigentes y futuros.
// Sin auth. Nota: la raíz /api/v1.0/ da 403; solo esta ruta es pública.
//
// No trae lat/lng: el evento cae a la comuna conocida o al centro de
// Santiago con dispersión urbana (rawPayload.approxLocation = true).

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

const BASE = "https://chilecultura.gob.cl/api/v1.0/eventos/search";
const MAX_PAGES = 8;

// Centros de las comunas/ciudades más frecuentes, para no apilar todo el
// país en un punto. Lo que no matchea cae a Santiago con dispersión.
const CITY_COORDS: Record<string, { lat: number; lng: number; label: string }> = {
  santiago: { lat: -33.4489, lng: -70.6693, label: "Santiago" },
  valparaíso: { lat: -33.0472, lng: -71.6127, label: "Valparaíso" },
  valparaiso: { lat: -33.0472, lng: -71.6127, label: "Valparaíso" },
  "viña del mar": { lat: -33.0245, lng: -71.5518, label: "Viña del Mar" },
  concepción: { lat: -36.827, lng: -73.0503, label: "Concepción" },
  antofagasta: { lat: -23.6509, lng: -70.3975, label: "Antofagasta" },
  "puerto montt": { lat: -41.4693, lng: -72.9424, label: "Puerto Montt" },
  temuco: { lat: -38.7359, lng: -72.5904, label: "Temuco" },
  "la serena": { lat: -29.9027, lng: -71.252, label: "La Serena" },
  iquique: { lat: -20.2208, lng: -70.1431, label: "Iquique" },
  arica: { lat: -18.4783, lng: -70.3126, label: "Arica" },
  "punta arenas": { lat: -53.1638, lng: -70.9171, label: "Punta Arenas" },
  valdivia: { lat: -39.8142, lng: -73.2459, label: "Valdivia" },
  rancagua: { lat: -34.1701, lng: -70.7406, label: "Rancagua" },
  talca: { lat: -35.4264, lng: -71.6554, label: "Talca" },
};

interface CcEvent {
  id: number;
  name?: string;
  start_date?: string;
  end_date?: string;
  venue_name?: string;
  commune?: string;
  region?: string;
  main_discipline?: string;
  url?: string;
  free?: boolean;
}

interface CcResponse {
  results?: CcEvent[];
  total_count?: number;
  page_count?: number;
}

export const chileCulturaPlugin: ScraperPlugin = {
  marketCode: "CL",
  sourceLabel: "cl-chilecultura",
  kind: "api",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    const today = new Date().toISOString().slice(0, 10);
    const signals: Signal[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetchJson<CcResponse>(`${BASE}?page=${page}`);
        const rows = res.results ?? [];
        for (const ev of rows) {
          if (!ev.name || !ev.start_date) continue;
          const startDate = ev.start_date.slice(0, 10);
          const endDate = ev.end_date ? ev.end_date.slice(0, 10) : undefined;
          if ((endDate ?? startDate) < today) continue;

          const key = (ev.commune ?? "").toLowerCase().trim();
          const place = CITY_COORDS[key] ?? CITY_COORDS.santiago;

          const scraped: ScrapedEvent = {
            name: ev.name,
            startDate,
            endDate,
            venue: ev.venue_name,
            url: ev.url,
            category: ev.main_discipline?.toLowerCase(),
          };
          const signal = scrapedToSignal(scraped, {
            sourceLabel: "cl-chilecultura",
            countryCode: "CL",
            city: place.label,
            lat: place.lat,
            lng: place.lng,
            fallbackSpreadKm: 5,
            kind: "api",
          });
          if (signal) signals.push(signal);
        }
        const pageCount = res.page_count ?? 1;
        if (rows.length === 0 || page >= pageCount) break;
      }
      return signals;
    } catch (err) {
      console.error("[intelligence] chilecultura falló:", (err as Error).message);
      return signals;
    }
  },
};
