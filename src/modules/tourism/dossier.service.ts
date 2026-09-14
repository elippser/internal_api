/**
 * El dossier turístico de una propiedad: cache-first, un sobre por hub, con
 * presupuesto de tiempo y escritura tardía.
 *
 * Cómo se usa: `getDossier({propertyId, hubs, budgetMs})`. Devuelve lo que
 * haya en el presupuesto — sobres frescos, sobres vencidos marcados como tales,
 * y la lista de lo que todavía se está leyendo — y NUNCA espera más que eso.
 *
 * Reglas que no se negocian:
 *  - Una fuente lenta no bloquea: su lectura sigue en segundo plano y, cuando
 *    termina, se guarda ("escritura tardía"). La próxima pregunta la encuentra.
 *  - Una falla no pisa un dato bueno: se conserva la lectura anterior con
 *    `failedAt`, y no se reintenta durante el backoff.
 *  - El TTL depende del RESULTADO: un sobre sin dato dura 10 minutos, uno con
 *    huecos 6 horas como mucho. Cachear 30 días un vacío pasajero es la trampa
 *    que ya pisaron los hubs (Madrid sin trenes una semana).
 *  - Un solo vuelo en curso por propiedad × hub × punto: dos preguntas
 *    seguidas no disparan dos Overpass.
 */

import type { HubCollector } from "./collectors";
import {
  addressHashOf,
  buildHeader,
  coordsFromAddress,
  geocodeAddress,
  loadPropertyDoc,
  type GeocodeResult,
  type PropertyAddress,
  type PropertyDoc,
} from "./location";
import {
  HUB_LABEL,
  TOURISM_HUBS,
  type DossierHubs,
  type DossierLocation,
  type HubEnvelope,
  type Projection,
  type PropertyHeader,
  type StoredNarratives,
  type TourismDossier,
  type TourismHub,
} from "./tourism.types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Cuánto vale cada sobre. Las normales climáticas y el barrio no cambian en un
 * mes; los puentes decretados aparecen con semanas; la agenda se ingiere a
 * diario; las amenazas activas cambian en horas.
 */
export const HUB_TTL_MS: Record<TourismHub, number> = {
  climate: envMs("TOURISM_TTL_CLIMATE_MS", 30 * DAY),
  place: envMs("TOURISM_TTL_PLACE_MS", 30 * DAY),
  calendar: envMs("TOURISM_TTL_CALENDAR_MS", 7 * DAY),
  events: envMs("TOURISM_TTL_EVENTS_MS", 24 * HOUR),
  attention: envMs("TOURISM_TTL_ATTENTION_MS", 24 * HOUR),
  hazards: envMs("TOURISM_TTL_HAZARDS_MS", 1 * HOUR),
};
export const EMPTY_TTL_MS = 10 * 60 * 1000;
export const PARTIAL_TTL_MAX_MS = 6 * HOUR;
export const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
export const GEOCODE_BACKOFF_MS = DAY;

// ── Store ────────────────────────────────────────────────────────────────────

export interface GeocodeState {
  addressHash: string;
  failedAt: string;
}

export interface StoredDossier {
  propertyId: string;
  property?: PropertyHeader | null;
  location?: DossierLocation | null;
  geocode?: GeocodeState | null;
  hubs?: Partial<Record<TourismHub, HubEnvelope>>;
  narratives?: StoredNarratives | null;
}

export interface DossierStore {
  load(propertyId: string): Promise<StoredDossier | null>;
  saveBase(
    propertyId: string,
    base: { property: PropertyHeader; location: DossierLocation | null; geocode: GeocodeState | null },
  ): Promise<void>;
  saveHub(propertyId: string, hub: TourismHub, env: HubEnvelope): Promise<void>;
  clearHubs(propertyId: string): Promise<void>;
  saveNarratives(propertyId: string, narratives: StoredNarratives): Promise<void>;
}

/** Store en memoria: tests y smoke sin escribir en la base compartida con producción. */
export function createMemoryDossierStore(): DossierStore & {
  docs: Map<string, StoredDossier>;
  writes: () => number;
} {
  const docs = new Map<string, StoredDossier>();
  let writes = 0;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const ensure = (id: string): StoredDossier => {
    let d = docs.get(id);
    if (!d) {
      d = { propertyId: id, hubs: {} };
      docs.set(id, d);
    }
    return d;
  };
  return {
    docs,
    writes: () => writes,
    async load(id) {
      const d = docs.get(id);
      return d ? copy(d) : null;
    },
    async saveBase(id, base) {
      writes++;
      Object.assign(ensure(id), copy(base));
    },
    async saveHub(id, hub, env) {
      writes++;
      const d = ensure(id);
      d.hubs = { ...(d.hubs ?? {}), [hub]: copy(env) };
    },
    async clearHubs(id) {
      writes++;
      const d = ensure(id);
      d.hubs = {};
      d.narratives = null;
    },
    async saveNarratives(id, narratives) {
      writes++;
      ensure(id).narratives = copy(narratives);
    },
  };
}

// ── Dependencias ─────────────────────────────────────────────────────────────

export interface DossierDeps {
  store: DossierStore;
  loadProperty(propertyId: string): Promise<PropertyDoc | null>;
  geocode(address?: PropertyAddress): Promise<GeocodeResult | null>;
  collectors: Record<TourismHub, HubCollector>;
  now(): Date;
}

let defaultDeps: Promise<DossierDeps> | null = null;

/**
 * Las dependencias reales se cargan recién acá: el store de Mongo compila su
 * modelo (y sus índices) y los colectores importan los ocho hubs. Nada de eso
 * tiene que pasar en un test, ni en un smoke que no va a persistir.
 */
export function defaultDossierDeps(): Promise<DossierDeps> {
  if (!defaultDeps) {
    defaultDeps = (async () => {
      const [{ mongoDossierStore }, { createCollectors }] = await Promise.all([
        import("./tourismDossier.model"),
        import("./collectors"),
      ]);
      return {
        store: mongoDossierStore,
        loadProperty: loadPropertyDoc,
        geocode: geocodeAddress,
        collectors: createCollectors(),
        now: () => new Date(),
      };
    })();
  }
  return defaultDeps;
}

// ── Frescura ─────────────────────────────────────────────────────────────────

export function envelopeIsFresh(env: HubEnvelope, now: Date): boolean {
  return now.getTime() - Date.parse(env.computedAt) < env.ttlMs;
}

function inBackoff(env: HubEnvelope, now: Date): boolean {
  return !!env.failedAt && now.getTime() - Date.parse(env.failedAt) < FAILURE_BACKOFF_MS;
}

/**
 * Sin dato se reintenta pronto, salvo el entorno: Overpass tarda MINUTOS en
 * fallar (medido: 130 s en Mendoza) y reintentarlo cada diez minutos sería
 * tener siempre una lectura de dos minutos en vuelo.
 */
const EMPTY_TTL_BY_HUB: Partial<Record<TourismHub, number>> = { place: 60 * 60 * 1000 };

export function ttlForResult(hub: TourismHub, r: Projection<unknown>): number {
  if (r.data === null) return EMPTY_TTL_BY_HUB[hub] ?? EMPTY_TTL_MS;
  if (r.missing.length > 0) return Math.min(HUB_TTL_MS[hub], PARTIAL_TTL_MAX_MS);
  return HUB_TTL_MS[hub];
}

// ── Vuelos en curso ──────────────────────────────────────────────────────────

const flights = new Map<string, Promise<HubEnvelope>>();

function runHub(
  propertyId: string,
  hub: TourismHub,
  loc: DossierLocation,
  previous: HubEnvelope | undefined,
  deps: DossierDeps,
): Promise<HubEnvelope> {
  const key = `${propertyId}:${hub}:${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
  const existing = flights.get(key);
  if (existing) return existing;

  const flight = (async (): Promise<HubEnvelope> => {
    const started = Date.now();
    let env: HubEnvelope;
    try {
      const r = await deps.collectors[hub]({ lat: loc.lat, lng: loc.lng }, deps.now());
      const at = deps.now().toISOString();
      if (r.data === null && previous?.data != null) {
        // La fuente contestó sin dato (típico: una falla que el hub cacheó como
        // vacío). Un dato de ayer vale más que ningún dato de hoy.
        env = {
          ...previous,
          missing: r.missing,
          error: "la fuente respondió sin datos: se conserva la lectura anterior",
          failedAt: at,
        };
      } else {
        env = { data: r.data, computedAt: at, ttlMs: ttlForResult(hub, r), ms: Date.now() - started, missing: r.missing };
      }
    } catch (err) {
      const at = deps.now().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tourism] ${hub} falló para ${propertyId}: ${message}`);
      env =
        previous?.data != null
          ? { ...previous, error: message, failedAt: at }
          : {
              data: null,
              computedAt: at,
              ttlMs: EMPTY_TTL_MS,
              ms: Date.now() - started,
              missing: [HUB_LABEL[hub]],
              error: message,
              failedAt: at,
            };
    }
    await safe("guardar sobre", () => deps.store.saveHub(propertyId, hub, env), undefined);
    return env;
  })().finally(() => flights.delete(key));

  flights.set(key, flight);
  return flight;
}

/** Espera las lecturas en segundo plano (smoke, warm, tests). */
export async function waitForDossierFlights(propertyId?: string): Promise<void> {
  const pending = [...flights.entries()]
    .filter(([key]) => !propertyId || key.startsWith(`${propertyId}:`))
    .map(([, p]) => p);
  await Promise.allSettled(pending);
}

// ── Entrada principal ────────────────────────────────────────────────────────

export interface DossierRequest {
  propertyId: string;
  hubs: readonly TourismHub[];
  /** Cuánto se espera como máximo a las fuentes que hay que leer. */
  budgetMs: number;
  /** Ignora el TTL (sólo scripts y el botón "Actualizar"). */
  fresh?: boolean;
}

export type DossierFailure = "property_not_found" | "property_unavailable" | "no_location";

export type DossierResult =
  | { ok: true; dossier: TourismDossier }
  | { ok: false; reason: DossierFailure; message: string; property?: PropertyHeader };

export async function getDossier(req: DossierRequest, depsIn?: DossierDeps): Promise<DossierResult> {
  const deps = depsIn ?? (await defaultDossierDeps());
  const t0 = Date.now();
  const now = deps.now();
  const nowIso = now.toISOString();
  const { propertyId } = req;

  const stored = await safe("leer dossier", () => deps.store.load(propertyId), null);

  let doc: PropertyDoc | null;
  try {
    doc = await deps.loadProperty(propertyId);
  } catch (err) {
    console.warn("[tourism] no se pudo leer la propiedad:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "property_unavailable", message: "No se pudo leer la propiedad en este momento." };
  }
  if (!doc) {
    return { ok: false, reason: "property_not_found", message: "La propiedad no existe." };
  }

  const property = buildHeader(doc);
  const addressHash = addressHashOf(doc.address);

  // ── Ubicación ──
  let location: DossierLocation | null = null;
  let geocode: GeocodeState | null = stored?.geocode ?? null;
  const direct = coordsFromAddress(doc.address);
  if (direct) {
    const prev = stored?.location;
    location =
      prev && prev.source === "property" && samePoint(prev, direct)
        ? prev
        : { ...direct, source: "property", addressHash, resolvedAt: nowIso };
    geocode = null;
  } else if (stored?.location && stored.location.source !== "property" && stored.location.addressHash === addressHash) {
    location = stored.location;
  } else if (
    geocode &&
    geocode.addressHash === addressHash &&
    now.getTime() - Date.parse(geocode.failedAt) < GEOCODE_BACKOFF_MS
  ) {
    location = null;
  } else {
    const g = await safe("geocodificar", () => deps.geocode(doc.address), null);
    if (g) {
      location = { lat: g.lat, lng: g.lng, source: g.source, addressHash, resolvedAt: nowIso, geocodedFrom: g.from };
      geocode = null;
    } else {
      geocode = { addressHash, failedAt: nowIso };
    }
  }

  // Si la propiedad se movió, los sobres son de otro lugar.
  const moved = !!stored?.location && (!location || !samePoint(stored.location, location));
  const storedHubs: Partial<Record<TourismHub, HubEnvelope>> = moved ? {} : { ...(stored?.hubs ?? {}) };
  if (moved && stored?.hubs && Object.keys(stored.hubs).length > 0) {
    await safe("limpiar sobres", () => deps.store.clearHubs(propertyId), undefined);
  }

  if (baseChanged(stored, property, location, geocode)) {
    await safe("guardar encabezado", () => deps.store.saveBase(propertyId, { property, location, geocode }), undefined);
  }

  if (!location) {
    return {
      ok: false,
      reason: "no_location",
      property,
      message:
        "La propiedad no tiene coordenadas cargadas y su dirección no se pudo ubicar en el mapa.",
    };
  }

  // ── Qué leer ──
  const wanted = [...new Set(req.hubs)].filter((h) => (TOURISM_HUBS as readonly string[]).includes(h));
  const skipped: TourismDossier["meta"]["skipped"] = [];
  const active = wanted.filter((hub) => {
    if (hub === "place" && location!.source === "city") {
      skipped.push({
        hub,
        reason: "la ubicación es aproximada a la ciudad, así que el entorno a pie no se puede medir",
      });
      return false;
    }
    return true;
  });

  const launched = new Map<TourismHub, Promise<HubEnvelope>>();
  for (const hub of active) {
    const env = storedHubs[hub];
    if (env && !req.fresh && (envelopeIsFresh(env, now) || inBackoff(env, now))) continue;
    launched.set(hub, runHub(propertyId, hub, location, env, deps));
  }

  const settled = new Map<TourismHub, HubEnvelope>();
  if (launched.size > 0) {
    const all = Promise.all(
      [...launched].map(([hub, p]) => p.then((e) => void settled.set(hub, e), () => undefined)),
    );
    await Promise.race([all, sleep(req.budgetMs)]);
  }

  // ── Armado ──
  const hubs: Partial<Record<TourismHub, HubEnvelope>> = {};
  const computed: TourismHub[] = [];
  const stale: TourismHub[] = [];
  const pending: TourismHub[] = [];
  for (const hub of active) {
    const fresh = settled.get(hub);
    if (fresh) {
      hubs[hub] = fresh;
      // Si la lectura falló y se conservó la anterior, el sobre que vuelve es
      // viejo: se informa como vencido, no como leído.
      if (envelopeIsFresh(fresh, now)) computed.push(hub);
      else stale.push(hub);
      continue;
    }
    const prev = storedHubs[hub];
    if (prev) {
      hubs[hub] = prev;
      if (!envelopeIsFresh(prev, now)) stale.push(hub);
    } else {
      pending.push(hub);
    }
  }

  return {
    ok: true,
    dossier: {
      propertyId,
      property,
      location,
      hubs: hubs as DossierHubs,
      narratives: moved ? null : (stored?.narratives ?? null),
      updatedAt: nowIso,
      meta: { ms: Date.now() - t0, computed, stale, pending, skipped },
    },
  };
}

// ── Auxiliares ───────────────────────────────────────────────────────────────

function samePoint(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  return a.lat.toFixed(4) === b.lat.toFixed(4) && a.lng.toFixed(4) === b.lng.toFixed(4);
}

function baseChanged(
  stored: StoredDossier | null,
  property: PropertyHeader,
  location: DossierLocation | null,
  geocode: GeocodeState | null,
): boolean {
  if (!stored) return true;
  const loc = (l: DossierLocation | null | undefined) =>
    l ? `${l.lat.toFixed(5)},${l.lng.toFixed(5)},${l.source},${l.addressHash}` : "";
  return (
    JSON.stringify(stored.property ?? null) !== JSON.stringify(property) ||
    loc(stored.location) !== loc(location) ||
    JSON.stringify(stored.geocode ?? null) !== JSON.stringify(geocode)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[tourism] ${label} falló:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}
