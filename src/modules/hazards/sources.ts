// Fuentes del hub de desastres naturales (event-list.md §10).
//
// Tres fuentes con roles distintos, no intercambiables:
//
//   · GDACS  — el agregador multi-amenaza de la Comision Europea y la ONU.
//     Cubre inundacion, sismo, ciclon, sequia, incendio, volcan y tsunami con
//     un nivel de alerta comun (verde/naranja/rojo). Es la columna vertebral.
//   · USGS   — sismos con consulta por radio, magnitud y profundidad. GDACS
//     solo publica los que superan su umbral de alerta; para "hubo temblores
//     cerca" hace falta el catalogo completo.
//   · EONET  — volcanes activos de la NASA. GDACS reporta la erupcion cuando
//     dispara alerta; EONET mantiene abierto el evento mientras dure.

const GDACS_BASE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
const USGS_BASE = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const EONET_BASE = "https://eonet.gsfc.nasa.gov/api/v3/events";

const UA = "roombir-internal-hazards-hub/1.0 (+https://roombir.com)";

/** Tipos de evento de GDACS, con su nombre en castellano. */
export const GDACS_TYPES: Record<string, string> = {
  EQ: "Terremoto",
  TC: "Ciclon tropical",
  FL: "Inundacion",
  DR: "Sequia",
  WF: "Incendio forestal",
  VO: "Erupcion volcanica",
  TS: "Tsunami",
};

export type AlertLevel = "Green" | "Orange" | "Red";

export interface GdacsEvent {
  type: string;
  typeName: string;
  name: string;
  country: string | null;
  /**
   * Paises afectados, separados de la lista que publica GDACS. Importa para
   * los eventos AREALES: una sequia que cubre 25 paises trae un solo centroide
   * y filtrarla por distancia la haria desaparecer para casi todos ellos.
   * El campo iso3 no sirve para esto: solo trae el primero de la lista.
   */
  countries: string[];
  alertLevel: AlertLevel;
  lat: number;
  lng: number;
  from: string;
  to: string;
  url: string | null;
}

interface GdacsFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    eventtype?: string;
    eventname?: string;
    name?: string;
    country?: string;
    alertlevel?: string;
    fromdate?: string;
    todate?: string;
    url?: { report?: string };
  };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Eventos de GDACS de los ultimos `days` dias. Devuelve el mundo entero en una
 * sola llamada (~140 KB) y el filtro por distancia se hace aca: pedirle a
 * GDACS por bounding box obliga a una request por punto y el catalogo es
 * chico, asi que conviene cachearlo global.
 */
export async function gdacsEvents(days: number): Promise<GdacsEvent[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const url =
    GDACS_BASE +
    "?fromDate=" + iso(from) +
    "&toDate=" + iso(to) +
    "&alertlevel=Green;Orange;Red";

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error("GDACS HTTP " + res.status);
  const body = (await res.json()) as { features?: GdacsFeature[] };

  const out: GdacsEvent[] = [];
  for (const f of body.features ?? []) {
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    if (!c || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const type = (p.eventtype ?? "").toUpperCase();
    const level = (p.alertlevel ?? "Green") as AlertLevel;
    out.push({
      type,
      typeName: GDACS_TYPES[type] ?? type,
      name: p.eventname || p.name || GDACS_TYPES[type] || "Evento",
      country: p.country ?? null,
      countries: (p.country ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      alertLevel: level,
      lat,
      lng,
      from: (p.fromdate ?? "").slice(0, 10),
      to: (p.todate ?? "").slice(0, 10),
      url: p.url?.report ?? null,
    });
  }
  return out;
}

export interface Quake {
  magnitude: number;
  depthKm: number | null;
  place: string;
  time: string;
  lat: number;
  lng: number;
  url: string | null;
  /** true si el sismo pudo sentirse en el punto: magnitud alta o muy cerca. */
  felt: boolean;
}

interface UsgsFeature {
  properties?: { mag?: number; place?: string; time?: number; url?: string };
  geometry?: { coordinates?: [number, number, number] };
}

/**
 * Sismos alrededor de un punto. Se consulta al catalogo por radio, que es la
 * unica forma de contestar "hubo temblores cerca" sin traerse el mundo.
 */
export async function quakesNear(
  lat: number,
  lng: number,
  radiusKm: number,
  days: number,
  minMagnitude: number,
): Promise<Quake[]> {
  const start = new Date(Date.now() - days * 86_400_000);
  const url =
    USGS_BASE +
    "?format=geojson&latitude=" + lat.toFixed(4) +
    "&longitude=" + lng.toFixed(4) +
    "&maxradiuskm=" + Math.round(radiusKm) +
    "&starttime=" + iso(start) +
    "&minmagnitude=" + minMagnitude +
    "&orderby=magnitude";

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error("USGS HTTP " + res.status);
  const body = (await res.json()) as { features?: UsgsFeature[] };

  return (body.features ?? [])
    .map((f) => {
      const c = f.geometry?.coordinates ?? [];
      const p = f.properties ?? {};
      const mag = Number(p.mag);
      return {
        magnitude: Number.isFinite(mag) ? Math.round(mag * 10) / 10 : 0,
        depthKm: Number.isFinite(Number(c[2])) ? Math.round(Number(c[2])) : null,
        place: p.place ?? "",
        time: p.time ? new Date(p.time).toISOString().slice(0, 10) : "",
        lat: Number(c[1]),
        lng: Number(c[0]),
        url: p.url ?? null,
        felt: false,
      };
    })
    .filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lng));
}

export interface Volcano {
  name: string;
  lat: number;
  lng: number;
  since: string;
  url: string | null;
}

interface EonetEvent {
  title?: string;
  link?: string;
  geometry?: Array<{ date?: string; type?: string; coordinates?: number[] }>;
}

/** Volcanes con actividad abierta segun la NASA. */
export async function activeVolcanoes(): Promise<Volcano[]> {
  const res = await fetch(EONET_BASE + "?status=open&category=volcanoes&limit=100", {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error("EONET HTTP " + res.status);
  const body = (await res.json()) as { events?: EonetEvent[] };

  const out: Volcano[] = [];
  for (const e of body.events ?? []) {
    // La ultima geometria es la posicion mas reciente reportada.
    const geoms = (e.geometry ?? []).filter((g) => g.type === "Point" && g.coordinates);
    const last = geoms[geoms.length - 1];
    if (!last?.coordinates || last.coordinates.length < 2) continue;
    const lng = Number(last.coordinates[0]);
    const lat = Number(last.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({
      name: e.title ?? "Volcan",
      lat,
      lng,
      since: (geoms[0]?.date ?? "").slice(0, 10),
      url: e.link ?? null,
    });
  }
  return out;
}

export interface TempSeries {
  dates: string[];
  max: Array<number | null>;
  min: Array<number | null>;
  /** Indice del primer dia de pronostico; antes de eso es observado. */
  forecastFrom: number;
}

/**
 * Temperaturas diarias: 60 dias hacia atras y 16 hacia adelante en UNA sola
 * llamada (`past_days` + `forecast_days`).
 *
 * El tramo pasado no es decorativo: es la referencia contra la que se mide si
 * lo que viene es una ola de calor. Un umbral absoluto no sirve —35 grados en
 * Sevilla es verano y en Ushuaia es imposible— y el clima del §1 responde la
 * normal de la epoca, no lo que viene. Con el percentil de los ultimos 60 dias
 * se detecta lo que es anomalo AHORA, que es lo que desorganiza una operacion.
 */
export async function tempSeries(lat: number, lng: number): Promise<TempSeries> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(3) +
    "&longitude=" + lng.toFixed(3) +
    "&daily=temperature_2m_max,temperature_2m_min&past_days=60&forecast_days=16&timezone=auto";

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error("Open-Meteo HTTP " + res.status);
  const body = (await res.json()) as {
    daily?: {
      time?: string[];
      temperature_2m_max?: Array<number | null>;
      temperature_2m_min?: Array<number | null>;
    };
  };
  const d = body.daily ?? {};
  const dates = d.time ?? [];
  const today = new Date().toISOString().slice(0, 10);
  let forecastFrom = dates.findIndex((x) => x >= today);
  if (forecastFrom < 0) forecastFrom = dates.length;

  return {
    dates,
    max: d.temperature_2m_max ?? [],
    min: d.temperature_2m_min ?? [],
    forecastFrom,
  };
}
