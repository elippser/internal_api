// Tipos del hub de eventos culturales y de entretenimiento (event-list.md §4).
//
// Mismo eje que el hub de deportes (§3): el dato es puntual con radio, porque
// un festival ocurre en una sede y mueve la ocupacion alrededor.

import type { CultureCategory } from "./festivals";

export type { CultureCategory };

/** De donde salio el evento: ancla curada o cola larga del intelligence-hub. */
export type CultureOrigin = "anchor" | "listing";

export interface CultureEvent {
  id: string;
  name: string;
  category: CultureCategory | "other";
  origin: CultureOrigin;
  startDate: string;
  endDate: string;
  city: string;
  country: string;
  venue: string | null;
  lat: number;
  lng: number;
  distanceKm: number;
  leadDays: number;
  impact: number;
  source: string;
  /** Solo en `listing`: la etiqueta cruda de la fuente, antes de normalizar. */
  rawSegment?: string;
  approximate?: boolean;
  note?: string;
  url?: string;
}

export interface CultureCoverage {
  anchors: boolean;
  listings: boolean;
  lunarFeasts: boolean;
  gaps: string[];
}

export interface CulturePointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  window: { from: string; to: string };
  /** Eventos ancla: los que agotan la plaza y se saben con antelacion. */
  anchors: CultureEvent[];
  /** Cola larga con ticket, ya normalizada y acotada. */
  listings: CultureEvent[];
  byCategory: Record<string, number>;
  headline: CultureEvent | null;
  /** Cuantos eventos de la cola larga habia antes de recortar la lista. */
  listingsTotal: number;
  coverage: CultureCoverage;
  sources: string[];
  timestamp: string;
}
