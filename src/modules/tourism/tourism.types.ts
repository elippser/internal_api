/**
 * Tipos del dossier turístico de una propiedad (Roombir IA × hubs de /global).
 *
 * Diseño completo: `roombir-ia-estado-turistico-ingenieria.md` en la raíz del
 * workspace. La idea en una línea: el CÓDIGO lee los hubs y arma los números;
 * el modelo sólo los interpreta. Todo lo que está acá es lo que el código
 * produce — nada de esto lo escribe un LLM.
 *
 * Un dossier guarda una PROYECCIÓN acotada de cada hub (`*Slim`), no el payload
 * entero: tiene que caber cómodo en un documento de Mongo y en un cluster M0.
 */

import type { AlertLevel } from "../hazards/sources";

// ── Facetas y hubs ───────────────────────────────────────────────────────────

/** Lo que el usuario pregunta, en su idioma. */
export const TOURISM_FACETS = ["movimiento", "eventos", "entorno", "estacionalidad"] as const;
export type TourismFacet = (typeof TOURISM_FACETS)[number];

/** De dónde sale el dato. Un sobre por hub en el dossier. */
export const TOURISM_HUBS = ["events", "attention", "calendar", "climate", "place", "hazards"] as const;
export type TourismHub = (typeof TOURISM_HUBS)[number];

/**
 * `hazards` va en todas: una alerta naranja o roja activa es lo único que el
 * hotelero quiere saber aunque no lo haya preguntado, y GDACS es una sola
 * llamada global cacheada.
 */
export const FACET_HUBS: Record<TourismFacet, TourismHub[]> = {
  movimiento: ["events", "attention", "calendar", "hazards"],
  eventos: ["events", "hazards"],
  entorno: ["place", "hazards"],
  estacionalidad: ["calendar", "climate", "hazards"],
};

/** Nombre del hub para el usuario y para el bloque "Sin datos". */
export const HUB_LABEL: Record<TourismHub, string> = {
  events: "eventos",
  attention: "interés online",
  calendar: "calendario y feriados",
  climate: "clima",
  place: "entorno a pie",
  hazards: "alertas de desastres",
};

export function isTourismFacet(v: unknown): v is TourismFacet {
  return typeof v === "string" && (TOURISM_FACETS as readonly string[]).includes(v);
}

export function hubsForFacets(facets: readonly TourismFacet[]): TourismHub[] {
  const out: TourismHub[] = [];
  for (const f of facets) for (const h of FACET_HUBS[f]) if (!out.includes(h)) out.push(h);
  return out;
}

// ── Confianza ────────────────────────────────────────────────────────────────

/**
 *  alta     — API en vivo que respondió.
 *  media    — dato con demora (sobre vencido servido igual) o fuente floja
 *             (scrapers, un artículo de Wikipedia elegido por cercanía).
 *  estimado — tabla curada a mano (mega-eventos, congresos, recesos
 *             escolares aproximados, cuencas de ciclones).
 */
export type Confidence = "alta" | "media" | "estimado";

// ── Sobres ───────────────────────────────────────────────────────────────────

/** Resultado de proyectar un hub: el dato (o null) y qué quedó sin cubrir. */
export interface Projection<T> {
  data: T | null;
  missing: string[];
}

export interface HubEnvelope<T = unknown> {
  data: T | null;
  /** Cuándo se leyó `data`. Si nunca hubo dato, cuándo se intentó. */
  computedAt: string;
  ttlMs: number;
  /** Cuánto tardó la lectura. */
  ms: number;
  missing: string[];
  /** Última falla. Si hay `data`, es la lectura anterior conservada. */
  error?: string;
  failedAt?: string;
}

// ── Propiedad y ubicación ────────────────────────────────────────────────────

/**
 *  property — lat/lng cargadas en la propiedad.
 *  geocoded — dirección ubicada por Nominatim (a nivel calle o barrio).
 *  city     — sólo se pudo ubicar la ciudad: sirve para eventos, calendario,
 *             clima y alertas, NO para el entorno a pie.
 */
export type LocationSource = "property" | "geocoded" | "city";

export interface PropertyHeader {
  propertyId: string;
  name: string;
  type: string;
  typeLabel: string;
  photoUrl: string | null;
  addressShort: string;
  city: string;
  stateProvince: string | null;
  countryCode: string | null;
  timezone: string | null;
}

export interface DossierLocation {
  lat: number;
  lng: number;
  source: LocationSource;
  /** Hash de la dirección con la que se resolvió: si cambia, se rehace. */
  addressHash: string;
  resolvedAt: string;
  geocodedFrom?: string;
}

// ── Proyecciones por hub ─────────────────────────────────────────────────────

export interface EventItem {
  id: string;
  name: string;
  kind: "cultura" | "deporte" | "mice";
  category: string;
  /** anchor = se conoce con antelación y agota la plaza; listing = agenda en vivo. */
  origin: "anchor" | "listing";
  startDate: string;
  endDate: string;
  distanceKm: number;
  /** 0-1. Peso para ordenar, no un dato para mostrar. */
  impact: number;
  confidence: Confidence;
  source: string;
  city: string;
  venue: string | null;
  attendees: number | null;
  nightsHint: number | null;
  dayPattern: string | null;
  url: string | null;
}

export interface EventsSlim {
  radiusKm: number;
  /** Lo que viene primero y lo en curso después; tope EVENT_ITEMS_CAP. */
  items: EventItem[];
  anchors: EventItem[];
  headline: EventItem | null;
  /** Eventos que EMPIEZAN en los próximos 30 / 90 días. */
  next30d: number;
  next90d: number;
  /** El hub recortó su lista antes de esa fecha: el conteo es un piso. */
  floor30: boolean;
  floor90: boolean;
  byKind90d: Record<EventItem["kind"], number>;
  /** Asistentes × noches de los congresos ancla que empiezan en 90 días. */
  delegateNights90d: number;
  /** Hay de dónde leer la agenda con ticket (cola larga del radar). */
  feedAvailable: boolean;
  /** Hay al menos un evento de agenda en vivo en el radio. */
  listingsInRadius: boolean;
}

export interface AttentionSlim {
  article: string;
  place: string | null;
  /** nominatim | geosearch: geosearch puede haber elegido un monumento. */
  resolvedVia: string;
  /** Promedio semanal de la ventana, sumando las 6 ediciones. */
  weeklyViews: number;
  /** Última semana vs. las 4 anteriores (mediana), sobre la serie principal. */
  trendPct: number | null;
  seriesEdition: string | null;
  spikeRatio: number | null;
  spikeSince: string | null;
  topLanguages: Array<{ code: string; label: string; share: number }>;
  series: Array<{ date: string; views: number }>;
}

export interface LongWeekendSlim {
  startDate: string;
  endDate: string;
  dayCount: number;
  needBridgeDay: boolean;
  holidays: string[];
}

export interface SchoolBreakSlim {
  startDate: string;
  endDate: string;
  name: string;
  blockLabel: string | null;
  nationwide: boolean;
  confidence: Confidence;
}

export interface EmitterWindowSlim {
  countryCode: string;
  countryName: string;
  kind: "fin_de_semana_largo" | "receso_escolar";
  startDate: string;
  endDate: string;
  confidence: Confidence;
}

export interface CalendarSlim {
  countryCode: string;
  countryName: string;
  region: string | null;
  longWeekends: LongWeekendSlim[];
  holidays90d: Array<{ date: string; name: string }>;
  observances90d: Array<{ date: string; name: string }>;
  schoolBreaks: SchoolBreakSlim[];
  emitters60d: EmitterWindowSlim[];
}

export interface ClimateSlim {
  profile: "tropical" | "arid" | "temperate" | "polar";
  hemisphere: "north" | "south";
  best: number[];
  warmest: number[];
  coldest: number[];
  wet: number[];
  dry: number[];
  snow: number[];
  hurricane: { basin: string; months: number[] } | null;
  fireRisk: number[];
  normals: Array<{
    month: number;
    tMax: number | null;
    tMin: number | null;
    precipMm: number | null;
    rainDays: number | null;
  }>;
}

export interface PlaceNearby {
  kind: string;
  label: string;
  name: string | null;
  distanceM: number;
  iata?: string | null;
}

export interface PlaceSlim {
  radiusKm: number;
  walkability: {
    score: number;
    label: string;
    components: { amenities: number; pedestrian: number; transit: number };
  };
  noise: { score: number; label: string; sources: string[] };
  gastronomy: number;
  nightlife: number;
  shops: number;
  /** Overpass cortó en su tope: las densidades son un piso. */
  truncated: boolean;
  nearby: PlaceNearby[];
  profile: string;
}

export interface HazardItem {
  scope: "local" | "country";
  type: string;
  typeName: string;
  name: string;
  alertLevel: AlertLevel;
  distanceKm: number;
  ongoing: boolean;
}

export interface HazardsSlim {
  radiusKm: number;
  worstAlert: AlertLevel | null;
  active: HazardItem[];
  airliftRisk: Array<{
    airport: string;
    airportIata: string | null;
    hazard: string;
    alertLevel: AlertLevel;
    hazardDistanceKm: number;
  }>;
  anomalies: Array<{
    kind: "heat" | "cold";
    startDate: string;
    endDate: string;
    peakC: number;
    thresholdC: number;
  }>;
}

export interface DossierHubs {
  events?: HubEnvelope<EventsSlim>;
  attention?: HubEnvelope<AttentionSlim>;
  calendar?: HubEnvelope<CalendarSlim>;
  climate?: HubEnvelope<ClimateSlim>;
  place?: HubEnvelope<PlaceSlim>;
  hazards?: HubEnvelope<HazardsSlim>;
}

/**
 * Párrafos del panel, uno por faceta. Se generan UNA vez por versión del
 * dossier (`stamp` = huella de cuándo se leyó cada hub) y se guardan: abrir el
 * panel no gasta un pedido al modelo cada vez.
 */
export interface StoredNarratives {
  stamp: string;
  model: string;
  level: string;
  createdAt: string;
  byFacet: Partial<Record<TourismFacet, string>>;
}

export interface TourismDossier {
  propertyId: string;
  property: PropertyHeader;
  location: DossierLocation;
  hubs: DossierHubs;
  /** Narrativas guardadas (pueden ser de una versión anterior: comparar `stamp`). */
  narratives?: StoredNarratives | null;
  updatedAt: string;
  meta: {
    ms: number;
    /** Leídos en esta llamada. */
    computed: TourismHub[];
    /** Servidos con el sobre vencido (el recómputo no llegó a tiempo). */
    stale: TourismHub[];
    /** Sin sobre todavía: se está leyendo y escribe cuando termina. */
    pending: TourismHub[];
    skipped: Array<{ hub: TourismHub; reason: string }>;
  };
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

export interface TourismMetric {
  /** Clave estable: el front traduce el label por este id. */
  id: string;
  label: string;
  /** Ya formateado. El front no toca números. */
  value: string;
  trend: "up" | "down" | "neutral";
  confidence: Confidence;
  hint: string | null;
  facet: TourismFacet;
  hub: TourismHub;
  asOf: string;
}

export interface TourismAlert {
  level: "Orange" | "Red";
  text: string;
  asOf: string;
}

export interface TourismCardPayload {
  kind: "tourism_status";
  version: 1;
  propertyId: string;
  title: string;
  facets: TourismFacet[];
  /** Máximo 4, ya priorizadas. Una métrica sin dato no está: nunca vale 0. */
  metrics: TourismMetric[];
  alert: TourismAlert | null;
  /** La peor de las métricas mostradas. */
  confidence: Confidence;
  sources: string[];
  /** El dato más viejo de los mostrados. */
  updatedAt: string;
  location: { lat: number; lng: number; source: LocationSource };
  missing: string[];
  detail: { propertyId: string; facets: TourismFacet[] };
  /**
   * lead  — es LA respuesta (perfil turístico): la síntesis corta va adentro.
   * block — acompaña un análisis, un plan o una tool: va arriba del texto y el
   *         texto sigue debajo. Meter 3.000 caracteres adentro de la tarjeta
   *         dejaba "Ver más" a 1.700 px (medido en el primer turno real).
   */
  layout: "lead" | "block";
}
