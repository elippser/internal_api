// Hub de desastres naturales y disrupciones ambientales (event-list.md §10).
//
// DOS CAMINOS POR LOS QUE UN DESASTRE LLEGA A UN HOTEL
// El directo es obvio: el evento cae dentro del radio, hay cancelaciones y
// eventualmente danios. El indirecto es el que se pasa por alto y esta en la
// lista con todas las letras ("ceniza que cierra aeropuertos"): el hotel queda
// intacto y igual se queda sin huespedes porque el aeropuerto que lo alimenta
// dejo de operar. Por eso el payload cruza las amenazas contra los aeropuertos
// del §7 y publica `airliftRisk` aparte.
//
// POR QUE NO SE PISA CON EL §1
// El hub de clima responde la exposicion ESTRUCTURAL —"esta plaza tiene
// temporada de huracanes en febrero"— a partir de treinta anios de
// climatologia. Este responde lo que esta pasando AHORA. Mismo punto, una
// pregunta para planificar el anio y otra para decidir la semana.
//
// EL UMBRAL TERMICO ES RELATIVO, NO ABSOLUTO
// 35 grados es verano en Sevilla e imposible en Ushuaia. La ola de calor se
// mide contra el percentil 90 de los ultimos 60 dias DEL PROPIO LUGAR, que
// vienen en la misma llamada que el pronostico. Asi se detecta lo anomalo aca
// y ahora, que es lo que desorganiza una operacion.

import { fetchJson } from "../intelligence/core/http";
import { airportsNear, haversineKm } from "../connectivity/airports";
import {
  activeVolcanoes,
  gdacsEvents,
  quakesNear,
  tempSeries,
  type AlertLevel,
  type TempSeries,
} from "./sources";
import type {
  AirliftRisk,
  HazardEvent,
  HazardsCoverage,
  HazardsPointPayload,
  ImpactPath,
  Quake,
  TempAnomaly,
  Volcano,
} from "./hazards.types";

// ── Cache con TTL ─────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 400;

async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await load();
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { ts: Date.now(), value });
  return value;
}

// Un desastre no aparece y desaparece en minutos, pero tampoco conviene
// servir una alerta de hace horas: 20 min es el punto medio.
const TTL_EVENTS = 20 * 60 * 1000;
const TTL_QUAKES = 30 * 60 * 1000;
const TTL_VOLCANO = 6 * 60 * 60 * 1000;
const TTL_TEMP = 3 * 60 * 60 * 1000;

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";

/**
 * Nombre del pais EN INGLES, que es el idioma en el que GDACS publica su lista
 * de paises afectados. Se pide con accept-language=en para no depender de como
 * lo devuelva Nominatim segun el servidor.
 */
async function resolveCountryName(lat: number, lng: number): Promise<string | null> {
  const key = "geo:en:" + lat.toFixed(1) + ":" + lng.toFixed(1);
  return memo(key, 30 * 24 * 60 * 60 * 1000, async () => {
    try {
      const data = await fetchJson<{ address?: Record<string, string> }>(
        NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng +
          "&format=json&zoom=5&addressdetails=1&accept-language=en",
        {
          headers: { "user-agent": "roombir-internal-hazards-hub/1.0" },
          timeoutMs: 12_000,
          retries: 1,
        },
      );
      return data.address?.country ?? null;
    } catch {
      return null;
    }
  });
}

const ALERT_RANK: Record<AlertLevel, number> = { Red: 3, Orange: 2, Green: 1 };

/**
 * Amenazas cuyo alcance es el territorio y no un punto. Solo estas pueden
 * entrar al payload por pais: para el resto, el centroide que publica GDACS es
 * la ubicacion real del evento y filtrar por distancia es lo correcto.
 */
const AREAL_TYPES = new Set(["DR"]);

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Percentil de una serie, ignorando huecos. Se usa sobre los 60 dias previos
 * para fijar que es "anomalo" en este lugar y esta epoca.
 */
function percentile(values: Array<number | null>, p: number): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (clean.length < 20) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Rachas de calor o frio en el tramo de pronostico.
 *
 * Se exigen 3 dias consecutivos: un dia suelto por encima del umbral es ruido
 * meteorologico, no una ola. Es el mismo criterio con el que los servicios
 * meteorologicos declaran una ola de calor.
 */
function detectAnomalies(series: TempSeries): TempAnomaly[] {
  const { dates, max, min, forecastFrom } = series;
  if (!dates.length || forecastFrom >= dates.length) return [];

  const pastMax = max.slice(0, forecastFrom);
  const pastMin = min.slice(0, forecastFrom);
  const hot = percentile(pastMax, 0.9);
  const cold = percentile(pastMin, 0.1);

  const out: TempAnomaly[] = [];

  const scan = (
    kind: "heat" | "cold",
    values: Array<number | null>,
    threshold: number | null,
    exceeds: (v: number, t: number) => boolean,
  ): void => {
    if (threshold === null) return;
    let runStart = -1;
    for (let i = forecastFrom; i <= dates.length; i++) {
      const v = i < dates.length ? values[i] : null;
      const over = typeof v === "number" && exceeds(v, threshold);
      if (over && runStart === -1) runStart = i;
      if (!over && runStart !== -1) {
        const len = i - runStart;
        if (len >= 3) {
          const slice = values.slice(runStart, i).filter((x): x is number => typeof x === "number");
          out.push({
            kind,
            startDate: dates[runStart],
            endDate: dates[i - 1],
            days: len,
            peakC: kind === "heat" ? Math.max(...slice) : Math.min(...slice),
            thresholdC: Math.round(threshold * 10) / 10,
          });
        }
        runStart = -1;
      }
    }
  };

  scan("heat", max, hot, (v, t) => v > t);
  scan("cold", min, cold, (v, t) => v < t);
  return out;
}

// ── Endpoint ──────────────────────────────────────────────────────────────

export async function getHazardsPoint(
  lat: number,
  lng: number,
  radiusKm: number,
  windowDays = 30,
): Promise<HazardsPointPayload> {
  const gaps: string[] = [];
  const today = todayIso();

  const [gdacsRes, quakeRes, volcanoRes, tempRes, airportsRes, countryRes] =
    await Promise.allSettled([
    memo("gdacs:" + windowDays, TTL_EVENTS, () => gdacsEvents(windowDays)),
    memo(
      "usgs:" + lat.toFixed(1) + ":" + lng.toFixed(1) + ":" + Math.round(radiusKm),
      TTL_QUAKES,
      () => quakesNear(lat, lng, radiusKm, 90, 3.5),
    ),
    memo("eonet:volcanoes", TTL_VOLCANO, () => activeVolcanoes()),
    memo("temp:" + lat.toFixed(2) + ":" + lng.toFixed(2), TTL_TEMP, () => tempSeries(lat, lng)),
    airportsNear(lat, lng, Math.max(radiusKm, 150)),
    resolveCountryName(lat, lng),
  ]);

  // ── Eventos multi-amenaza ──
  const active: HazardEvent[] = [];
  const recent: HazardEvent[] = [];
  if (gdacsRes.status === "fulfilled") {
    const countryName =
      countryRes.status === "fulfilled" ? countryRes.value : null;

    for (const e of gdacsRes.value) {
      const d = haversineKm(lat, lng, e.lat, e.lng);
      const near = d <= radiusKm;
      // El alcance por pais vale SOLO para las amenazas realmente areales.
      // Una sequia cubre el territorio entero y su centroide es un artefacto;
      // un incendio o una inundacion tienen centroide real y localizado. Sin
      // esta distincion, Miami mostraba "incendio en Estados Unidos" a 4.000 km
      // como amenaza directa, que es California y no tiene nada que ver.
      const covers =
        !near &&
        AREAL_TYPES.has(e.type) &&
        countryName !== null &&
        e.countries.some((c) => c === countryName);
      if (!near && !covers) continue;
      const item: HazardEvent = {
        scope: near ? "local" : "country",
        type: e.type,
        typeName: e.typeName,
        name: e.name,
        country: e.country,
        alertLevel: e.alertLevel,
        distanceKm: Math.round(d),
        from: e.from,
        to: e.to,
        // GDACS extiende `todate` mientras el evento sigue vivo.
        ongoing: Boolean(e.to) && e.to >= today,
        url: e.url,
      };
      (item.ongoing ? active : recent).push(item);
    }
    // Primero lo mas grave; a igual gravedad, lo mas cerca.
    const bySeverity = (a: HazardEvent, b: HazardEvent): number =>
      ALERT_RANK[b.alertLevel] - ALERT_RANK[a.alertLevel] || a.distanceKm - b.distanceKm;
    active.sort(bySeverity);
    recent.sort(bySeverity);
  } else {
    gaps.push("GDACS no respondio: sin relevamiento multi-amenaza (inundacion, ciclon, sequia)");
  }

  // ── Sismos ──
  let quakes: Quake[] = [];
  if (quakeRes.status === "fulfilled") {
    quakes = quakeRes.value
      .map((q) => ({
        magnitude: q.magnitude,
        depthKm: q.depthKm,
        place: q.place,
        time: q.time,
        distanceKm: Math.round(haversineKm(lat, lng, q.lat, q.lng)),
        url: q.url,
      }))
      .sort((a, b) => b.magnitude - a.magnitude)
      .slice(0, 10);
  } else {
    gaps.push("USGS no respondio: sin catalogo sismico");
  }

  // ── Volcanes ──
  let volcanoes: Volcano[] = [];
  if (volcanoRes.status === "fulfilled") {
    volcanoes = volcanoRes.value
      .map((v) => ({
        name: v.name,
        distanceKm: Math.round(haversineKm(lat, lng, v.lat, v.lng)),
        since: v.since,
        url: v.url,
      }))
      // La ceniza viaja mucho mas lejos que la lava: el radio para volcanes se
      // estira a 1000 km o al radio pedido, lo que sea mayor.
      .filter((v) => v.distanceKm <= Math.max(radiusKm, 1000))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 8);
  } else {
    gaps.push("EONET no respondio: sin volcanes activos");
  }

  // ── Anomalias termicas ──
  let anomalies: TempAnomaly[] = [];
  if (tempRes.status === "fulfilled") {
    anomalies = detectAnomalies(tempRes.value);
  } else {
    gaps.push("Open-Meteo no respondio: sin deteccion de olas de calor o frio");
  }

  // ── Riesgo para el acceso aereo ──
  const airliftRisk: AirliftRisk[] = [];
  if (airportsRes.status === "fulfilled" && gdacsRes.status === "fulfilled") {
    const airports = airportsRes.value.filter((a) => a.scheduledService).slice(0, 6);
    for (const ap of airports) {
      for (const e of gdacsRes.value) {
        // Solo lo que efectivamente cierra un aeropuerto. Una sequia no lo
        // hace; una ceniza, un ciclon o una inundacion si.
        if (!["VO", "TC", "FL", "TS"].includes(e.type)) continue;
        if (e.alertLevel === "Green") continue;
        if (!(e.to && e.to >= today)) continue;
        const d = haversineKm(ap.lat, ap.lng, e.lat, e.lng);
        // La ceniza vuela lejos; el resto tiene que estar encima.
        const reach = e.type === "VO" ? 500 : 300;
        if (d > reach) continue;
        airliftRisk.push({
          airport: ap.name,
          airportIata: ap.iata,
          airportDistanceKm: ap.distanceKm,
          hazard: e.name,
          hazardType: e.typeName,
          hazardDistanceKm: Math.round(d),
          alertLevel: e.alertLevel,
        });
      }
    }
    airliftRisk.sort(
      (a, b) => ALERT_RANK[b.alertLevel] - ALERT_RANK[a.alertLevel] || a.hazardDistanceKm - b.hazardDistanceKm,
    );
  }

  // ── Titular ──
  const worstAlert: AlertLevel | null = active.length
    ? active.reduce<AlertLevel>(
        (acc, e) => (ALERT_RANK[e.alertLevel] > ALERT_RANK[acc] ? e.alertLevel : acc),
        "Green",
      )
    : null;

  const paths: ImpactPath[] = [];
  if (active.length) paths.push("direct");
  if (airliftRisk.length) paths.push("airlift");

  gaps.push("Escasez de agua potable: no hay fuente abierta con actualizacion util");
  gaps.push("Deslizamientos: GDACS solo los reporta cuando acompanan a otra amenaza");
  gaps.push("Avisos de tsunami en tiempo real: los centros regionales no exponen API comun");

  const coverage: HazardsCoverage = {
    gdacs: gdacsRes.status === "fulfilled",
    quakes: quakeRes.status === "fulfilled",
    volcanoes: volcanoRes.status === "fulfilled",
    temperature: tempRes.status === "fulfilled",
    gaps,
  };

  const from = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  return {
    location: { lat, lng, radiusKm },
    active,
    recent: recent.slice(0, 12),
    quakes,
    volcanoes,
    anomalies,
    airliftRisk: airliftRisk.slice(0, 6),
    headline: { worstAlert, activeCount: active.length, paths },
    window: { days: windowDays, from, to: today },
    coverage,
    sources: [
      "GDACS (Comision Europea / ONU)",
      "USGS (catalogo sismico)",
      "NASA EONET (volcanes activos)",
      "Open-Meteo (anomalias termicas)",
      "OurAirports (cruce con acceso aereo)",
    ],
    timestamp: new Date().toISOString(),
  };
}
