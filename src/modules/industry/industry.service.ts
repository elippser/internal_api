// Hub de factores de industria y sector especifico (event-list.md §16).
//
// LA PREGUNTA: POR QUE SE LLENA ESTE HOTEL CUANDO NO ES TEMPORADA
// Hay plazas cuya demanda no la explica el turismo. Un hotel en Anillaco se
// llena en vendimia; uno en Aniadama, con los turnos de la mina; uno en el
// medio de la nada, con los obreros de una represa. Esa demanda es ciclica,
// predecible y completamente invisible para los otros hubs, que miran ocio y
// negocios.
//
// SE INFIERE DEL USO DEL SUELO, NO DE UN DIRECTORIO
// No hay registro abierto de "que hace esta zona". Lo que si esta mapeado es
// como se usa la tierra: vinias, campos, canteras, pozos, aserraderos, plantas.
// De ahi sale la vocacion productiva, y de la vocacion sale el calendario: la
// vendimia cae en marzo en el hemisferio sur y en septiembre en el norte.
//
// LO QUE NO SE INVENTA
// Los rodajes de cine y las obras de infraestructura no tienen fuente abierta.
// Se declaran. Y la temporada de pesca o caza depende de una veda provincial
// que cambia todos los anios: se marca la ventana tipica y se dice que es
// aproximada, en vez de dar una fecha falsa con apariencia de exacta.

import { around, overpass, positionOf } from "../shared/overpass";
import { haversineKm } from "../connectivity/airports";
import { SEASONS, type Season } from "./seasons";
import type {
  IndustryCoverage,
  IndustryPointPayload,
  Vocation,
  VocationKey,
} from "./industry.types";

const CAP = 700;

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 300;
const TTL_OK = 7 * 24 * 60 * 60 * 1000;
const TTL_EMPTY = 5 * 60 * 1000;

/**
 * Cada vocacion con las etiquetas de OSM que la delatan y por que genera
 * demanda hotelera. El peso pondera cuanta demanda genera por unidad: una mina
 * mueve turnos rotativos de cientos de personas; una vinia, visitas.
 */
const VOCATIONS: Array<{
  key: VocationKey;
  label: string;
  why: string;
  weight: number;
  match: (t: Record<string, string>) => boolean;
}> = [
  {
    key: "wine",
    label: "Vitivinicola",
    why: "Turismo enologico y vendimia: demanda concentrada y con fecha",
    weight: 3,
    match: (t) => t.landuse === "vineyard" || t.craft === "winery" || t.industrial === "winery",
  },
  {
    key: "mining",
    label: "Mineria y energia",
    why: "Turnos rotativos: ocupacion alta, estable y de semana",
    weight: 8,
    match: (t) =>
      t.landuse === "quarry" ||
      t.man_made === "petroleum_well" ||
      t.man_made === "mineshaft" ||
      t.industrial === "mine" ||
      t.power === "plant",
  },
  {
    key: "agriculture",
    label: "Agropecuaria",
    why: "Cosecha y ferias rurales: picos cortos y muy marcados",
    weight: 1,
    match: (t) => t.landuse === "farmland" || t.landuse === "orchard" || t.landuse === "meadow",
  },
  {
    key: "fishing",
    label: "Pesca",
    why: "Temporada de pesca deportiva y flota de altura",
    weight: 3,
    match: (t) => t.industrial === "fishing" || t.seamark_type === "harbour" || t.harbour === "yes",
  },
  {
    key: "forestry",
    label: "Forestal",
    why: "Cuadrillas y aserraderos, con demanda de semana",
    weight: 2,
    match: (t) => t.landuse === "forest" || t.craft === "sawmill",
  },
  {
    key: "industry",
    label: "Industrial",
    why: "Proveedores y tecnicos en visita, demanda de dias habiles",
    weight: 4,
    match: (t) => t.landuse === "industrial" || t.man_made === "works",
  },
];

function query(lat: number, lng: number, radiusM: number): string {
  const a = around(radiusM, lat, lng);
  return (
    "[out:json][timeout:60];(" +
    'nwr["landuse"~"^(vineyard|quarry|farmland|orchard|forest|industrial|meadow)$"]' + a + ";" +
    'nwr["man_made"~"^(petroleum_well|mineshaft|works)$"]' + a + ";" +
    'nwr["craft"~"^(winery|sawmill)$"]' + a + ";" +
    'nwr["power"="plant"]' + a + ";" +
    'nwr["harbour"="yes"]' + a + ";" +
    ");out tags center " + CAP + ";"
  );
}

/**
 * Temporada de la vocacion en el hemisferio del punto. La vendimia cae en
 * marzo al sur y en septiembre al norte: no es un detalle, es medio anio de
 * diferencia.
 */
function seasonFor(key: VocationKey, lat: number): Season | null {
  const s = SEASONS[key];
  if (!s) return null;
  return lat < 0 ? s.south : s.north;
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export async function getIndustryPoint(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<IndustryPointPayload> {
  const gaps: string[] = [];
  const radiusM = Math.min(50_000, Math.round(radiusKm * 1000));

  const key = "ind:" + lat.toFixed(2) + ":" + lng.toFixed(2) + ":" + radiusM;
  const hit = store.get(key) as CacheEntry<Awaited<ReturnType<typeof overpass>>> | undefined;
  let elements: Awaited<ReturnType<typeof overpass>>;
  if (hit && Date.now() - hit.ts < (hit.value && hit.value.length ? TTL_OK : TTL_EMPTY)) {
    elements = hit.value;
  } else {
    elements = await overpass(query(lat, lng, radiusM));
    if (store.size >= CACHE_MAX) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { ts: Date.now(), value: elements });
  }

  const counts = new Map<VocationKey, number>();
  const nearestKm = new Map<VocationKey, number>();

  if (elements) {
    for (const e of elements) {
      const t = e.tags ?? {};
      const pos = positionOf(e);
      if (!pos) continue;
      const d = haversineKm(lat, lng, pos.lat, pos.lon);
      if (d > radiusKm) continue;
      for (const v of VOCATIONS) {
        if (!v.match(t)) continue;
        counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
        const cur = nearestKm.get(v.key);
        if (cur === undefined || d < cur) nearestKm.set(v.key, d);
      }
    }
  } else {
    gaps.push("Overpass no respondio: sin lectura del uso del suelo");
  }

  const month = new Date().getUTCMonth() + 1;

  const vocations: Vocation[] = VOCATIONS.filter((v) => (counts.get(v.key) ?? 0) > 0)
    .map((v) => {
      const count = counts.get(v.key) ?? 0;
      const season = seasonFor(v.key, lat);
      return {
        key: v.key,
        label: v.label,
        why: v.why,
        count,
        nearestKm: Math.round(nearestKm.get(v.key) ?? 0),
        // El peso convierte "cuantos hay" en "cuanta demanda mueve": una mina
        // pesa mas que una hectarea de campo.
        demandWeight: count * v.weight,
        season: season
          ? {
              months: season.months,
              label: season.months.map((m) => MONTHS[m - 1]).join(", "),
              inSeason: season.months.includes(month),
              note: season.note,
              approximate: season.approximate,
            }
          : null,
      };
    })
    .sort((a, b) => b.demandWeight - a.demandWeight);

  const dominant = vocations[0] ?? null;
  const active = vocations.filter((v) => v.season?.inSeason);

  gaps.push("Rodajes de cine y series: no hay registro abierto de permisos de filmacion");
  gaps.push("Obras de infraestructura: los pliegos son publicos pero no hay feed que los agregue");
  gaps.push(
    "Las temporadas son tipicas del hemisferio, no la veda vigente: pesca y caza las fija cada provincia y cambian todos los anios",
  );
  gaps.push("Ferias agropecuarias: las grandes ya estan en el hub MICE del §5");
  gaps.push(
    "El uso del suelo dice que se produce, no cuanta gente emplea: una mina mapeada puede estar cerrada",
  );

  const coverage: IndustryCoverage = {
    census: elements !== null,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    hemisphere: lat < 0 ? "south" : "north",
    vocations,
    dominant: dominant ? dominant.label : null,
    inSeasonNow: active.map((v) => v.label),
    coverage,
    sources: [
      "OpenStreetMap Overpass (uso del suelo)",
      "Calendario productivo curado por hemisferio",
    ],
    timestamp: new Date().toISOString(),
  };
}
