// Hub de estacionalidad climática y geográfica (event-list.md §1).
//
// Todo sale de APIs públicas sin key, en paralelo y con fallo suave por
// sección (Promise.allSettled): si una fuente cae, el payload llega igual
// con esa sección en null.
//
//   - Open-Meteo Archive (ERA5): 10 años de series diarias → normales
//     mensuales de temperatura, lluvia, días de lluvia, nieve, humedad y sol.
//   - NASA POWER climatology: índice UV mensual y récords absolutos del mes.
//   - NASA POWER monthly: 40+ años de temperatura media → corrimiento
//     climático (década base vs. década reciente) y tendencia por década.
//   - Open-Meteo Air Quality (CAMS): AQI/PM actuales + polen (solo Europa).
//   - Open-Meteo Forecast: UV de hoy y profundidad de nieve actual.
//   - NOAA CPC (oni.ascii.txt): fase ENSO vigente (El Niño / La Niña).
//
// PRESUPUESTO DE REQUESTS — importa: Open-Meteo cobra por peso (variables ×
// días) y su límite por minuto es fácil de reventar explorando el mapa. Por
// eso va UNA sola llamada al archive por punto, con el mínimo de variables:
//   · tMean no se pide, se deriva de (tMax + tMin) / 2.
//   · daylight_duration no se pide, se calcula astronómicamente acá abajo.
//   · el baseline histórico no es una segunda llamada al archive, lo da POWER.
// Sumado al cache de 24 h por celda de 0.1°, un usuario clickeando el mapa no
// llega al techo. Si igual lo toca, el 429 sube como mensaje entendible.
//
// Temporadas de huracanes/tornados: ventanas estáticas por cuenca (no hay
// API libre para eso); temporada de incendios/lluvias/nieve: derivadas de
// las normales del propio punto.

import { fetchJson, fetchText, HttpError } from "../intelligence/core/http";
import { isOnLand } from "../intelligence/core/landMask";
import type {
  ClimatePointPayload,
  ClimateShift,
  CurrentSnapshot,
  EnsoStatus,
  HazardWindows,
  MonthlyNormal,
  SeasonWindows,
  SpecialWindows,
} from "./climate.types";

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";
const POWER_CLIMATOLOGY = "https://power.larc.nasa.gov/api/temporal/climatology/point";
const POWER_MONTHLY = "https://power.larc.nasa.gov/api/temporal/monthly/point";
const ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt";

/** POWER marca los faltantes con -999. */
const POWER_FILL = -900;

// ── Cache en memoria ──────────────────────────────────────────────────────
// Las normales no cambian de un día para otro: celda de 0.1° (~11 km), TTL
// 24 h, tope de entradas para no crecer sin límite.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map<string, { ts: number; payload: ClimatePointPayload }>();

let oniCache: { ts: number; enso: EnsoStatus | null } | null = null;
const ONI_TTL_MS = 12 * 60 * 60 * 1000;

// ── Respuestas upstream ───────────────────────────────────────────────────

interface ArchiveDaily {
  time: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  precipitation_sum?: Array<number | null>;
  snowfall_sum?: Array<number | null>;
  relative_humidity_2m_mean?: Array<number | null>;
  sunshine_duration?: Array<number | null>;
}

interface ArchiveResponse {
  elevation?: number;
  timezone?: string;
  daily?: ArchiveDaily;
}

interface PowerResponse {
  properties?: { parameter?: Record<string, Record<string, number>> };
}

interface AirQualityResponse {
  current?: {
    european_aqi?: number | null;
    us_aqi?: number | null;
    pm2_5?: number | null;
    pm10?: number | null;
    ozone?: number | null;
  };
  hourly?: Record<string, Array<number | null> | string[]>;
}

interface ForecastResponse {
  daily?: { uv_index_max?: Array<number | null> };
  hourly?: { snow_depth?: Array<number | null> };
}

// ── Helpers ───────────────────────────────────────────────────────────────

const round1 = (n: number): number => Math.round(n * 10) / 10;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Horas de luz del día 15 de cada mes, por geometría solar. Se calcula en vez
 * de pedirse: es determinístico a partir de la latitud y ahorra una variable
 * en la llamada al archive, que es la que pesa.
 */
function daylightHoursByMonth(lat: number): Array<number | null> {
  const MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];
  const phi = (lat * Math.PI) / 180;
  return MID_DOY.map((n) => {
    const decl = 0.409 * Math.sin((2 * Math.PI * n) / 365 - 1.39); // radianes
    const cosH = -Math.tan(phi) * Math.tan(decl);
    if (cosH >= 1) return 0; // noche polar
    if (cosH <= -1) return 24; // sol de medianoche
    return round1((2 * Math.acos(cosH) * 24) / (2 * Math.PI));
  });
}

/** Acumuladores por mes (1-12) a partir de las series diarias del archive. */
function buildMonthlyNormals(daily: ArchiveDaily, years: number, lat: number): MonthlyNormal[] {
  type Acc = {
    tMax: number[]; tMin: number[]; hum: number[]; sun: number[];
    precipTotal: number; snowTotal: number; rainDays: number;
  };
  const acc: Acc[] = Array.from({ length: 12 }, () => ({
    tMax: [], tMin: [], hum: [], sun: [], precipTotal: 0, snowTotal: 0, rainDays: 0,
  }));

  daily.time.forEach((date, i) => {
    const m = Number(date.slice(5, 7)) - 1;
    if (m < 0 || m > 11) return;
    const a = acc[m];
    const push = (arr: number[], v: number | null | undefined) => {
      if (typeof v === "number" && Number.isFinite(v)) arr.push(v);
    };
    push(a.tMax, daily.temperature_2m_max?.[i]);
    push(a.tMin, daily.temperature_2m_min?.[i]);
    push(a.hum, daily.relative_humidity_2m_mean?.[i]);
    push(a.sun, daily.sunshine_duration?.[i]);
    const p = daily.precipitation_sum?.[i];
    if (typeof p === "number" && Number.isFinite(p)) {
      a.precipTotal += p;
      if (p >= 1) a.rainDays += 1;
    }
    const s = daily.snowfall_sum?.[i];
    if (typeof s === "number" && Number.isFinite(s)) a.snowTotal += s;
  });

  const daylight = daylightHoursByMonth(lat);

  return acc.map((a, i) => {
    const r = (v: number | null): number | null => (v === null ? null : round1(v));
    const tMax = mean(a.tMax);
    const tMin = mean(a.tMin);
    return {
      month: i + 1,
      tMax: r(tMax),
      tMin: r(tMin),
      // Derivada: pedir temperature_2m_mean sería una variable más de peso
      // en la llamada cara, y (max+min)/2 alcanza para detectar temporadas.
      tMean: tMax !== null && tMin !== null ? round1((tMax + tMin) / 2) : null,
      precipMm: round1(a.precipTotal / years),
      rainDays: round1(a.rainDays / years),
      snowCm: round1(a.snowTotal / years),
      humidityPct: r(mean(a.hum)),
      sunshineHours: a.sun.length ? round1((mean(a.sun) as number) / 3600) : null,
      daylightHours: daylight[i],
      uvIndex: null, // lo completa NASA POWER
      tRecordHigh: null,
      tRecordLow: null,
    };
  });
}

/**
 * Ventana de N meses consecutivos (con wrap dic→ene) que maximiza el valor.
 * Devuelve [] si ninguna ventana tiene los N meses con dato: sin esto, un
 * punto sin datos caería en el bestStart por defecto y el panel mostraría
 * "ENE FEB MAR" como si fuera un resultado real.
 */
function bestConsecutiveWindow(values: Array<number | null>, size: number, invert = false): number[] {
  let bestStart = -1;
  let bestSum = -Infinity;
  for (let start = 0; start < 12; start++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < size; k++) {
      const v = values[(start + k) % 12];
      if (v === null) { ok = false; break; }
      sum += invert ? -v : v;
    }
    if (ok && sum > bestSum) { bestSum = sum; bestStart = start; }
  }
  if (bestStart < 0) return [];
  return Array.from({ length: size }, (_, k) => ((bestStart + k) % 12) + 1);
}

function deriveSeasons(normals: MonthlyNormal[]): SeasonWindows {
  const tMeans = normals.map((n) => n.tMean);
  const precip = normals.map((n) => n.precipMm ?? 0);
  const valid = tMeans.filter((t): t is number => t !== null);
  const amplitude = valid.length ? Math.max(...valid) - Math.min(...valid) : 0;
  const annualPrecip = precip.reduce((a, b) => a + b, 0);
  const monthlyAvg = annualPrecip / 12;

  let profile: SeasonWindows["profile"] = "temperate";
  if (annualPrecip < 200) profile = "arid";
  else if (valid.length && Math.max(...valid) < 10) profile = "polar";
  else if (amplitude < 6 && valid.length && Math.min(...valid) > 18) profile = "tropical";

  const wet = annualPrecip < 150
    ? []
    : normals.filter((n) => (n.precipMm ?? 0) >= monthlyAvg * 1.3).map((n) => n.month);
  const dry = normals
    .filter((n) => (n.precipMm ?? 0) <= monthlyAvg * 0.6)
    .map((n) => n.month);
  const snow = normals.filter((n) => (n.snowCm ?? 0) >= 5).map((n) => n.month);

  // Monzónico: 4 meses consecutivos concentran >=65% de la lluvia anual.
  let monsoonal = false;
  if (annualPrecip >= 400) {
    for (let start = 0; start < 12; start++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += precip[(start + k) % 12];
      if (sum / annualPrecip >= 0.65) { monsoonal = true; break; }
    }
  }

  // Confort: cerca de 24°C de máxima y pocos días de lluvia.
  const comfort = normals.map((n) => {
    if (n.tMax === null) return null;
    return -(Math.abs(n.tMax - 24) + (n.rainDays ?? 0) * 0.6);
  });

  return {
    profile,
    amplitudeC: round1(amplitude),
    annualPrecipMm: round1(annualPrecip),
    warmest: bestConsecutiveWindow(tMeans, 3),
    coldest: bestConsecutiveWindow(tMeans, 3, true),
    wet,
    dry,
    snow,
    best: bestConsecutiveWindow(comfort, 3),
    monsoonal,
  };
}

// Cuencas de ciclones tropicales: cajas aproximadas + ventana oficial de
// temporada. No hay API libre de "temporada de huracanes"; esto es geografía.
const HURRICANE_BASINS: Array<{
  basin: string; latMin: number; latMax: number; lngMin: number; lngMax: number;
  months: number[]; note?: string;
}> = [
  { basin: "Atlántico Norte", latMin: 8, latMax: 45, lngMin: -100, lngMax: -20, months: [6, 7, 8, 9, 10, 11] },
  { basin: "Pacífico Este", latMin: 5, latMax: 35, lngMin: -140, lngMax: -85, months: [5, 6, 7, 8, 9, 10, 11] },
  { basin: "Pacífico Oeste (tifones)", latMin: 4, latMax: 45, lngMin: 100, lngMax: 180, months: [7, 8, 9, 10], note: "Actividad todo el año; pico jul-oct" },
  { basin: "Índico Norte", latMin: 5, latMax: 28, lngMin: 55, lngMax: 100, months: [4, 5, 10, 11], note: "Picos pre y post monzón" },
  { basin: "Índico Sudoeste", latMin: -35, latMax: -5, lngMin: 30, lngMax: 90, months: [11, 12, 1, 2, 3, 4] },
  { basin: "Región Australiana", latMin: -35, latMax: -5, lngMin: 90, lngMax: 160, months: [11, 12, 1, 2, 3, 4] },
  { basin: "Pacífico Sur", latMin: -35, latMax: -5, lngMin: 160, lngMax: 180, months: [11, 12, 1, 2, 3, 4] },
  { basin: "Pacífico Sur", latMin: -35, latMax: -5, lngMin: -180, lngMax: -120, months: [11, 12, 1, 2, 3, 4] },
];

const TORNADO_REGIONS: Array<{
  region: string; latMin: number; latMax: number; lngMin: number; lngMax: number; months: number[];
}> = [
  { region: "Tornado Alley / Dixie (EE.UU.)", latMin: 26, latMax: 49, lngMin: -104, lngMax: -80, months: [3, 4, 5, 6] },
  { region: "Pasillo sudamericano (Pampas)", latMin: -40, latMax: -20, lngMin: -68, lngMax: -45, months: [10, 11, 12, 1, 2, 3] },
];

/**
 * Distancia aproximada al océano, muestreando la máscara de tierra del
 * intelligence-hub en anillos de radio creciente. Devuelve el primer radio
 * (km) donde encuentra agua, o null si no hay mar dentro de `maxKm`.
 *
 * Los ciclones tropicales necesitan esto: la caja de la cuenca sola marcaría
 * a Oklahoma City como zona de huracanes del Atlántico Norte.
 */
function distanceToOceanKm(lat: number, lng: number, maxKm = 200): number | null {
  const EARTH_R = 6371;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const radius of [50, 100, 150, 200]) {
    if (radius > maxKm) break;
    for (let b = 0; b < 16; b++) {
      const bearing = (b * 2 * Math.PI) / 16;
      const dLat = ((radius / EARTH_R) * Math.cos(bearing) * 180) / Math.PI;
      const dLng =
        Math.abs(cosLat) < 1e-6
          ? 0
          : ((radius / EARTH_R) * Math.sin(bearing) * 180) / Math.PI / cosLat;
      const sLat = lat + dLat;
      const sLng = lng + dLng;
      if (sLat < -90 || sLat > 90) continue;
      // Normaliza el cruce de la antimeridiana.
      const nLng = ((sLng + 180) % 360 + 360) % 360 - 180;
      if (!isOnLand(nLng, sLat)) return radius;
    }
  }
  return null;
}

function deriveHazards(
  lat: number,
  lng: number,
  normals: MonthlyNormal[],
  oceanKm: number | null,
): HazardWindows {
  const inBox = (b: { latMin: number; latMax: number; lngMin: number; lngMax: number }) =>
    lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax;

  // Solo costa: tierra adentro los ciclones llegan como resto de tormenta, no
  // como temporada que mueva la ocupación.
  const basin = oceanKm !== null ? (HURRICANE_BASINS.find(inBox) ?? null) : null;
  const tornado = TORNADO_REGIONS.find(inBox) ?? null;

  // Riesgo de incendios: meses calurosos (tMax >= 22°C) que además están
  // entre los más secos y con humedad baja para este punto.
  const precipSorted = [...normals].sort((a, b) => (a.precipMm ?? 0) - (b.precipMm ?? 0));
  const dryCutoff = precipSorted[3]?.precipMm ?? 0; // cuartil seco
  const fireRisk = normals
    .filter(
      (n) =>
        (n.tMax ?? -99) >= 22 &&
        (n.precipMm ?? 0) <= Math.max(dryCutoff, 30) &&
        (n.humidityPct === null || n.humidityPct <= 70),
    )
    .map((n) => n.month);

  return {
    hurricane: basin ? { basin: basin.basin, months: basin.months, note: basin.note } : null,
    tornado: tornado ? { region: tornado.region, months: tornado.months } : null,
    fireRisk,
  };
}

function deriveSpecial(lat: number, seasons: SeasonWindows): SpecialWindows {
  const absLat = Math.abs(lat);
  const temperate = absLat >= 30 && absLat <= 62 && seasons.amplitudeC >= 10;
  if (!temperate) return { foliage: null, bloom: null };
  const north = lat >= 0;
  return {
    foliage: north ? [10, 11] : [4, 5],
    bloom: north ? [3, 4] : [9, 10],
  };
}

// ── ENSO (NOAA CPC ONI) ───────────────────────────────────────────────────

function parseOni(text: string): EnsoStatus | null {
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1]?.trim().split(/\s+/);
  if (!last || last.length < 4) return null;
  const anom = Number(last[3]);
  if (!Number.isFinite(anom)) return null;
  const abs = Math.abs(anom);
  const phase: EnsoStatus["phase"] = anom >= 0.5 ? "El Niño" : anom <= -0.5 ? "La Niña" : "Neutral";
  const strength =
    phase === "Neutral" ? null : abs >= 2 ? "very strong" : abs >= 1.5 ? "strong" : abs >= 1 ? "moderate" : "weak";
  return { phase, oni: anom, period: `${last[0]} ${last[1]}`, strength };
}

async function getEnso(): Promise<EnsoStatus | null> {
  if (oniCache && Date.now() - oniCache.ts < ONI_TTL_MS) return oniCache.enso;
  try {
    const text = await fetchText(ONI_URL, { timeoutMs: 10_000 });
    const enso = parseOni(text);
    oniCache = { ts: Date.now(), enso };
    return enso;
  } catch {
    return oniCache?.enso ?? null;
  }
}

// ── Corrimiento climático (NASA POWER monthly) ────────────────────────────

/**
 * POWER monthly devuelve claves `YYYYMM` (con `MM=13` = anual). Compara la
 * primera década completa contra la última y ajusta una recta a los anuales.
 */
function buildClimateShift(param: Record<string, number> | undefined): ClimateShift | null {
  if (!param) return null;

  const byYear = new Map<number, Array<number | null>>();
  const annual: Array<{ year: number; value: number }> = [];

  for (const [key, raw] of Object.entries(param)) {
    if (key.length !== 6 || typeof raw !== "number" || raw <= POWER_FILL) continue;
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(4, 6));
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
    if (month === 13) {
      annual.push({ year, value: raw });
      continue;
    }
    if (month < 1 || month > 12) continue;
    if (!byYear.has(year)) byYear.set(year, Array(12).fill(null));
    byYear.get(year)![month - 1] = raw;
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length < 20) return null;

  const baseYears = years.slice(0, 10);
  const recentYears = years.slice(-10);

  const monthlyMean = (ys: number[], m: number): number | null => {
    const vals = ys
      .map((y) => byYear.get(y)?.[m])
      .filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const monthlyDeltaC = Array.from({ length: 12 }, (_, m) => {
    const base = monthlyMean(baseYears, m);
    const recent = monthlyMean(recentYears, m);
    return base === null || recent === null ? null : round1(recent - base);
  });

  const deltas = monthlyDeltaC.filter((d): d is number => d !== null);
  if (!deltas.length) return null;

  // Tendencia: regresión lineal simple sobre los promedios anuales.
  let trendCPerDecade: number | null = null;
  if (annual.length >= 20) {
    const n = annual.length;
    const meanX = annual.reduce((s, p) => s + p.year, 0) / n;
    const meanY = annual.reduce((s, p) => s + p.value, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of annual) {
      num += (p.year - meanX) * (p.value - meanY);
      den += (p.year - meanX) ** 2;
    }
    if (den > 0) trendCPerDecade = round1((num / den) * 10);
  }

  return {
    baseline: `${baseYears[0]}-${baseYears[baseYears.length - 1]}`,
    recent: `${recentYears[0]}-${recentYears[recentYears.length - 1]}`,
    annualDeltaC: round1(deltas.reduce((a, b) => a + b, 0) / deltas.length),
    monthlyDeltaC,
    trendCPerDecade,
  };
}

// ── Servicio principal ────────────────────────────────────────────────────

const POWER_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export async function getClimatePoint(lat: number, lng: number): Promise<ClimatePointPayload> {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.payload;

  const endYear = new Date().getUTCFullYear() - 1;
  const startYear = endYear - 9;
  const years = 10;

  // Mínimo indispensable: tMean y daylight se derivan, no se piden.
  const dailyVars = [
    "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
    "snowfall_sum", "relative_humidity_2m_mean", "sunshine_duration",
  ].join(",");

  const archiveUrl =
    `${ARCHIVE_BASE}?latitude=${lat}&longitude=${lng}` +
    `&start_date=${startYear}-01-01&end_date=${endYear}-12-31` +
    `&daily=${dailyVars}&timezone=auto`;

  const climatologyUrl =
    `${POWER_CLIMATOLOGY}?parameters=ALLSKY_SFC_UV_INDEX,T2M_MAX,T2M_MIN` +
    `&community=RE&latitude=${lat}&longitude=${lng}&format=JSON`;

  const monthlyUrl =
    `${POWER_MONTHLY}?parameters=T2M&community=RE` +
    `&latitude=${lat}&longitude=${lng}&start=1981&end=${endYear}&format=JSON`;

  const airUrl =
    `${AIR_QUALITY_BASE}?latitude=${lat}&longitude=${lng}` +
    `&current=european_aqi,us_aqi,pm2_5,pm10,ozone` +
    `&hourly=alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen` +
    `&forecast_days=1&timezone=auto`;

  const forecastUrl =
    `${FORECAST_BASE}?latitude=${lat}&longitude=${lng}` +
    `&daily=uv_index_max&hourly=snow_depth&forecast_days=1&timezone=auto`;

  const settled = await Promise.allSettled([
    // retries: 0 a propósito — el 429 del archive es el techo POR MINUTO de
    // Open-Meteo, y el backoff de fetchJson (1s, 2s) no lo espera: solo
    // quemaría más cuota. Falla rápido y el mensaje le dice al usuario que
    // reintente; el cache de 24 h hace que no vuelva a pasar por ese punto.
    fetchJson<ArchiveResponse>(archiveUrl, { timeoutMs: 30_000, retries: 0 }),
    fetchJson<PowerResponse>(climatologyUrl, { timeoutMs: 15_000, retries: 1 }),
    fetchJson<PowerResponse>(monthlyUrl, { timeoutMs: 20_000, retries: 1 }),
    fetchJson<AirQualityResponse>(airUrl, { timeoutMs: 12_000, retries: 1 }),
    fetchJson<ForecastResponse>(forecastUrl, { timeoutMs: 12_000, retries: 1 }),
    getEnso(),
  ]);

  const archiveSettled = settled[0];
  if (archiveSettled.status === "rejected") {
    const err = archiveSettled.reason;
    // El techo por minuto de Open-Meteo es la falla esperable al explorar el
    // mapa rápido: que se lea como tal y no como "las fuentes se cayeron".
    // Open-Meteo tiene techos por minuto, hora y día, y el 429 no dice cuál
    // desde el status: no prometemos "en un minuto" porque el de la hora
    // también cae acá y el mensaje mandaría a reintentar en vano.
    if (err instanceof HttpError && err.status === 429) {
      throw new Error(
        "Open-Meteo rechazó la consulta por límite de uso. Reintentá en unos minutos.",
      );
    }
    throw new Error(
      err instanceof Error
        ? `No se pudo obtener el histórico climático: ${err.message}`
        : "No se pudo obtener el histórico climático (Open-Meteo Archive)",
    );
  }

  const val = <T>(i: number): T | null =>
    settled[i].status === "fulfilled" ? ((settled[i] as PromiseFulfilledResult<T>).value) : null;

  const archiveRes = archiveSettled.value;
  const climatologyRes = val<PowerResponse>(1);
  const monthlyRes = val<PowerResponse>(2);
  const airRes = val<AirQualityResponse>(3);
  const forecastRes = val<ForecastResponse>(4);
  const enso = val<EnsoStatus>(5);

  if (!archiveRes?.daily?.time?.length) {
    throw new Error("El histórico climático llegó vacío (Open-Meteo Archive)");
  }

  const normals = buildMonthlyNormals(archiveRes.daily, years, lat);

  // UV mensual y récords absolutos desde NASA POWER.
  const clim = climatologyRes?.properties?.parameter;
  if (clim) {
    const put = (
      src: Record<string, number> | undefined,
      set: (n: MonthlyNormal, v: number) => void,
    ) => {
      if (!src) return;
      normals.forEach((n) => {
        const v = src[POWER_MONTHS[n.month - 1]];
        if (typeof v === "number" && v > POWER_FILL) set(n, round1(v));
      });
    };
    put(clim.ALLSKY_SFC_UV_INDEX, (n, v) => { n.uvIndex = v; });
    put(clim.T2M_MAX, (n, v) => { n.tRecordHigh = v; });
    put(clim.T2M_MIN, (n, v) => { n.tRecordLow = v; });
  }

  const seasons = deriveSeasons(normals);
  const oceanKm = distanceToOceanKm(lat, lng);
  const hazards = deriveHazards(lat, lng, normals, oceanKm);
  const special = deriveSpecial(lat, seasons);
  const climateShift = buildClimateShift(monthlyRes?.properties?.parameter?.T2M);

  // Snapshot actual
  const maxOfDay = (arr: Array<number | null> | string[] | undefined): number | null => {
    if (!Array.isArray(arr)) return null;
    const nums = arr.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return nums.length ? round1(Math.max(...nums)) : null;
  };

  const pollenRaw = airRes?.hourly;
  const pollen = pollenRaw
    ? {
        alder: maxOfDay(pollenRaw.alder_pollen),
        birch: maxOfDay(pollenRaw.birch_pollen),
        grass: maxOfDay(pollenRaw.grass_pollen),
        mugwort: maxOfDay(pollenRaw.mugwort_pollen),
        olive: maxOfDay(pollenRaw.olive_pollen),
        ragweed: maxOfDay(pollenRaw.ragweed_pollen),
      }
    : null;
  const pollenHasData = pollen !== null && Object.values(pollen).some((v) => v !== null);
  const snowDepthM = maxOfDay(forecastRes?.hourly?.snow_depth);

  const current: CurrentSnapshot = {
    airQuality: airRes?.current
      ? {
          europeanAqi: airRes.current.european_aqi ?? null,
          usAqi: airRes.current.us_aqi ?? null,
          pm25: airRes.current.pm2_5 ?? null,
          pm10: airRes.current.pm10 ?? null,
          ozone: airRes.current.ozone ?? null,
        }
      : null,
    pollen: pollenHasData ? pollen : null,
    snowDepthCm: snowDepthM !== null ? round1(snowDepthM * 100) : null,
    uvIndexMaxToday: forecastRes?.daily?.uv_index_max?.[0] ?? null,
  };

  const payload: ClimatePointPayload = {
    location: {
      lat,
      lng,
      elevation: archiveRes.elevation ?? null,
      timezone: archiveRes.timezone ?? null,
      hemisphere: lat >= 0 ? "north" : "south",
      oceanWithinKm: oceanKm,
    },
    normals,
    seasons,
    hazards,
    special,
    enso,
    climateShift,
    current,
    sources: [
      `Open-Meteo Archive / ERA5 (${startYear}-${endYear})`,
      "NASA POWER",
      "NOAA CPC (ONI)",
      "Open-Meteo Air Quality (CAMS)",
    ],
    timestamp: new Date().toISOString(),
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), payload });

  return payload;
}
