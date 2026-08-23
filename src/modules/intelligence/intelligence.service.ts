// Orquestador del intelligence-hub (spec §8): único punto que persiste.
// Ejecuta connector.fetch(), setea ingestedAt, upsertea por dedupeKey y
// registra cada corrida para /health. Un connector caído nunca frena a los
// demás (Promise.allSettled).

import { ConnectorRunModel, SignalModel, WatchpointModel, sanitizeSignal } from "./intelligence.model";
import { setSweepPoints, type SweepPoint } from "./core/cities.catalog";
import type { Connector, HistoryReader, Signal } from "./core/signal.types";
import { createFxConnector } from "./connectors/fx.connector";
import { createHolidaysConnector } from "./connectors/holidays.connector";
import { createWeatherConnector } from "./connectors/weather.connector";
import { createFlightsConnector } from "./connectors/flights.connector";
import { createEventsConnector } from "./connectors/events/events.connector";
import { createTrendsConnector } from "./connectors/trends.connector";
import { createSchoolHolidaysConnector } from "./connectors/school-holidays.connector";
import { createSportsConnector } from "./connectors/sports.connector";
import { createVenuesConnector } from "./connectors/venues.connector";
import { createLodgingConnector } from "./connectors/lodging.connector";
import { createCruisesConnector } from "./connectors/cruises.connector";
import { createBandsintownConnector } from "./connectors/bandsintown.connector";
import { createFlightPricesConnector } from "./connectors/flight-prices.connector";
import { createStrSupplyConnector } from "./connectors/str-supply.connector";
import { createHealthAlertsConnector } from "./connectors/health-alerts.connector";
import {
  EVENTS_CONFIG,
  FLIGHTS_CONFIG,
  FLIGHT_PRICES_CONFIG,
  FX_CONFIG,
  HOLIDAYS_CONFIG,
  LODGING_CONFIG,
  SCHOOL_HOLIDAYS_CONFIG,
  SPORTS_CONFIG,
  STR_CONFIG,
  TRENDS_CONFIG,
  VENUES_CONFIG,
  WEATHER_DESTINATIONS,
} from "./core/intelligence.config";

// ── Lector histórico inyectado a los connectors (regla de oro: ellos no
//    tocan la base; este service agrega sobre señales ya persistidas). ──

const historyReader: HistoryReader = {
  async rollingAvgFlightCount(airportCode, days) {
    const since = new Date(Date.now() - days * 86_400_000);
    const now = new Date();
    const rows = await SignalModel.aggregate([
      {
        $match: {
          type: "flight_volume",
          "scope.geo.airportCode": airportCode,
          // Solo días ya transcurridos: los días futuros programados no son
          // historia contra la cual normalizar.
          "timeWindow.start": { $gte: since, $lt: now },
          "rawPayload.flightCount": { $gt: 0 },
        },
      },
      { $group: { _id: null, avg: { $avg: "$rawPayload.flightCount" } } },
    ]);
    return rows[0]?.avg ?? null;
  },

  async rollingAvgFxRate(base, quote, days) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await SignalModel.aggregate([
      {
        $match: {
          type: "fx_rate",
          "rawPayload.base": base,
          "rawPayload.quote": quote,
          ingestedAt: { $gte: since },
        },
      },
      { $group: { _id: null, avg: { $avg: "$rawPayload.rate" } } },
    ]);
    return rows[0]?.avg ?? null;
  },

  async rollingAvgFlightPrice(origin, destination, days) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await SignalModel.aggregate([
      {
        $match: {
          type: "flight_price",
          "rawPayload.origin": origin,
          "rawPayload.destination": destination,
          ingestedAt: { $gte: since },
          "rawPayload.priceUsd": { $gt: 0 },
        },
      },
      { $group: { _id: null, avg: { $avg: "$rawPayload.priceUsd" } } },
    ]);
    return rows[0]?.avg ?? null;
  },
};

// ── Registro de connectors ──

function buildConnectors(): Record<string, Connector> {
  const list = [
    createFxConnector(historyReader),
    createHolidaysConnector(),
    createWeatherConnector(),
    createFlightsConnector(historyReader),
    createEventsConnector(),
    createTrendsConnector(),
    createSchoolHolidaysConnector(),
    createSportsConnector(),
    createVenuesConnector(),
    createLodgingConnector(),
    createCruisesConnector(),
    createBandsintownConnector(),
    createFlightPricesConnector(historyReader),
    createStrSupplyConnector(),
    createHealthAlertsConnector(),
  ];
  return Object.fromEntries(list.map((c) => [c.name, c]));
}

const connectors = buildConnectors();

export const CONNECTOR_NAMES = Object.keys(connectors);

export interface IngestSummary {
  connector: string;
  ok: boolean;
  signalCount: number;
  upserted: number;
  durationMs: number;
  error?: string;
  meta?: Record<string, unknown>;
}

// ── Ingesta ──

async function persistSignals(signals: Signal[]): Promise<number> {
  if (signals.length === 0) return 0;
  const ingestedAt = new Date();
  const ops = signals.map((s) => ({
    updateOne: {
      filter: { dedupeKey: s.dedupeKey },
      update: {
        $set: {
          signalId: s.id,
          type: s.type,
          source: s.source,
          scope: s.scope,
          timeWindow: {
            start: new Date(s.timeWindow.start),
            end: new Date(s.timeWindow.end),
          },
          magnitude: s.magnitude,
          confidence: s.confidence,
          rawPayload: s.rawPayload,
          ingestedAt,
        },
        $setOnInsert: { dedupeKey: s.dedupeKey },
      },
      upsert: true,
    },
  }));
  const res = await SignalModel.bulkWrite(ops, { ordered: false });
  return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
}

// ── Puntos de barrido ──

export interface WatchpointInput {
  label: string;
  countryCode: string;
  lat: number;
  lng: number;
  radiusKm?: number;
  source?: string;
}

/** Upsert por pointId. Devuelve si es nuevo (el caller puede disparar un barrido dirigido). */
export async function upsertWatchpoint(pointId: string, input: WatchpointInput) {
  const existing = await WatchpointModel.findOne({ pointId }).lean();
  await WatchpointModel.updateOne(
    { pointId },
    {
      $set: {
        label: input.label,
        countryCode: input.countryCode.toUpperCase(),
        lat: input.lat,
        lng: input.lng,
        radiusKm: input.radiusKm ?? 30,
        source: input.source ?? "rms",
        lastSeenAt: new Date(),
      },
      $setOnInsert: { pointId },
    },
    { upsert: true },
  );
  const moved =
    existing != null &&
    (Math.abs(existing.lat - input.lat) > 0.01 || Math.abs(existing.lng - input.lng) > 0.01);
  return { pointId, created: existing == null, moved };
}

export async function listWatchpoints() {
  return WatchpointModel.find({}).sort({ updatedAt: -1 }).lean();
}

export async function deleteWatchpoint(pointId: string) {
  const r = await WatchpointModel.deleteOne({ pointId });
  return r.deletedCount > 0;
}

/** Carga los puntos (todos o un subconjunto) y los inyecta en el catálogo de barrido. */
async function loadSweepPoints(pointIds?: string[]): Promise<void> {
  const filter = pointIds && pointIds.length > 0 ? { pointId: { $in: pointIds } } : {};
  const docs = await WatchpointModel.find(filter).lean();
  const points: SweepPoint[] = docs.map((d) => ({
    pointId: d.pointId,
    label: d.label,
    countryCode: d.countryCode,
    lat: d.lat,
    lng: d.lng,
    radiusKm: d.radiusKm ?? 30,
    tier: 2,
    isWatchpoint: true,
  }));
  setSweepPoints(points, Boolean(pointIds && pointIds.length > 0));
}

export interface IngestOptions {
  /** Barrido dirigido: solo estos puntos (sin catálogo). Para el alta de una property nueva. */
  pointIds?: string[];
}

// Cola por conector: dos corridas del mismo conector nunca se solapan (varias
// properties registrándose a la vez dispararían barridos concurrentes contra
// TheSportsDB/Ticketmaster y sus rate limits). Se encolan y corren en orden.
const connectorQueue = new Map<string, Promise<unknown>>();

export function ingestConnector(
  name: string,
  trigger: "cron" | "manual" | "startup",
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const connector = connectors[name];
  if (!connector) return Promise.reject(new Error(`Connector desconocido: ${name}`));
  const prev = connectorQueue.get(name) ?? Promise.resolve();
  const run = prev.then(() => runConnector(name, connector, trigger, opts));
  connectorQueue.set(name, run.catch(() => undefined));
  return run;
}

async function runConnector(
  name: string,
  connector: Connector,
  trigger: "cron" | "manual" | "startup",
  opts: IngestOptions,
): Promise<IngestSummary> {
  const startedAt = new Date();
  let summary: IngestSummary;
  try {
    // Los conectores geolocalizados barren catálogo + puntos registrados.
    await loadSweepPoints(opts.pointIds).catch((err) =>
      console.warn("[intelligence] no se pudieron cargar los puntos de barrido:", err),
    );
    const result = await connector.fetch();
    const upserted = await persistSignals(result.signals);
    summary = {
      connector: name,
      ok: true,
      signalCount: result.signals.length,
      upserted,
      durationMs: Date.now() - startedAt.getTime(),
      meta: result.meta,
    };
  } catch (err) {
    summary = {
      connector: name,
      ok: false,
      signalCount: 0,
      upserted: 0,
      durationMs: Date.now() - startedAt.getTime(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await ConnectorRunModel.create({
    connector: name,
    startedAt,
    finishedAt: new Date(),
    ok: summary.ok,
    signalCount: summary.signalCount,
    upserted: summary.upserted,
    error: summary.error,
    meta: summary.meta,
    trigger,
  }).catch((err) => console.error("[intelligence] no se pudo registrar la corrida:", err));

  console.log(`[intelligence] ${name} (${trigger}${opts.pointIds?.length ? ` puntos=${opts.pointIds.join(",")}` : ""}):`, JSON.stringify(summary));
  return summary;
}

export async function ingestAll(
  trigger: "cron" | "manual" | "startup",
  names: string[] = CONNECTOR_NAMES,
): Promise<IngestSummary[]> {
  const results = await Promise.allSettled(names.map((n) => ingestConnector(n, trigger)));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          connector: names[i],
          ok: false,
          signalCount: 0,
          upserted: 0,
          durationMs: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

// ── Queries ──

export interface SignalQuery {
  type?: string;
  source?: string;
  country?: string;
  airport?: string;
  from?: string;
  to?: string;
  // Caja geográfica alrededor de un punto (los tres juntos): la usa el RMS
  // (rms-app) para traer solo los eventos cercanos a una property en vez de
  // paginar el país entero. Es una caja, no un círculo: el caller afina por
  // haversine si necesita el radio exacto.
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit: number;
}

export async function listSignals(q: SignalQuery) {
  const filter: Record<string, unknown> = {};
  if (q.type) filter.type = q.type;
  if (q.source) filter.source = q.source;
  if (q.country) filter["scope.geo.countryCode"] = q.country.toUpperCase();
  if (q.airport) filter["scope.geo.airportCode"] = q.airport.toUpperCase();
  if (q.lat != null && q.lng != null && q.radiusKm != null) {
    const dLat = q.radiusKm / 111;
    const dLng = q.radiusKm / (111 * Math.max(0.2, Math.cos((q.lat * Math.PI) / 180)));
    filter["scope.geo.lat"] = { $gte: q.lat - dLat, $lte: q.lat + dLat };
    filter["scope.geo.lng"] = { $gte: q.lng - dLng, $lte: q.lng + dLng };
  }
  if (q.from || q.to) {
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = new Date(q.from);
    if (q.to) range.$lte = new Date(q.to);
    filter["timeWindow.start"] = range;
  }
  const docs = await SignalModel.find(filter)
    .sort({ "timeWindow.start": 1 })
    .limit(q.limit)
    .lean();
  return docs.map(sanitizeSignal);
}

// Snapshot agregado para el radar: última foto de cada señal, listo para
// pintar capas sin que el front tenga que agregar nada.
// Tope de eventos servidos al mapa por corrida del summary. El clustering de
// MapLibre absorbe este volumen sin problema; el costo real es el tamaño de
// la respuesta HTTP.
const EVENTS_SUMMARY_LIMIT = Number(process.env.IH_EVENTS_SUMMARY_LIMIT ?? 8000);
// El inventario tier-1 completo ronda los miles; mismo criterio que eventos.
const VENUES_SUMMARY_LIMIT = Number(process.env.IH_VENUES_SUMMARY_LIMIT ?? 5000);
// El alojamiento es el dataset más denso del hub (una capital tier-1 sola
// aporta ~1-2k). Tope alto porque el pedido es ver TODO el inventario; el
// clustering de MapLibre lo absorbe y la proyección mantiene liviano el JSON.
const LODGING_SUMMARY_LIMIT = Number(process.env.IH_LODGING_SUMMARY_LIMIT ?? 15000);

export async function getSummary() {
  const now = new Date();
  const in180d = new Date(now.getTime() + 180 * 86_400_000);
  const in90d = new Date(now.getTime() + 90 * 86_400_000);
  const in16d = new Date(now.getTime() + 16 * 86_400_000);
  const back7d = new Date(now.getTime() - 7 * 86_400_000);
  const back12w = new Date(now.getTime() - 12 * 7 * 86_400_000);

  const [fx, holidays, events, weather, flights, trends, schoolHolidays, venues, flightPrices, strSupply, healthAlerts, lodging] = await Promise.all([
    // Última cotización por par.
    SignalModel.aggregate([
      { $match: { type: "fx_rate" } },
      { $sort: { ingestedAt: -1 } },
      {
        $group: {
          _id: { base: "$rawPayload.base", quote: "$rawPayload.quote" },
          doc: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$doc" } },
    ]),
    SignalModel.find({
      type: "holiday",
      "timeWindow.start": { $gte: now, $lte: in90d },
    })
      .sort({ "timeWindow.start": 1 })
      .lean(),
    // Proyección explícita: el catálogo mundial supera las 20k señales de
    // evento y devolver el rawPayload entero haría la respuesta inmanejable
    // para el mapa. Solo lo que la capa dibuja.
    SignalModel.find(
      {
        type: "event",
        "timeWindow.end": { $gte: now },
        "timeWindow.start": { $lte: in90d },
      },
      {
        type: 1, source: 1, scope: 1, timeWindow: 1, magnitude: 1, confidence: 1,
        "rawPayload.name": 1, "rawPayload.venue": 1, "rawPayload.url": 1,
        "rawPayload.segment": 1, "rawPayload.category": 1,
      },
    )
      .sort({ "timeWindow.start": 1 })
      .limit(EVENTS_SUMMARY_LIMIT)
      .lean(),
    SignalModel.find({
      type: "weather",
      "timeWindow.start": { $gte: now, $lte: in16d },
    })
      .sort({ "timeWindow.start": 1 })
      .lean(),
    SignalModel.find({
      type: "flight_volume",
      "timeWindow.start": { $gte: back7d },
    })
      .sort({ "timeWindow.start": 1 })
      .lean(),
    // Última semana disponible por keyword+geo.
    SignalModel.aggregate([
      { $match: { type: "search_trend", ingestedAt: { $gte: back12w } } },
      { $sort: { "timeWindow.start": -1 } },
      {
        $group: {
          _id: { keyword: "$rawPayload.keyword", geo: "$rawPayload.geo" },
          doc: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$doc" } },
    ]),
    // Vacaciones escolares vigentes o por venir (lead largo: 180 días).
    SignalModel.find({
      type: "school_holiday",
      "timeWindow.end": { $gte: now },
      "timeWindow.start": { $lte: in180d },
    })
      .sort({ "timeWindow.start": 1 })
      .lean(),
    // Inventario de generadores de demanda: solo la ventana vigente y los
    // campos que la capa dibuja (mismo criterio de proyección que eventos).
    SignalModel.find(
      { type: "venue", "timeWindow.end": { $gte: now } },
      {
        type: 1, source: 1, scope: 1, timeWindow: 1, magnitude: 1, confidence: 1,
        "rawPayload.name": 1, "rawPayload.category": 1, "rawPayload.capacity": 1,
        "rawPayload.website": 1, "rawPayload.osmUrl": 1,
      },
    )
      .sort({ magnitude: -1 })
      .limit(VENUES_SUMMARY_LIMIT)
      .lean(),
    // Última foto de tarifa por corredor+fecha de salida futura.
    SignalModel.find({
      type: "flight_price",
      "timeWindow.start": { $gte: now },
    })
      .sort({ "timeWindow.start": 1 })
      .lean(),
    // Snapshot STR vigente (los dumps duran un trimestre).
    SignalModel.find({ type: "str_supply", "timeWindow.end": { $gte: now } })
      .sort({ magnitude: -1 })
      .lean(),
    // Alertas sanitarias dentro de su ventana de vigencia.
    SignalModel.find({ type: "health_alert", "timeWindow.end": { $gte: now } })
      .sort({ "timeWindow.start": -1 })
      .limit(100)
      .lean(),
    // Inventario de alojamiento: proyección mínima (el dataset más denso) y
    // orden por magnitud para que un recorte deje los grandes.
    SignalModel.find(
      { type: "lodging", "timeWindow.end": { $gte: now } },
      {
        type: 1, source: 1, scope: 1, timeWindow: 1, magnitude: 1, confidence: 1,
        "rawPayload.name": 1, "rawPayload.category": 1, "rawPayload.sizeClass": 1,
        "rawPayload.rooms": 1, "rawPayload.beds": 1, "rawPayload.units": 1,
        "rawPayload.stars": 1, "rawPayload.brand": 1, "rawPayload.website": 1,
        "rawPayload.osmUrl": 1,
      },
    )
      .sort({ magnitude: -1 })
      .limit(LODGING_SUMMARY_LIMIT)
      .lean(),
  ]);

  return {
    fx: fx.map(sanitizeSignal),
    holidays: holidays.map(sanitizeSignal),
    events: events.map(sanitizeSignal),
    weather: weather.map(sanitizeSignal),
    flights: flights.map(sanitizeSignal),
    trends: trends.map(sanitizeSignal),
    schoolHolidays: schoolHolidays.map(sanitizeSignal),
    venues: venues.map(sanitizeSignal),
    flightPrices: flightPrices.map(sanitizeSignal),
    strSupply: strSupply.map(sanitizeSignal),
    healthAlerts: healthAlerts.map(sanitizeSignal),
    lodging: lodging.map(sanitizeSignal),
    config: {
      corridors: FLIGHTS_CONFIG.corridors,
      watchedAirports: FLIGHTS_CONFIG.watchedAirports,
      fxPairs: FX_CONFIG.pairs,
      holidayCountries: HOLIDAYS_CONFIG.countryCodes,
      weatherDestinations: WEATHER_DESTINATIONS,
      eventRegions: EVENTS_CONFIG.regions,
      trendsKeywords: TRENDS_CONFIG.keywords.length,
      schoolHolidayCountries: SCHOOL_HOLIDAYS_CONFIG.countryCodes,
      sportsLeagues: SPORTS_CONFIG.leagues.map((l) => l.label),
      venueCategories: VENUES_CONFIG.categories.map((c) => c.key),
      flightPriceHorizons: FLIGHT_PRICES_CONFIG.horizonsDays,
      strCities: STR_CONFIG.cities.map((c) => c.label),
      lodgingCategories: LODGING_CONFIG.categories.map((c) => ({ key: c.key, label: c.label })),
    },
    generatedAt: now.toISOString(),
  };
}

export async function getHealth() {
  const entries = await Promise.all(
    CONNECTOR_NAMES.map(async (name) => {
      const [lastRun, check] = await Promise.all([
        ConnectorRunModel.findOne({ connector: name }).sort({ startedAt: -1 }).lean(),
        connectors[name]
          .healthCheck()
          .catch((err) => ({ ok: false, detail: (err as Error).message })),
      ]);
      return [
        name,
        {
          provider: check,
          lastRun: lastRun
            ? {
                startedAt: lastRun.startedAt,
                finishedAt: lastRun.finishedAt,
                ok: lastRun.ok,
                signalCount: lastRun.signalCount,
                upserted: lastRun.upserted,
                trigger: lastRun.trigger,
                error: lastRun.error ?? null,
              }
            : null,
        },
      ] as const;
    }),
  );

  const totalSignals = await SignalModel.estimatedDocumentCount();
  return {
    connectors: Object.fromEntries(entries),
    totalSignals,
    generatedAt: new Date().toISOString(),
  };
}
