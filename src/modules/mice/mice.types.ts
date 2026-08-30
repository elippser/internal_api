// Tipos del hub de eventos de negocios / MICE (event-list.md §5).
//
// Mismo eje que §3 y §4 (dato puntual con radio), pero con campos propios de
// la categoria: el patron semanal y la cantidad de asistentes, que son lo que
// distingue la demanda corporativa de la de ocio.

import type { DayPattern, MiceCategory } from "./congresses";

export type { DayPattern, MiceCategory };

export interface MiceEvent {
  id: string;
  name: string;
  category: MiceCategory | "other";
  /** Rubro del evento, para leer si coincide con el del alojamiento. */
  sector: string;
  origin: "anchor" | "listing";
  startDate: string;
  endDate: string;
  city: string;
  country: string;
  venue: string | null;
  lat: number;
  lng: number;
  distanceKm: number;
  leadDays: number;
  /** Asistentes aproximados; null en la cola larga, que no los publica. */
  attendees: number | null;
  nightsHint: number;
  /** midweek | weekend | full-week — como se reparte la demanda en la semana. */
  dayPattern: DayPattern;
  source: string;
  approximate?: boolean;
  note?: string;
  rawSegment?: string;
  url?: string;
}

export interface MiceCoverage {
  anchors: boolean;
  listings: boolean;
  gaps: string[];
}

export interface MicePointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  window: { from: string; to: string };
  /** Ferias y cumbres ancla: agotan la plaza y se saben con antelacion. */
  anchors: MiceEvent[];
  /** Agenda corporativa local del intelligence-hub. */
  listings: MiceEvent[];
  listingsTotal: number;
  byCategory: Record<string, number>;
  headline: MiceEvent | null;
  /**
   * Noches-delegado estimadas en la ventana: suma de asistentes × noches de
   * los eventos ancla. Es la medida con la que la industria dimensiona
   * cuanta demanda corporativa entra a una plaza.
   */
  delegateNights: number;
  coverage: MiceCoverage;
  sources: string[];
  timestamp: string;
}
