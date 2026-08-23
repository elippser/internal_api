// Sub-fuente Ticketmaster Discovery API v2 (spec §3.1).
// Auth: query param `apikey`. Free tier: 5000 calls/día, 5 req/s.
//
// Barrido: el catálogo mundial de ciudades turísticas (cities.catalog.ts),
// no las 5 regiones del corredor piloto — limitarlo al piloto dejaba el mapa
// con 5 coordenadas. Una ciudad sin cobertura del provider devuelve 0 eventos
// y cuesta 1 llamada, así que la cobertura real se descubre empíricamente y
// queda registrada en meta.citiesWithData.
//
// Notas de la API verificadas: `latlong` está deprecado → geoPoint; el venue
// del Discovery API no publica capacity de forma confiable, así que magnitude
// sale de la tabla de pesos por segmento (EVENT_SEGMENT_WEIGHTS).

import { v4 as uuid } from "uuid";
import {
  EVENTS_CONFIG,
  EVENT_SEGMENT_WEIGHTS,
} from "../../core/intelligence.config";
import { sweepCities, type TouristCity } from "../../core/cities.catalog";
import { fetchJson } from "../../core/http";
import { SOURCE_CONFIDENCE, type Signal } from "../../core/signal.types";

const TM_BASE = "https://app.ticketmaster.com/discovery/v2";
const PAGE_SIZE = 100;
// Deep paging tope de la API: size * page < 1000 ⇒ 900 eventos por consulta.
// Las ciudades grandes topaban ahí, así que la ventana se parte en tramos y
// cada tramo tiene su propio techo de 900.
const MAX_PAGES = 9;
const CHUNK_DAYS_TIER1 = 15;
const CHUNK_DAYS_TIER2 = 45;
// 5 req/s es el límite del tier gratuito; 220ms deja margen.
const THROTTLE_MS = 220;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TmEvent {
  id: string;
  name: string;
  url?: string;
  dates?: {
    start?: { dateTime?: string; localDate?: string };
    end?: { dateTime?: string; localDate?: string };
  };
  classifications?: Array<{
    segment?: { name?: string };
    genre?: { name?: string };
  }>;
  _embedded?: {
    venues?: Array<{
      name?: string;
      city?: { name?: string };
      country?: { countryCode?: string };
      location?: { latitude?: string; longitude?: string };
    }>;
  };
}

interface TmResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalElements?: number; totalPages?: number };
}

// Formato exacto exigido: yyyy-MM-ddTHH:mm:ssZ, sin milisegundos.
function tmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isTicketmasterConfigured(): boolean {
  return Boolean(process.env.TICKETMASTER_API_KEY);
}

export async function fetchTicketmasterSignals(): Promise<{
  signals: Signal[];
  errors: string[];
  meta: Record<string, unknown>;
}> {
  const apikey = process.env.TICKETMASTER_API_KEY;
  if (!apikey) {
    return { signals: [], errors: ["TICKETMASTER_API_KEY no configurada"], meta: {} };
  }

  const now = new Date();
  const end = new Date(now.getTime() + EVENTS_CONFIG.windowDays * 86_400_000);
  // Catálogo + puntos de barrido registrados por el RMS (property-driven).
  const cities = sweepCities();
  const signals: Signal[] = [];
  const errors: string[] = [];
  const citiesWithData: Record<string, number> = {};
  let calls = 0;

  // Secuencial con throttle para respetar el límite de 5 req/s.
  for (const city of cities) {
    try {
      const { events, callCount } = await fetchCityEvents(apikey, city, now, end);
      calls += callCount;
      if (events.length > 0) citiesWithData[city.label] = events.length;
      for (const ev of events) signals.push(normalizeTmEvent(ev, city));
    } catch (err) {
      errors.push(`${city.label}: ${(err as Error).message}`);
    }
  }

  return {
    signals,
    errors,
    meta: {
      citiesQueried: cities.length,
      citiesWithData: Object.keys(citiesWithData).length,
      apiCalls: calls,
      topCities: Object.entries(citiesWithData)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([label, n]) => `${label}:${n}`),
    },
  };
}

async function fetchCityEvents(
  apikey: string,
  city: TouristCity,
  from: Date,
  to: Date,
): Promise<{ events: TmEvent[]; callCount: number }> {
  const events: TmEvent[] = [];
  const seen = new Set<string>();
  const chunkDays = city.tier === 1 ? CHUNK_DAYS_TIER1 : CHUNK_DAYS_TIER2;
  let callCount = 0;

  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += chunkDays * 86_400_000) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(Math.min(cursor + chunkDays * 86_400_000, to.getTime()));

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        apikey,
        geoPoint: `${city.lat},${city.lng}`,
        radius: String(city.radiusKm),
        unit: "km",
        startDateTime: tmDateTime(chunkStart),
        endDateTime: tmDateTime(chunkEnd),
        size: String(PAGE_SIZE),
        page: String(page),
        sort: "date,asc",
      });
      await sleep(THROTTLE_MS);
      const res = await fetchJson<TmResponse>(`${TM_BASE}/events.json?${params}`);
      callCount++;
      const batch = res._embedded?.events ?? [];
      // Los tramos comparten borde, así que el mismo evento puede aparecer
      // dos veces; el dedupeKey lo resolvería igual, pero filtrar acá evita
      // inflar los contadores de la corrida.
      for (const ev of batch) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        events.push(ev);
      }
      const totalPages = res.page?.totalPages ?? 1;
      if (batch.length < PAGE_SIZE || page + 1 >= totalPages) break;
    }
  }
  return { events, callCount };
}

function normalizeTmEvent(ev: TmEvent, city: TouristCity): Signal {
  const venue = ev._embedded?.venues?.[0];
  const lat = venue?.location?.latitude ? Number(venue.location.latitude) : city.lat;
  const lng = venue?.location?.longitude ? Number(venue.location.longitude) : city.lng;
  const start =
    ev.dates?.start?.dateTime ??
    (ev.dates?.start?.localDate ? `${ev.dates.start.localDate}T00:00:00Z` : new Date().toISOString());
  const end = ev.dates?.end?.dateTime ?? start;

  const segment = ev.classifications?.[0]?.segment?.name?.toLowerCase() ?? "default";
  const magnitude = EVENT_SEGMENT_WEIGHTS[segment] ?? EVENT_SEGMENT_WEIGHTS.default;

  return {
    id: uuid(),
    type: "event",
    source: "ticketmaster",
    scope: {
      geo: {
        lat,
        lng,
        countryCode: venue?.country?.countryCode ?? city.countryCode,
        city: venue?.city?.name ?? city.label,
      },
      radiusKm: city.radiusKm,
    },
    timeWindow: { start, end },
    magnitude,
    confidence: SOURCE_CONFIDENCE.ticketmaster,
    rawPayload: {
      providerId: ev.id,
      name: ev.name,
      url: ev.url,
      segment: ev.classifications?.[0]?.segment?.name ?? null,
      genre: ev.classifications?.[0]?.genre?.name ?? null,
      venue: venue?.name ?? null,
      market: city.label,
    },
    ingestedAt: "",
    dedupeKey: `event:tm:${ev.id}`,
  };
}
