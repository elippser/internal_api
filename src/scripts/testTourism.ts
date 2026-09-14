/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Batería del estado turístico. SIN base, SIN red, SIN modelo.
 *
 *   npm run test:tourism
 *
 * Fija lo que decide si la tarjeta dice la verdad:
 *
 *   1. formato: fechas, tramos de meses, distancias;
 *   2. proyecciones: que una falla cacheada por un hub (atención en 0, censo
 *      vacío de Overpass) se lea como DESCONOCIDO y no como cero, y que la
 *      confianza de lo curado sea "estimado";
 *   3. tarjeta: prioridad por faceta, tope de 4, omisión sin dato, alerta;
 *   4. bloque del modelo: sección "Sin datos" y tamaño;
 *   5. dossier: cache, TTL por resultado, backoff, vuelo único, escritura
 *      tardía, ubicación geocodificada y a nivel ciudad.
 *
 * Si hay fixtures capturados con `npm run smoke:tourism -- --dump <label>`
 * (src/scripts/fixtures/tourism/<label>/), corre además la cadena completa
 * sobre esos payloads REALES. Un test verde contra un fixture inventado no
 * prueba que las formas de respuesta sean las que se suponen.
 */
import fs from "fs";
import path from "path";
import {
  addDaysIso,
  dateRange,
  distanceText,
  monthSpans,
  signedPct,
  thousands,
} from "../modules/tourism/format";
import { listingConfidence, miceImpact, projectEvents } from "../modules/tourism/facets/events";
import { projectAttention, weeklyTrendPct } from "../modules/tourism/facets/attention";
import { projectCalendar, schoolBreakConfidence } from "../modules/tourism/facets/calendar";
import { projectClimate } from "../modules/tourism/facets/climate";
import { projectPlace } from "../modules/tourism/facets/place";
import { projectHazards } from "../modules/tourism/facets/hazards";
import { buildCard, dossierMissing, facetMetrics } from "../modules/tourism/card";
import { renderTourismBlock } from "../modules/tourism/render";
import { buildPanel } from "../modules/tourism/panel";
import { narrativesStamp, parseNarratives } from "../modules/tourism/narratives";
import {
  EMPTY_TTL_MS,
  PARTIAL_TTL_MAX_MS,
  createMemoryDossierStore,
  getDossier,
  waitForDossierFlights,
  type DossierDeps,
} from "../modules/tourism/dossier.service";
import type { HubCollector } from "../modules/tourism/collectors";
import { mentionedOtherPlace } from "../modules/tourism/otherPlace";
import { prepareTourismContext, tourismSpecialization } from "../modules/tourism/tourismTurn";
import { isTourismQuestion, routeTurn, tourismFacets } from "../modules/conversations/services/taskRouter";
import type { GeocodeResult, PropertyDoc } from "../modules/tourism/location";
import {
  TOURISM_FACETS,
  TOURISM_HUBS,
  type DossierHubs,
  type EventItem,
  type EventsSlim,
  type HubEnvelope,
  type Projection,
  type TourismDossier,
  type TourismHub,
} from "../modules/tourism/tourism.types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ""}`);
  }
}

const NOW = new Date("2026-09-14T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const TODAY = "2026-09-14";
const tokens = (s: string) => Math.round(s.length / 3.6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Constructores de payloads crudos (sólo lo que las proyecciones leen) ────

const cultureEvent = (o: Record<string, unknown>) => ({
  id: "c", name: "Recital", category: "music", origin: "listing", startDate: "2026-09-20",
  endDate: "2026-09-20", city: "Mendoza", country: "AR", venue: null, lat: -32.9, lng: -68.8,
  distanceKm: 4, leadDays: 6, impact: 0.5, source: "ticketmaster", ...o,
});

const culturePayload = (o: Record<string, unknown> = {}) =>
  ({ location: { lat: -32.9, lng: -68.8, radiusKm: 100 }, window: { from: TODAY, to: "2027-09-14" },
     anchors: [], listings: [], byCategory: {}, headline: null, listingsTotal: 0,
     coverage: { anchors: false, listings: false, lunarFeasts: true, gaps: [] }, sources: [], timestamp: NOW_ISO, ...o }) as any;

const sportsPayload = (o: Record<string, unknown> = {}) =>
  ({ location: { lat: -32.9, lng: -68.8, radiusKm: 100 }, window: { from: TODAY, to: "2027-09-14" },
     events: [], byCategory: {}, headline: null,
     coverage: { megaEvents: true, formula1: true, recurring: true, leagueFixtures: false, gaps: [] }, sources: [], timestamp: NOW_ISO, ...o }) as any;

const micePayload = (o: Record<string, unknown> = {}) =>
  ({ location: { lat: -32.9, lng: -68.8, radiusKm: 100 }, window: { from: TODAY, to: "2027-09-14" },
     anchors: [], listings: [], listingsTotal: 0, byCategory: {}, headline: null, delegateNights: 0,
     coverage: { anchors: false, listings: false, gaps: [] }, sources: [], timestamp: NOW_ISO, ...o }) as any;

const miceEvent = (o: Record<string, unknown>) => ({
  id: "m", name: "Congreso", category: "congress", sector: "Salud", origin: "listing",
  startDate: "2026-10-06", endDate: "2026-10-08", city: "Mendoza", country: "AR", venue: null,
  lat: -32.9, lng: -68.8, distanceKm: 9, leadDays: 22, attendees: null, nightsHint: 2,
  dayPattern: "midweek", source: "scraper:ar-la-rural", ...o,
});

// ── Constructores de dossier ─────────────────────────────────────────────────

const env = <T>(data: T | null, extra: Partial<HubEnvelope<T>> = {}): HubEnvelope<T> => ({
  data, computedAt: NOW_ISO, ttlMs: 24 * 3600_000, ms: 5, missing: [], ...extra,
});

const item = (o: Partial<EventItem>): EventItem => ({
  id: "e", name: "Recital X", kind: "cultura", category: "music", origin: "listing",
  startDate: "2026-09-20", endDate: "2026-09-20", distanceKm: 4, impact: 0.5, confidence: "alta",
  source: "ticketmaster", city: "Mendoza", venue: null, attendees: null, nightsHint: null,
  dayPattern: null, url: null, ...o,
});

const eventsSlim = (o: Partial<EventsSlim> = {}): EventsSlim => {
  const vendimia = item({ id: "v", name: "Fiesta de la Vendimia", origin: "anchor", confidence: "estimado", startDate: "2027-03-01", endDate: "2027-03-03", impact: 0.9, distanceKm: 12 });
  return {
    radiusKm: 100,
    items: [item({}), item({ id: "c2", name: "Congreso Y", kind: "mice", startDate: "2026-10-06", endDate: "2026-10-08", dayPattern: "midweek" })],
    anchors: [vendimia],
    headline: vendimia,
    next30d: 6, next90d: 14, floor30: false, floor90: false,
    byKind90d: { cultura: 10, deporte: 1, mice: 3 },
    delegateNights90d: 4200, feedAvailable: true, listingsInRadius: true, ...o,
  };
};

function fullHubs(): DossierHubs {
  return {
    events: env(eventsSlim()),
    attention: env({
      article: "Mendoza", place: "Mendoza", resolvedVia: "nominatim", weeklyViews: 12400, trendPct: 32,
      seriesEdition: "es", spikeRatio: null, spikeSince: null,
      topLanguages: [{ code: "es", label: "Español", share: 0.61 }, { code: "pt", label: "Portugués", share: 0.22 }],
      series: [],
    }),
    calendar: env({
      countryCode: "AR", countryName: "Argentina", region: "Mendoza",
      longWeekends: [{ startDate: "2026-10-10", endDate: "2026-10-13", dayCount: 4, needBridgeDay: false, holidays: ["Día del Respeto a la Diversidad Cultural"] }],
      holidays90d: [{ date: "2026-10-12", name: "Día del Respeto a la Diversidad Cultural" }],
      observances90d: [{ date: "2026-10-18", name: "Día de la Madre" }],
      schoolBreaks: [{ startDate: "2027-07-12", endDate: "2027-07-23", name: "Receso invernal", blockLabel: "Bloque 2", nationwide: false, confidence: "media" }],
      emitters60d: [
        { countryCode: "BR", countryName: "Brasil", kind: "fin_de_semana_largo", startDate: "2026-10-10", endDate: "2026-10-12", confidence: "alta" },
        { countryCode: "CL", countryName: "Chile", kind: "fin_de_semana_largo", startDate: "2026-10-10", endDate: "2026-10-12", confidence: "alta" },
      ],
    }),
    climate: env({
      profile: "arid", hemisphere: "south", best: [3, 4, 10, 11], warmest: [12, 1, 2], coldest: [6, 7, 8],
      wet: [], dry: [5, 6, 7, 8], snow: [], hurricane: null, fireRisk: [],
      normals: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, tMax: 25, tMin: 10, precipMm: 20, rainDays: 3 })),
    }),
    place: env({
      radiusKm: 1, walkability: { score: 72, label: "Mayormente caminable", components: { amenities: 0.8, pedestrian: 0.65, transit: 0.6 } },
      noise: { score: 35, label: "Con ruido de fondo", sources: ["12 locales nocturnos"] },
      gastronomy: 48, nightlife: 12, shops: 90, truncated: false,
      nearby: [{ kind: "transitStop", label: "parada de transporte", name: "Av. San Martín", distanceM: 183 }],
      profile: "Entorno gastronomico, caminable",
    }),
    hazards: env({ radiusKm: 500, worstAlert: null, active: [], airliftRisk: [], anomalies: [] }, { ttlMs: 3600_000 }),
  };
}

function makeDossier(hubs: DossierHubs, meta: Partial<TourismDossier["meta"]> = {}, source: "property" | "geocoded" | "city" = "property"): TourismDossier {
  return {
    propertyId: "p1",
    property: {
      propertyId: "p1", name: "Cabañas Los Álamos", type: "cabin", typeLabel: "cabañas", photoUrl: null,
      addressShort: "Luján de Cuyo, Mendoza · AR", city: "Luján de Cuyo", stateProvince: "Mendoza", countryCode: "AR", timezone: null,
    },
    location: { lat: -33.03, lng: -68.87, source, addressHash: "h", resolvedAt: NOW_ISO },
    hubs,
    updatedAt: NOW_ISO,
    meta: { ms: 1, computed: [], stale: [], pending: [], skipped: [], ...meta },
  };
}

// ── 1. Formato ───────────────────────────────────────────────────────────────

function testFormat() {
  console.log("\n── Formato ──");
  check("rango mismo mes", dateRange("2026-10-10", "2026-10-13") === "10–13 oct", dateRange("2026-10-10", "2026-10-13"));
  check("rango entre meses", dateRange("2026-09-30", "2026-10-02") === "30 sep – 2 oct");
  check("rango de un día", dateRange("2026-10-12", "2026-10-12") === "12 oct");
  check("meses que cruzan el año", monthSpans([12, 1, 2]) === "dic–feb", monthSpans([12, 1, 2]));
  check("dos tramos", monthSpans([3, 4, 10, 11]) === "mar–abr · oct–nov", monthSpans([3, 4, 10, 11]));
  check("sin meses", monthSpans([]) === "");
  check("todo el año", monthSpans([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) === "todo el año");
  check("metros", distanceText(183) === "180 m", distanceText(183));
  check("km con decimal", distanceText(1234) === "1,2 km", distanceText(1234));
  check("km redondos", distanceText(13400) === "13 km");
  check("miles", thousands(12400) === "12.400");
  check("porcentaje negativo con signo menos", signedPct(-12) === "−12%");
  check("sumar días", addDaysIso("2026-09-14", 30) === "2026-10-14");
}

// ── 2. Proyecciones ──────────────────────────────────────────────────────────

function testProjections() {
  console.log("\n── Proyecciones ──");

  // Confianza de la agenda por fuente.
  check("ticketmaster = alta", listingConfidence("ticketmaster") === "alta");
  check("scraper = media", listingConfidence("scraper:ar-la-rural") === "media");
  check("fixture de TheSportsDB = alta", listingConfidence("Intelligence Hub (TheSportsDB)") === "alta");
  check("congreso chico pesa poco", miceImpact(null, 2) === 0.35);
  check("congreso grande pesa más", miceImpact(50_000, 4) > miceImpact(1_000, 2));

  // Eventos: fusión y deduplicación.
  const ev = projectEvents({
    culture: culturePayload({
      anchors: [cultureEvent({ id: "a1", name: "Fiesta de la Vendimia", origin: "anchor", startDate: "2027-03-01", endDate: "2027-03-03", impact: 0.9, source: "Tabla curada" })],
      listings: [
        cultureEvent({ id: "l1", name: "Recital X", startDate: "2026-09-20", endDate: "2026-09-20" }),
        cultureEvent({ id: "l2", name: "Expo Vinos", startDate: "2026-10-06", endDate: "2026-10-08", category: "parade" }),
        cultureEvent({ id: "l3", name: "Muestra permanente", startDate: "2026-08-01", endDate: "2026-11-01" }),
      ],
      listingsTotal: 3,
      coverage: { anchors: true, listings: true, lunarFeasts: true, gaps: [] },
    }),
    sports: sportsPayload({
      events: [{ id: "f1", name: "GP de Argentina", category: "motorsport", sport: "F1", startDate: "2026-11-20", endDate: "2026-11-22", city: "Termas", country: "AR", venue: null, lat: 0, lng: 0, distanceKm: 90, leadDays: 67, impact: 0.85, nightsHint: 4, source: "Jolpica (Ergast F1)", curated: false }],
    }),
    mice: micePayload({
      listings: [miceEvent({ id: "m1", name: "Expo Vinos", startDate: "2026-10-06", endDate: "2026-10-08" })],
      anchors: [miceEvent({ id: "m2", name: "Congreso Andino", origin: "anchor", attendees: 3000, nightsHint: 3, startDate: "2026-11-02", endDate: "2026-11-05", source: "Tabla curada" })],
      listingsTotal: 1,
    }),
    radiusKm: 100,
    now: NOW,
  });
  const e = ev.data as EventsSlim;
  check("eventos: hay dato", !!e);
  check("eventos: la feria duplicada queda una sola vez, como MICE",
    e.items.filter((i) => i.name === "Expo Vinos").length === 1 && e.items.find((i) => i.name === "Expo Vinos")?.kind === "mice",
    e.items.map((i) => `${i.kind}:${i.name}`));
  // Recital (20/9) y Expo Vinos (6/10) empiezan en la ventana; la muestra
  // abierta desde agosto no cuenta aunque siga en curso.
  check("eventos: 30 días cuenta sólo lo que EMPIEZA en la ventana (no la muestra en curso)", e.next30d === 2, e.next30d);
  check("eventos: 90 días", e.next90d === 4, e.next90d);
  check("eventos: el ancla curada es estimado", e.anchors.find((a) => a.name.includes("Vendimia"))?.confidence === "estimado");
  check("eventos: F1 es ancla con confianza alta", e.anchors.find((a) => a.name.includes("GP"))?.confidence === "alta");
  check("eventos: scraper = media", e.items.find((i) => i.name === "Expo Vinos")?.confidence === "media");
  check("eventos: noches-delegado de anclas en 90 días", e.delegateNights90d === 9000, e.delegateNights90d);
  check("eventos: lo que viene va antes que lo en curso", e.items[0].startDate >= TODAY && e.items[e.items.length - 1].name === "Muestra permanente");
  check("eventos: sin recorte no hay piso", !e.floor30 && !e.floor90);

  const floored = projectEvents({
    culture: culturePayload({
      listings: [cultureEvent({ id: "x", startDate: "2026-09-16" }), cultureEvent({ id: "y", name: "Otro", startDate: "2026-09-18" })],
      listingsTotal: 80,
    }),
    sports: null, mice: null, radiusKm: 100, now: NOW,
  });
  check("eventos: el hub recortó antes del día 30 → el conteo es un piso", floored.data?.floor30 === true);
  check("eventos: un hub caído se declara", floored.missing.includes("eventos deportivos"));

  const noFeed = projectEvents({
    culture: culturePayload({ coverage: { anchors: false, listings: false, lunarFeasts: true, gaps: ["Sin cola larga: el intelligence-hub no esta configurado"] } }),
    sports: null, mice: null, radiusKm: 100, now: NOW,
  });
  check("eventos: sin cola larga se declara, no se afirma 0", noFeed.data?.feedAvailable === false && noFeed.missing.some((m) => m.includes("cola larga")));
  check("eventos: los tres hubs caídos = sin dato", projectEvents({ culture: null, sports: null, mice: null, radiusKm: 100, now: NOW }).data === null);

  // Atención: la falla cacheada no es un cero.
  const att = (o: Record<string, unknown>) =>
    ({ location: { lat: 0, lng: 0 }, article: { title: "Mendoza", place: "Mendoza", resolvedVia: "nominatim", url: null },
       window: { days: 180 }, totalViews: 180_000, byLanguage: [{ code: "es", label: "Español", title: "Mendoza", totalViews: 180_000, dailyMean: 1000, share: 1, spike: null }],
       spike: null, series: [], nearby: [], coverage: { article: true, languages: 1, gaps: [] }, sources: [], timestamp: NOW_ISO, ...o }) as any;
  check("atención: sin artículo → desconocido", projectAttention(att({ coverage: { article: false, languages: 0, gaps: [] } })).data === null);
  check("atención: 0 vistas → desconocido (falla cacheada del hub)", projectAttention(att({ totalViews: 0 })).data === null);
  check("atención: vistas por semana", projectAttention(att({})).data?.weeklyViews === 7000, projectAttention(att({})).data?.weeklyViews);
  const series = [...Array.from({ length: 28 }, () => ({ views: 100 })), ...Array.from({ length: 7 }, () => ({ views: 130 }))];
  check("atención: tendencia semanal contra la mediana", weeklyTrendPct(series) === 30, weeklyTrendPct(series));
  check("atención: serie corta → sin tendencia", weeklyTrendPct(series.slice(-20)) === null);

  // Entorno: el censo no confiable no dibuja ceros.
  const placeRaw = (o: Record<string, unknown>) =>
    ({ location: { lat: 0, lng: 0, radiusKm: 1 },
       proximity: { attraction: null, museum: null, park: null, beach: null, water: null, peak: null, university: null, hospital: null, conventionCentre: null, transitStop: { name: "Parada", distanceM: 120 }, busTerminal: null, airport: { name: "Aeropuerto", distanceM: 13000, iata: "MDZ" } },
       density: { gastronomy: 40, nightlife: 5, shops: 60, offices: 2, chains: 1, chainNames: [] },
       walkability: { score: 70, components: { amenities: 0.8, pedestrian: 0.6, transit: 0.5 }, label: "Mayormente caminable" },
       noise: { score: 20, label: "Tranquilo", sources: [] }, view: { elevationM: null, reliefM: null, hints: [] },
       accessibility: { taggedAccessible: 0, taggedTotal: 0, share: null }, profile: "Entorno caminable",
       coverage: { census: true, elevation: true, gaps: [] }, sources: [], timestamp: NOW_ISO, ...o }) as any;
  check("entorno: censo no confiable → desconocido", projectPlace(placeRaw({ coverage: { census: false, elevation: true, gaps: [] } })).data === null);
  check("entorno: recorte de Overpass → piso", projectPlace(placeRaw({ coverage: { census: true, elevation: true, gaps: ["Overpass corto en 900 elementos: las densidades son un piso"] } })).data?.truncated === true);
  check("entorno: el aeropuerto trae IATA", projectPlace(placeRaw({})).data?.nearby.find((n) => n.kind === "airport")?.iata === "MDZ");

  // Calendario: confianza de los recesos y emisores.
  check("receso OpenHolidays = alta", schoolBreakConfidence({ source: "openholidays" }) === "alta");
  check("receso curado verificado = media", schoolBreakConfidence({ source: "curado", precision: "verified" }) === "media");
  check("receso curado aproximado = estimado", schoolBreakConfidence({ source: "curado", precision: "approximate" }) === "estimado");
  const cal = projectCalendar({
    location: { lat: 0, lng: 0, countryCode: "AR", countryName: "Argentina", region: null, displayName: null },
    window: { from: TODAY, to: "2027-09-14" },
    entries: [
      { date: "2026-10-12", endDate: null, name: "Feriado", kind: "public", nationwide: true, weekday: 1, source: "nager" },
      { date: "2026-10-18", endDate: null, name: "Día de la Madre", kind: "observance", nationwide: true, weekday: 0, source: "curado", curated: true },
    ],
    longWeekends: [{ startDate: "2026-10-10", endDate: "2026-10-12", dayCount: 3, needBridgeDay: false, bridgeDays: [], holidays: ["Feriado"] }],
    schoolBreaks: [],
    emitters: [
      { countryCode: "AR", countryName: "Argentina", longWeekends: [{ startDate: "2026-10-10", endDate: "2026-10-12", dayCount: 3, needBridgeDay: false, bridgeDays: [], holidays: [] }], schoolBreaks: [] },
      { countryCode: "BR", countryName: "Brasil", longWeekends: [{ startDate: "2026-10-10", endDate: "2026-10-12", dayCount: 3, needBridgeDay: false, bridgeDays: [], holidays: [] }, { startDate: "2026-12-24", endDate: "2026-12-27", dayCount: 4, needBridgeDay: false, bridgeDays: [], holidays: [] }], schoolBreaks: [] },
    ],
    moveable: { ramadan: null, eidAlFitr: null, eidAlAdha: null, jewish: [], easter: null },
    coverage: { publicHolidays: true, longWeekends: true, schoolHolidays: false, observances: true, paydays: true, gaps: [] },
    sources: [], timestamp: NOW_ISO,
  } as any, NOW);
  check("calendario: el propio país no cuenta como emisor", !cal.data?.emitters60d.some((w) => w.countryCode === "AR"));
  check("calendario: emisores sólo dentro de 60 días", cal.data?.emitters60d.length === 1, cal.data?.emitters60d);
  check("calendario: recesos sin cobertura se declaran", cal.missing.includes("recesos escolares"));

  // Clima y alertas: formas mínimas.
  const clim = projectClimate({
    location: { lat: 0, lng: 0, elevation: null, timezone: null, hemisphere: "south", oceanWithinKm: null },
    normals: [{ month: 9, tMax: 21.6, tMin: 6.4, tMean: 14, precipMm: 10.2, rainDays: 2.4, snowCm: 0, humidityPct: 40, sunshineHours: 8, daylightHours: 12, uvIndex: 6, tRecordHigh: 33, tRecordLow: -4 }],
    seasons: { profile: "arid", amplitudeC: 16, annualPrecipMm: 220, warmest: [12, 1, 2], coldest: [6, 7, 8], wet: [], dry: [6], snow: [], best: [10, 11], monsoonal: false },
    hazards: { hurricane: null, tornado: null, fireRisk: [1] }, special: { foliage: null, bloom: null },
    enso: null, climateShift: null, current: { airQuality: null, pollen: null, snowDepthCm: null, uvIndexMaxToday: null }, sources: [], timestamp: NOW_ISO,
  } as any);
  check("clima: normales redondeadas", clim.data?.normals[0].tMax === 22 && clim.data?.normals[0].rainDays === 2);
  const hz = projectHazards({
    location: { lat: 0, lng: 0, radiusKm: 500 },
    active: [
      { scope: "local", type: "FL", typeName: "Inundación", name: "A", country: "AR", alertLevel: "Green", distanceKm: 10, from: TODAY, to: TODAY, ongoing: true, url: null },
      { scope: "local", type: "FL", typeName: "Inundación", name: "B", country: "AR", alertLevel: "Orange", distanceKm: 120.4, from: TODAY, to: TODAY, ongoing: true, url: null },
    ],
    recent: [], quakes: [], volcanoes: [], anomalies: [], airliftRisk: [],
    headline: { worstAlert: "Orange", activeCount: 2, paths: ["direct"] }, window: { days: 30, from: TODAY, to: TODAY },
    coverage: { gdacs: true, quakes: true, volcanoes: true, temperature: true, gaps: [] }, sources: [], timestamp: NOW_ISO,
  } as any);
  check("alertas: la más grave primero", hz.data?.active[0].alertLevel === "Orange" && hz.data?.active[0].distanceKm === 120);
}

// ── 3. Tarjeta ───────────────────────────────────────────────────────────────

function testCard() {
  console.log("\n── Tarjeta ──");
  const full = makeDossier(fullHubs());

  const mov = buildCard(full, ["movimiento"], NOW);
  check("movimiento: 4 métricas en orden de prioridad",
    mov.metrics.map((m) => m.id).join(",") === "eventos_30d,atencion,proximo_puente,emisores_feriado_60d",
    mov.metrics.map((m) => m.id));
  check("movimiento: título con la ciudad", mov.title === "Movimiento turístico — Luján de Cuyo", mov.title);
  check("movimiento: valores ya formateados",
    mov.metrics.find((m) => m.id === "atencion")?.value === "+32%" &&
    mov.metrics.find((m) => m.id === "proximo_puente")?.value === "10–13 oct" &&
    mov.metrics.find((m) => m.id === "emisores_feriado_60d")?.value === "2 mercados",
    mov.metrics.map((m) => m.value));
  check("movimiento: la atención sube", mov.metrics.find((m) => m.id === "atencion")?.trend === "up");
  check("movimiento: sin alerta si no hay", mov.alert === null);
  check("tarjeta suelta por defecto (no envuelve texto)", mov.layout === "block");
  check("movimiento: nada faltante con todo presente", mov.missing.length === 0, mov.missing);

  const noAttention = buildCard(makeDossier({ ...fullHubs(), attention: env<any>(null, { missing:["interés online (no se encontró el artículo de Wikipedia o no respondió)"] }) }), ["movimiento"], NOW);
  check("sin atención: se omite la celda (no hay un cero)", !noAttention.metrics.some((m) => m.id === "atencion"));
  check("sin atención: la reemplaza la siguiente de la faceta", noAttention.metrics.some((m) => m.id === "eventos_90d"), noAttention.metrics.map((m) => m.id));
  check("sin atención: se declara faltante", noAttention.missing.some((m) => m.startsWith("interés online")), noAttention.missing);

  const noPlace = buildCard(makeDossier({ ...fullHubs(), place: undefined }, { pending: ["place"] }), ["entorno"], NOW);
  check("entorno pendiente: cero métricas, nada inventado", noPlace.metrics.length === 0);
  check("entorno pendiente: se dice que se está leyendo", noPlace.missing.some((m) => m.includes("todavía se está leyendo")), noPlace.missing);

  const cityLevel = buildCard(makeDossier({ ...fullHubs(), place: undefined }, { skipped: [{ hub: "place", reason: "la ubicación es aproximada a la ciudad" }] }, "city"), ["entorno"], NOW);
  check("ubicación de ciudad: el motivo llega a la tarjeta", cityLevel.missing.some((m) => m.includes("aproximada a la ciudad")));

  const two = buildCard(full, ["eventos", "estacionalidad"], NOW);
  check("dos facetas: 2 + 2", two.metrics.filter((m) => m.facet === "eventos").length === 2 && two.metrics.filter((m) => m.facet === "estacionalidad").length === 2, two.metrics.map((m) => `${m.facet}:${m.id}`));
  check("dos facetas: el título es de la primera", two.title === "Eventos cerca de tu propiedad");

  const ev = buildCard(full, ["eventos"], NOW);
  check("eventos: ancla con confianza estimado", ev.metrics.find((m) => m.id === "ancla")?.confidence === "estimado");
  check("eventos: la tarjeta toma la peor confianza", ev.confidence === "estimado", ev.confidence);
  check("eventos: noches-delegado en la pista de congresos", ev.metrics.find((m) => m.id === "congresos_90d")?.hint === "≈ 4.200 noches-delegado");

  const staleHubs = fullHubs();
  staleHubs.calendar = { ...(staleHubs.calendar as HubEnvelope<any>), computedAt: "2026-09-01T00:00:00.000Z", ttlMs: 7 * 24 * 3600_000 };
  const stale = buildCard(makeDossier(staleHubs), ["estacionalidad"], NOW);
  check("sobre vencido: la métrica baja a media", stale.metrics.find((m) => m.id === "proximo_puente")?.confidence === "media");
  check("sobre vencido: 'actualizado' es el dato más viejo", stale.updatedAt === "2026-09-01T00:00:00.000Z", stale.updatedAt);

  const zero = buildCard(makeDossier({ ...fullHubs(), events: env(eventsSlim({ next30d: 0, next90d: 0, listingsInRadius: false, items: [], byKind90d: { cultura: 0, deporte: 0, mice: 0 } })) }), ["eventos"], NOW);
  check("cero eventos sin agenda en el radio: no se muestra '0'", !zero.metrics.some((m) => m.id === "eventos_30d" || m.id === "eventos_90d"), zero.metrics.map((m) => m.id));

  const alertHubs = fullHubs();
  alertHubs.hazards = env({ radiusKm: 500, worstAlert: "Orange", active: [{ scope: "local", type: "FL", typeName: "Inundación", name: "X", alertLevel: "Orange", distanceKm: 120, ongoing: true }], airliftRisk: [], anomalies: [] });
  const withAlert = buildCard(makeDossier(alertHubs), ["entorno"], NOW);
  check("alerta naranja activa aparece aunque no se haya preguntado", withAlert.alert?.level === "Orange" && withAlert.alert.text === "Inundación con alerta naranja a 120 km", withAlert.alert);
  check("alerta: GDACS entra en las fuentes", withAlert.sources.includes("GDACS"));

  check("panel: todas las métricas de una faceta", facetMetrics(full, "estacionalidad", NOW).length === 5);
  check("faltantes: vacío con todo presente", dossierMissing(full, TOURISM_FACETS).length === 0);
}

// ── 4. Bloque del modelo ─────────────────────────────────────────────────────

function testRender() {
  console.log("\n── Bloque del modelo ──");
  const full = makeDossier(fullHubs());
  const all = renderTourismBlock(full, TOURISM_FACETS, { now: NOW, level: "avanzado" });
  check("render: sin 'undefined' ni 'NaN'", !/undefined|NaN/.test(all));
  check("render: cuatro facetas en ≤ 900 tokens", tokens(all) <= 900, tokens(all));
  check("render: lo curado va marcado", all.includes("[estimado]"));
  check("render: avanzado no lleva glosario", !all.includes("Glosario"));
  check("render: básico sí lleva glosario", renderTourismBlock(full, ["movimiento"], { now: NOW, level: "basico" }).includes("Glosario"));

  const partial = renderTourismBlock(makeDossier({ ...fullHubs(), place: undefined }, { pending: ["place"] }), ["entorno"], { now: NOW });
  check("render: lo faltante va en 'Sin datos'", partial.includes("Sin datos: entorno a pie (todavía se está leyendo)"), partial);
  check("render: sin dato de entorno no hay línea de entorno", !partial.includes("Entorno a pie ("));

  const noListings = renderTourismBlock(makeDossier({ ...fullHubs(), events: env(eventsSlim({ listingsInRadius: false })) }), ["eventos"], { now: NOW });
  check("render: cero relevado ≠ no hay eventos", noListings.includes('NO digas "no hay eventos"'));
}

// ── 4b. Panel y narrativas ───────────────────────────────────────────────────

function testPanel() {
  console.log("\n── Panel ──");
  const d = makeDossier(fullHubs());
  const panel = buildPanel(d, { eventos: "Párrafo de eventos." }, NOW);
  check("panel: 4 secciones en orden", panel.sections.map((s) => s.facet).join() === "eventos,movimiento,entorno,estacionalidad");
  const [ev, mov, ent, est] = panel.sections;
  check("panel: narrativa de la sección", ev.narrative === "Párrafo de eventos." && mov.narrative === null);
  check("panel: eventos con fecha y distancia", ev.items.length === 2 && ev.items[0].detail.includes("a 4 km"), ev.items);
  check(
    "panel: idiomas y mercados emisores",
    mov.items.some((i) => i.title === "Lectores en Español") && mov.items.some((i) => i.title === "Brasil"),
    mov.items.map((i) => i.title),
  );
  check("panel: componentes de la caminabilidad a la vista", ent.items.some((i) => i.title === "Comercios y servicios a pie" && i.detail.startsWith("80/100")));
  check("panel: clima de los próximos tres meses", est.items.filter((i) => i.title.startsWith("Clima en")).length === 3);
  check("panel: fuentes por sección", ent.sources.join() === "OpenStreetMap", ent.sources);
  check("panel: sin narrativas se informa", buildPanel(d, null, NOW).narrativesReady === false);
  const noPlace = buildPanel(makeDossier({ ...fullHubs(), place: undefined }, { pending: ["place"] }), null, NOW);
  check("panel: sección sin datos declara el faltante", noPlace.sections[2].metrics.length === 0 && noPlace.sections[2].missing.length > 0);
  check("panel: lo pendiente viaja al front", noPlace.pending.join() === "place");

  check("narrativas: JSON con texto alrededor", parseNarratives('Acá va:\n{"eventos": "Uno.", "entorno": null, "otro": "x"}\n').eventos === "Uno.");
  check("narrativas: null no entra", !("entorno" in parseNarratives('{"eventos":"a","entorno":null}')));
  check("narrativas: sin JSON = vacío", Object.keys(parseNarratives("sin json")).length === 0);
  const stamp = narrativesStamp(d);
  const reread = fullHubs();
  reread.climate = { ...(reread.climate as HubEnvelope<any>), computedAt: "2026-09-15T00:00:00.000Z" };
  check("narrativas: la huella cambia si se relee un hub", narrativesStamp(makeDossier(reread)) !== stamp);
  check("narrativas: la huella es estable", narrativesStamp(makeDossier(fullHubs())) === stamp);
}

// ── 5. Dossier ───────────────────────────────────────────────────────────────

let propertySeq = 0;

function harness(docOverride?: Partial<PropertyDoc>) {
  const propertyId = `prop-${++propertySeq}`;
  let clock = NOW.getTime();
  const calls: Partial<Record<TourismHub, number>> = {};
  const behavior: Partial<Record<TourismHub, (n: number) => Promise<Projection<unknown>>>> = {};
  let doc: PropertyDoc | null = {
    propertyId, name: "Cabañas", type: "cabin",
    address: { city: "Mendoza", countryCode: "AR", lat: -32.89, lng: -68.84 },
    ...docOverride,
  };
  let geocodeResult: GeocodeResult | null = null;
  let geocodeCalls = 0;
  const store = createMemoryDossierStore();
  // Por defecto cada hub devuelve una proyección realista, así la tarjeta y el
  // bloque se pueden armar sobre el dossier que sale del servicio.
  const realistic = fullHubs();
  const collectors = Object.fromEntries(
    TOURISM_HUBS.map((hub) => [
      hub,
      (async () => {
        calls[hub] = (calls[hub] ?? 0) + 1;
        const b = behavior[hub];
        return b
          ? b(calls[hub] as number)
          : { data: (realistic[hub] as HubEnvelope | undefined)?.data ?? { hub }, missing: [] };
      }) as HubCollector,
    ]),
  ) as Record<TourismHub, HubCollector>;
  const deps: DossierDeps = {
    store,
    loadProperty: async () => doc,
    geocode: async () => { geocodeCalls++; return geocodeResult; },
    collectors,
    now: () => new Date(clock),
  };
  return {
    propertyId, deps, store, calls, behavior,
    advance: (ms: number) => { clock += ms; },
    setDoc: (d: PropertyDoc | null) => { doc = d; },
    setGeocode: (g: GeocodeResult | null) => { geocodeResult = g; },
    geocodeCalls: () => geocodeCalls,
    get: (hubs: readonly TourismHub[] = TOURISM_HUBS, budgetMs = 200) => getDossier({ propertyId, hubs, budgetMs }, deps),
  };
}

async function testDossier() {
  console.log("\n── Dossier ──");
  const H = 3600_000;

  // Cache y TTL.
  {
    const h = harness();
    const r1 = await h.get();
    check("dossier: primera vez lee los 6 hubs", r1.ok && r1.dossier.meta.computed.length === 6, r1.ok ? r1.dossier.meta : r1);
    const r2 = await h.get();
    check("dossier: segunda vez sale de cache", r2.ok && r2.dossier.meta.computed.length === 0 && h.calls.climate === 1);
    h.advance(2 * H);
    const r3 = await h.get();
    check("dossier: vencida sólo la de 1 h (alertas) se relee", r3.ok && r3.dossier.meta.computed.join() === "hazards", r3.ok ? r3.dossier.meta.computed : r3);
  }

  // TTL por resultado.
  {
    const h = harness();
    h.behavior.climate = async () => ({ data: { ok: 1 }, missing: ["algo"] });
    h.behavior.attention = async () => ({ data: null, missing: ["interés online"] });
    await h.get();
    const doc = h.store.docs.get(h.propertyId);
    check("ttl: con huecos dura como mucho 6 h", doc?.hubs?.climate?.ttlMs === PARTIAL_TTL_MAX_MS);
    check("ttl: sin dato dura 10 min", doc?.hubs?.attention?.ttlMs === EMPTY_TTL_MS);
  }

  // Presupuesto y escritura tardía.
  {
    const h = harness();
    h.behavior.place = async () => { await sleep(120); return { data: { slow: true }, missing: [] }; };
    const r = await h.get(TOURISM_HUBS, 20);
    check("presupuesto: lo lento queda pendiente, no bloquea", r.ok && r.dossier.meta.pending.join() === "place", r.ok ? r.dossier.meta : r);
    check("presupuesto: el resto sí llegó", r.ok && r.dossier.meta.computed.length === 5);
    await waitForDossierFlights(h.propertyId);
    check("escritura tardía: el sobre lento quedó guardado", !!h.store.docs.get(h.propertyId)?.hubs?.place?.data);
    const again = await h.get(["place"]);
    check("escritura tardía: la pregunta siguiente lo encuentra", again.ok && !!again.dossier.hubs.place?.data && h.calls.place === 1);
  }

  // Falla con dato previo: se conserva y hay backoff.
  {
    const h = harness();
    await h.get(["events"]);
    h.advance(25 * H);
    h.behavior.events = async () => { throw new Error("feed caído"); };
    const r = await h.get(["events"]);
    const e = r.ok ? r.dossier.hubs.events : undefined;
    check("falla: se conserva la lectura anterior", !!e?.data && !!e.failedAt && e.error === "feed caído", e);
    check("falla: se marca como vencido", r.ok && r.dossier.meta.stale.includes("events"));
    h.advance(60_000);
    await h.get(["events"]);
    check("falla: no se reintenta durante el backoff", h.calls.events === 2, h.calls.events);
    h.advance(11 * 60_000);
    await h.get(["events"]);
    check("falla: después del backoff se reintenta", h.calls.events === 3, h.calls.events);
  }

  // Falla sin dato previo.
  {
    const h = harness();
    h.behavior.calendar = async () => { throw new Error("océano"); };
    const r = await h.get(["calendar"]);
    const c = r.ok ? r.dossier.hubs.calendar : undefined;
    check("falla sin previo: sobre sin dato, corto y con motivo", c?.data === null && c.ttlMs === EMPTY_TTL_MS && c.missing[0] === "calendario y feriados", c);
  }

  // Respuesta vacía con dato previo.
  {
    const h = harness();
    await h.get(["attention"]);
    h.advance(25 * H);
    h.behavior.attention = async () => ({ data: null, missing: ["interés online"] });
    const r = await h.get(["attention"]);
    check("vacío con previo: un dato de ayer vale más que ninguno", r.ok && !!r.dossier.hubs.attention?.data);
  }

  // Vuelo único.
  {
    const h = harness();
    h.behavior.place = async () => { await sleep(60); return { data: { ok: true }, missing: [] }; };
    await Promise.all([h.get(["place"], 200), h.get(["place"], 200)]);
    check("vuelo único: dos preguntas simultáneas, un solo Overpass", h.calls.place === 1, h.calls.place);
  }

  // La propiedad se movió.
  {
    const h = harness();
    await h.get();
    h.setDoc({ propertyId: h.propertyId, name: "Cabañas", type: "cabin", address: { city: "Mendoza", countryCode: "AR", lat: -34.6, lng: -58.4 } });
    const r = await h.get();
    check("mudanza: se descartan los sobres del lugar viejo", r.ok && r.dossier.meta.computed.length === 6 && h.calls.climate === 2);
  }

  // Sin coordenadas: geocodificación a nivel ciudad.
  {
    const h = harness({ address: { city: "Mendoza", countryCode: "AR" } });
    h.setGeocode({ lat: -32.89, lng: -68.83, source: "city", from: "Mendoza, Argentina" });
    const r = await h.get();
    check("geocodificación: ubica por la ciudad", r.ok && r.dossier.location.source === "city" && h.geocodeCalls() === 1);
    check("geocodificación de ciudad: el entorno a pie se omite con motivo", r.ok && r.dossier.meta.skipped[0]?.hub === "place" && !h.calls.place);
    await h.get();
    check("geocodificación: no se repite si la dirección no cambió", h.geocodeCalls() === 1, h.geocodeCalls());
  }

  // Sin coordenadas ni dirección ubicable.
  {
    const h = harness({ address: { city: "Pueblo inventado" } });
    const r = await h.get();
    check("sin ubicación: no hay dossier, con motivo", !r.ok && r.reason === "no_location");
    await h.get();
    check("sin ubicación: no se re-geocodifica en cada pregunta", h.geocodeCalls() === 1, h.geocodeCalls());
    h.advance(25 * H);
    await h.get();
    check("sin ubicación: se reintenta al día siguiente", h.geocodeCalls() === 2, h.geocodeCalls());
  }

  // Propiedad inexistente.
  {
    const h = harness();
    h.setDoc(null);
    const r = await h.get();
    check("propiedad inexistente", !r.ok && r.reason === "property_not_found");
  }
}

// ── 6. Router, otro lugar y armado del turno ────────────────────────────────

async function testTurn() {
  console.log("\n── Router turístico ──");
  const prev = process.env.ROUTER_LLM_CLASSIFIER;
  process.env.ROUTER_LLM_CLASSIFIER = "false";

  const turisticas: Array<[string, string, string[]]> = [
    ["¿Cómo viene el movimiento en mi provincia?", "consulta", ["movimiento"]],
    ["¿Va a haber mucho turismo este mes?", "consulta", ["movimiento"]],
    ["¿Hay algo grande pasando cerca este fin de semana?", "consulta", ["eventos"]],
    ["¿Qué tan bien ubicado estoy?", "consulta", ["entorno"]],
    ["¿Se viene una temporada fuerte?", "consulta", ["estacionalidad"]],
    ["¿Hay eventos cerca este mes?", "consulta", ["eventos"]],
    ["¿Cuándo es el próximo fin de semana largo?", "consulta", ["estacionalidad"]],
    ["Analizá cómo me afecta el fin de semana largo en la ocupación", "analista", ["estacionalidad"]],
    ["¿Hay feriado el 12/10? Bloqueá la venta de ese día", "operativo", ["estacionalidad"]],
    // Primer pedido real (14-09-2026): caía en DEEP por "tendenci" sin dossier,
    // y el modelo contestó tendencias inventadas.
    ["Cuales son las tendencias en mi ciudad para avivar las reservas?", "analista", ["movimiento"]],
  ];
  for (const [msg, subAgent, facets] of turisticas) {
    const r = await routeTurn({ userMessage: msg, enabledToolIds: [] });
    check(
      `turística: "${msg}"`,
      r.subAgent.id === subAgent && JSON.stringify(r.tourism?.facets) === JSON.stringify(facets),
      { subAgent: r.subAgent.id, tourism: r.tourism, reason: r.reason },
    );
  }

  const noTuristicas = [
    "Buscá en google qué eventos hay en Mendoza",
    "Cambiá la tarifa del 24/12",
    "Cargá la tarifa de temporada alta",
    "Aprobá los eventos sugeridos del RMS",
    "hola",
    "cuántas reservas tengo hoy",
  ];
  for (const msg of noTuristicas) {
    const r = await routeTurn({ userMessage: msg, enabledToolIds: [] });
    check(`NO turística: "${msg}"`, r.tourism === null, r.reason);
  }
  const web = await routeTurn({ userMessage: "Buscá en google qué eventos hay en Mendoza", enabledToolIds: [] });
  check("pedido web explícito sigue yendo a operativo (con web)", web.subAgent.id === "operativo" && web.subAgent.webSearch);

  const strategic = await routeTurn({
    userMessage: "Quiero aumentar mis reservas aprovechando los fines de semana largos",
    enabledToolIds: [],
  });
  check("estratégico + turístico: gana el estratégico y conserva las facetas",
    strategic.strategicRequest && strategic.tourism?.facets.includes("estacionalidad") === true, strategic.reason);
  check("facetas: sin pista específica = movimiento", tourismFacets("¿cómo viene la cosa?").join() === "movimiento");
  check("facetas: como mucho dos", tourismFacets("eventos, clima y qué tan bien ubicado estoy").length === 2);
  check("temporada con precios no es turística", !isTourismQuestion("subí el precio de la temporada alta"));

  if (prev === undefined) delete process.env.ROUTER_LLM_CLASSIFIER;
  else process.env.ROUTER_LLM_CLASSIFIER = prev;

  console.log("\n── Otro lugar ──");
  const mendoza = { city: "Mendoza", stateProvince: "Mendoza", countryCode: "AR", name: "Cabañas Los Álamos" };
  check("otra ciudad se detecta", mentionedOtherPlace("¿Cómo viene el movimiento en Salta?", mendoza) === "Salta");
  check("dos palabras", mentionedOtherPlace("¿Hay movimiento en Buenos Aires?", mendoza) === "Buenos Aires");
  check("la propia ciudad no", mentionedOtherPlace("¿Cómo viene el movimiento en Mendoza?", mendoza) === null);
  check("el propio país no", mentionedOtherPlace("¿Cómo viene el turismo en Argentina?", mendoza) === null);
  check("una fecha no es un lugar", mentionedOtherPlace("¿Hay eventos en Semana Santa?", mendoza) === null);
  check("una efeméride no es un lugar", mentionedOtherPlace("¿Qué pasa para el Día del Padre?", mendoza) === null);
  check("un evento no es un lugar", mentionedOtherPlace("¿Qué movimiento trae la Fiesta de la Vendimia?", mendoza) === null);
  check("minúsculas: no se adivina", mentionedOtherPlace("eventos en salta", mendoza) === null);
  check("ciudad compuesta propia", mentionedOtherPlace("¿Hay algo en Luján de Cuyo?", { ...mendoza, city: "Luján de Cuyo" }) === null);

  console.log("\n── Armado del turno ──");
  {
    const h = harness();
    const other = await prepareTourismContext({
      propertyId: h.propertyId, facets: ["movimiento"], mode: "profile",
      message: "¿Cómo viene el movimiento en Salta?", level: "basico", budgetMs: 200, deps: h.deps,
    });
    check("otro lugar: sin tarjeta y sin leer los hubs", other.card === null && other.meta.otherPlace === "Salta" && !h.calls.events);
    const spec = tourismSpecialization(other, "basico");
    check("otro lugar: la especialización pide aclarar", spec.includes('"Salta"') && spec.includes("no tenés datos verificados"));

    const ok = await prepareTourismContext({
      propertyId: h.propertyId, facets: ["movimiento"], mode: "profile",
      message: "¿Cómo viene el movimiento en mi zona?", level: "basico", budgetMs: 200, deps: h.deps,
    });
    check("turno: tarjeta con métricas", !!ok.card && ok.card.metrics.length > 0, ok.meta);
    check("turno: bloque para el modelo", ok.block.includes("## Estado turístico de la zona"));
    check("perfil turístico: la síntesis va adentro de la tarjeta", ok.card?.layout === "lead");
    const enriched = await prepareTourismContext({
      propertyId: h.propertyId, facets: ["movimiento"], mode: "enriched",
      message: "Cuales son las tendencias en mi ciudad para avivar las reservas?", level: "basico", budgetMs: 200, deps: h.deps,
    });
    check("análisis: la tarjeta va arriba del texto, no lo envuelve", enriched.card?.layout === "block");
    check("turno: los hubs leídos quedan en la telemetría", ok.meta.hubsCold.length > 0 && ok.meta.locationSource === "property");
    const normal = tourismSpecialization(ok, "avanzado");
    check("turno: la especialización no pide repetir cifras", normal.includes("No repitas las cifras") && !normal.includes("Glosario"));
  }
  {
    const h = harness({ address: { city: "Pueblo inventado" } });
    const noLoc = await prepareTourismContext({
      propertyId: h.propertyId, facets: ["eventos"], mode: "profile",
      message: "¿Hay eventos cerca?", level: "basico", budgetMs: 200, deps: h.deps,
    });
    check("sin ubicación: falla declarada y mensaje", noLoc.meta.failure === "no_location" && !!noLoc.failureMessage && noLoc.card === null);
    check("sin ubicación: la especialización pide cargarla", tourismSpecialization(noLoc, "basico").includes("cargar la ubicación"));
  }
}

// ── 7. Fixtures reales ───────────────────────────────────────────────────────

function testFixtures() {
  const root = path.join(__dirname, "fixtures", "tourism");
  if (!fs.existsSync(root)) {
    console.log("\n── Fixtures reales: no hay (capturar con npm run smoke:tourism -- --point <lat,lng,label> --dump <label>) ──");
    return;
  }
  const labels = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());
  for (const label of labels) {
    console.log(`\n── Fixture real: ${label} ──`);
    const dir = path.join(root, label);
    const read = (name: string) => {
      const f = path.join(dir, `${name}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    };
    const meta = read("meta") as { lat: number; lng: number; capturedAt: string; name?: string } | null;
    if (!meta) {
      check(`${label}: meta.json`, false);
      continue;
    }
    const now = new Date(meta.capturedAt);
    const at = meta.capturedAt;
    const wrap = <T>(p: Projection<T>): HubEnvelope<T> => ({ data: p.data, computedAt: at, ttlMs: 24 * 3600_000, ms: 0, missing: p.missing });
    const hubs: DossierHubs = {
      events: wrap(projectEvents({ culture: read("culture"), sports: read("sports"), mice: read("mice"), radiusKm: 100, now })),
      attention: wrap(projectAttention(read("attention"))),
      calendar: wrap(projectCalendar(read("calendar"), now)),
      climate: wrap(projectClimate(read("climate"))),
      place: wrap(projectPlace(read("place"))),
      hazards: wrap(projectHazards(read("hazards"))),
    };
    const d = makeDossier(hubs);
    d.location = { ...d.location, lat: meta.lat, lng: meta.lng };
    for (const hub of TOURISM_HUBS) {
      const raw = hub === "events" ? read("culture") ?? read("sports") ?? read("mice") : read(hub);
      if (raw) check(`${label}: ${hub} proyecta sin romperse`, (hubs[hub] as HubEnvelope).data !== null || (hubs[hub] as HubEnvelope).missing.length > 0);
    }
    for (const facet of TOURISM_FACETS) {
      const card = buildCard(d, [facet], now);
      check(`${label}/${facet}: ≤ 4 métricas`, card.metrics.length <= 4);
      const bad = card.metrics.filter((m) => !m.value || /undefined|NaN|null/.test(`${m.value} ${m.hint ?? ""}`));
      check(`${label}/${facet}: sin valores rotos`, bad.length === 0, bad);
    }
    const block = renderTourismBlock(d, TOURISM_FACETS, { now, level: "basico" });
    check(`${label}: bloque sin 'undefined'/'NaN'`, !/undefined|NaN/.test(block));
    check(`${label}: bloque ≤ 1.100 tokens con glosario`, tokens(block) <= 1100, tokens(block));
    console.log(`  ${tokens(block)} tok · tarjetas: ${TOURISM_FACETS.map((f) => `${f}=${buildCard(d, [f], now).metrics.map((m) => `${m.id}:${m.value}`).join("|")}`).join("  ")}`);
  }
}

async function main() {
  testFormat();
  testProjections();
  testCard();
  testRender();
  testPanel();
  await testDossier();
  await testTurn();
  testFixtures();

  console.log(`\n${pass} ok · ${fail} fallas`);
  if (fail > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
