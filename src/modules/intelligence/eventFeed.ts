/**
 * Feed de eventos del intelligence-hub para los hubs de /global que filtran
 * por radio (cultura, deportes, MICE) y para el dossier turístico del chat.
 *
 * POR QUÉ EXISTE
 * Los tres hubs leían la cola larga con `fetchIntelligence()` del módulo
 * portado, que hace un HTTP al PROPIO API (`/api/v1/intelligence/summary`)
 * y se trae el summary entero — 8.000 eventos + 5.000 venues + 15.000
 * alojamientos + clima, vuelos, FX — para quedarse sólo con los eventos. Y lo
 * hacía tres veces, porque cada hub tenía su propio store de 30 min. En
 * serverless cada loopback es otra invocación de la función.
 *
 * Todos corren en el mismo proceso que el hub, así que acá se consulta Mongo
 * directo con EXACTAMENTE el filtro, la proyección, el orden y el tope de
 * eventos de `getSummary()`, y se normaliza con la misma forma (`IntelEvent`)
 * para que los hubs no cambien una línea de su lógica.
 *
 * Reglas:
 *  - Un solo store y un solo vuelo en curso para los tres hubs.
 *  - Una falla NO se cachea: el próximo pedido reintenta. Cachear un vacío
 *    por un error pasajero es la trampa repetida de los hubs (ver
 *    GLOBAL-INTELIGENCIA-REFERENCIA.md §6.6).
 *  - Sin conexión a Mongo (los smoke `test:<hub>` corren sin base) se usa el
 *    camino HTTP de siempre si `INTELLIGENCE_API_URL` está configurada.
 *
 * No se toca `global/lib/intelligence.ts`: es un archivo portado que se
 * regenera, y la capa del mapa (`/api/global/intelligence`) sigue usándolo.
 */

import mongoose from "mongoose";
import { SignalModel } from "./intelligence.model";
import {
  fetchIntelligence,
  isConfigured as httpConfigured,
  type IntelEvent,
} from "../global/lib/intelligence";

export type EventFeedSource = "in-process" | "http";

export interface EventFeed {
  events: IntelEvent[];
  source: EventFeedSource;
  generatedAt: string;
}

const MS_DAY = 86_400_000;
const TTL_MS = 30 * 60 * 1000;
/** El mismo tope que `getSummary()` (IH_EVENTS_SUMMARY_LIMIT). */
const EVENTS_LIMIT = Number(process.env.IH_EVENTS_SUMMARY_LIMIT ?? 8000);

let cached: { ts: number; value: EventFeed } | null = null;
let inflight: Promise<EventFeed> | null = null;

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * ¿Hay de dónde leer la cola larga? Reemplaza al `isConfigured()` del módulo
 * portado en los hubs: en proceso alcanza con que la base esté conectada.
 */
export function eventFeedAvailable(): boolean {
  return mongoReady() || httpConfigured();
}

export async function getEventFeed(): Promise<EventFeed> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const value = mongoReady() ? await readInProcess() : await readOverHttp();
    cached = { ts: Date.now(), value };
    return value;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function readInProcess(): Promise<EventFeed> {
  const now = new Date();
  const in90d = new Date(now.getTime() + 90 * MS_DAY);
  const docs = await SignalModel.find(
    {
      type: "event",
      "timeWindow.end": { $gte: now },
      "timeWindow.start": { $lte: in90d },
    },
    {
      _id: 0, source: 1, scope: 1, timeWindow: 1, magnitude: 1, confidence: 1,
      "rawPayload.name": 1, "rawPayload.venue": 1, "rawPayload.url": 1,
      "rawPayload.segment": 1, "rawPayload.category": 1,
    },
  )
    .sort({ "timeWindow.start": 1 })
    .limit(EVENTS_LIMIT)
    .lean();

  return {
    events: docs.map(toIntelEvent).filter((e): e is IntelEvent => e !== null),
    source: "in-process",
    generatedAt: now.toISOString(),
  };
}

async function readOverHttp(): Promise<EventFeed> {
  if (!httpConfigured()) {
    throw new Error("Sin base conectada ni INTELLIGENCE_API_URL: no hay cola larga de eventos");
  }
  const data = await fetchIntelligence();
  return { events: data.events ?? [], source: "http", generatedAt: data.generatedAt };
}

interface RawEventDoc {
  source?: string;
  scope?: { geo?: { lat?: number; lng?: number; city?: string; countryCode?: string } };
  timeWindow?: { start?: Date | string; end?: Date | string };
  magnitude?: number;
  confidence?: number;
  rawPayload?: Record<string, unknown>;
}

const isoOf = (d: Date | string | undefined): string =>
  d instanceof Date ? d.toISOString() : String(d ?? "");

/** Misma normalización que `transformEvents` del módulo portado. */
function toIntelEvent(doc: unknown): IntelEvent | null {
  const s = doc as RawEventDoc;
  const lat = s.scope?.geo?.lat;
  const lng = s.scope?.geo?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const raw = s.rawPayload ?? {};
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    lat,
    lng,
    name: String(raw.name ?? "Unnamed event"),
    venue: str(raw.venue),
    start: isoOf(s.timeWindow?.start),
    end: isoOf(s.timeWindow?.end),
    source: String(s.source ?? ""),
    magnitude: Number(s.magnitude ?? 0),
    confidence: Number(s.confidence ?? 0),
    url: str(raw.url),
    city: s.scope?.geo?.city ?? null,
    country: s.scope?.geo?.countryCode ?? null,
    segment: str(raw.segment ?? raw.category),
  };
}
