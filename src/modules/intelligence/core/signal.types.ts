// Tipos compartidos del intelligence-hub (lh-conectors-spec.md §1).
// Ningún connector escribe a la base: todos devuelven Signal[] normalizados
// y el orquestador (intelligence.service) es el único que persiste.

export type SignalType =
  | "flight_volume"
  | "event"
  | "fx_rate"
  | "holiday"
  | "weather"
  | "search_trend"
  // Vacaciones escolares del mercado emisor (RADAR-DEMAND-DATA-SPEC.md #8).
  | "school_holiday"
  // Inventario de generadores de demanda: estadios, predios, universidades…
  // No es un evento sino el activo que los produce (spec #10).
  | "venue"
  // Tarifa aérea actual por corredor vs histórico propio (spec #15):
  // aviones caros = aviones llenándose = demanda dirigida.
  | "flight_price"
  // Presión de oferta alternativa (Airbnb/STR) agregada por barrio (spec #13).
  | "str_supply"
  // Brote sanitario reportado por WHO: cancelador de demanda país (spec #23).
  | "health_alert"
  // Inventario de alojamiento (spec #32): la OFERTA que compite por la misma
  // noche, del resort a la cabaña. Lado espejo de venue (demanda).
  | "lodging";

export interface SignalScope {
  geo: {
    lat?: number;
    lng?: number;
    airportCode?: string; // IATA, ej. "MDZ"
    countryCode?: string; // ISO 3166-1 alpha-2, ej. "AR"
    city?: string;
  };
  radiusKm?: number;
}

export interface Signal {
  id: string; // uuid v4, generado por el connector
  type: SignalType;
  source: string; // 'aerodatabox' | 'ticketmaster' | 'eventbrite' | 'dolarapi' | 'exchangerate-api' | 'nager-date' | 'open-meteo' | 'pytrends' | 'ih-scraper-<nombre>'
  scope: SignalScope;
  timeWindow: {
    start: string; // ISO 8601
    end: string; // ISO 8601
  };
  magnitude: number; // normalizado 0-1 (criterio por connector)
  confidence: number; // 0-1
  rawPayload: Record<string, unknown>; // respuesta cruda del provider (auditoría/debug)
  ingestedAt: string; // ISO 8601, seteado por la ingesta, no por el connector
  // Clave determinística para upsert: re-correr un cron no debe duplicar
  // señales (ej. el mismo feriado ingerido en el refresh mensual).
  dedupeKey: string;
}

export interface ConnectorFetchResult {
  signals: Signal[];
  // Metadata de la corrida para /health y debugging.
  meta?: Record<string, unknown>;
}

export interface Connector {
  name: string;
  fetch(): Promise<ConnectorFetchResult>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

// Confidence base por fuente (spec §1). Cada connector puede ajustar por
// señal individual si el provider da su propio score.
export const SOURCE_CONFIDENCE: Record<string, number> = {
  aerodatabox: 0.9,
  ticketmaster: 0.85,
  eventbrite: 0.6,
  "exchangerate-api": 0.95,
  dolarapi: 0.95,
  "nager-date": 1.0,
  "open-meteo": 0.75,
  // El spec nombraba pytrends, pero el proyecto fue archivado en 2025 y hoy
  // devuelve 429; el microservicio usa trendspy (sucesor no oficial). Misma
  // confidence: señal indirecta/ruidosa.
  pytrends: 0.5,
  trendspy: 0.5,
  // Fechas oficiales publicadas por ministerios de educación.
  openholidays: 0.95,
  // Fixtures correctos casi siempre, pero horarios/sedes se reprograman.
  thesportsdb: 0.7,
  // OSM: cobertura excelente en ciudades turísticas; capacity a veces falta.
  overpass: 0.8,
  // Agregador de itinerarios publicados por las navieras; HTML estable.
  cruisetimetables: 0.7,
  // Fechas confirmadas por el artista/promotor.
  bandsintown: 0.8,
  // GDS oficial; el precio es real aunque una sola foto diaria.
  amadeus: 0.85,
  // Scrape trimestral independiente; sólido pero con lag de meses.
  insideairbnb: 0.75,
  // Reporte oficial WHO.
  "who-don": 0.95,
};

export const SCRAPER_CONFIDENCE_DEFAULT = 0.4;

// Los connectors no leen ni escriben la base directamente (regla de oro del
// spec §0). Cuando la normalización necesita histórico (rolling 90d de
// flights/FX), el orquestador les inyecta este lector, implementado por
// intelligence.service sobre las señales ya persistidas.
export interface HistoryReader {
  rollingAvgFlightCount(airportCode: string, days: number): Promise<number | null>;
  rollingAvgFxRate(base: string, quote: string, days: number): Promise<number | null>;
  // Promedio de la tarifa más barata observada para un corredor (todas las
  // ventanas de anticipación juntas) — baseline del connector flight-prices.
  rollingAvgFlightPrice(origin: string, destination: string, days: number): Promise<number | null>;
}
