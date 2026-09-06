// Hub de oferta hotelera y competencia (event-list.md §11).
//
// LO QUE ESTE HUB PUEDE CONTESTAR, Y LO QUE NO
// OpenStreetMap tiene un censo decente de QUE alojamientos existen alrededor
// de un punto. No tiene su tamanio: sobre 250 establecimientos en Buenos
// Aires, 12 declaran estrellas y 2 el numero de habitaciones. Por eso se
// cuentan ESTABLECIMIENTOS y nunca plazas — una cifra de plazas extrapolada de
// dos datos seria invento, no estimacion.
//
// Y tampoco tiene aperturas ni cierres. La tentacion era usar el timestamp de
// OSM como proxy de "hotel nuevo", pero se midio: 246 de 250 elementos fueron
// editados en el ultimo anio y el ejemplo iba por la version 11. Un timestamp
// dice cuando alguien MAPEO el hotel, no cuando abrio. Detectar aperturas pide
// comparar dos censos nuestros en el tiempo, y eso es ingesta con historial.
//
// LA LECTURA QUE SI APORTA
// Los sustitutos (hostels, apartamentos, glamping) y la regulacion del
// alquiler temporario se leen JUNTOS. Mucha oferta sustituta sin regulacion es
// un entorno competitivo completamente distinto al de una ciudad que la
// prohibio — y las dos cosas son items separados de la lista que en la
// practica son uno solo.

import { around, overpass, positionOf, type OverpassElement } from "../shared/overpass";
import { haversineKm } from "../connectivity/airports";
import { strRulesNear } from "../policy/regulation";
import type {
  Chain,
  LodgingCount,
  LodgingKind,
  StrRule,
  SupplyCoverage,
  SupplyPointPayload,
} from "./supply.types";

const KIND_LABEL: Record<LodgingKind, string> = {
  hotel: "Hoteles",
  hostel: "Hostels",
  guest_house: "Casas de huespedes",
  motel: "Moteles",
  apartment: "Apartamentos turisticos",
  chalet: "Cabanias y chalets",
  camp_site: "Camping y glamping",
};

/** Todo lo que compite con un hotel sin ser un hotel. */
const SUBSTITUTE_KINDS = new Set<LodgingKind>([
  "hostel",
  "guest_house",
  "apartment",
  "chalet",
  "camp_site",
  "motel",
]);

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 300;

// Un censo bueno dura una semana; uno vacio o caido, cinco minutos. Misma
// leccion que el §7: cachear largo un cero transitorio de Overpass equivale a
// afirmar que no hay hoteles.
const TTL_OK = 7 * 24 * 60 * 60 * 1000;
const TTL_EMPTY = 5 * 60 * 1000;

const CAP = 900;

function query(lat: number, lng: number, radiusM: number): string {
  const a = around(radiusM, lat, lng);
  return (
    "[out:json][timeout:60];(" +
    'nwr["tourism"~"^(hotel|hostel|guest_house|motel|apartment|chalet|camp_site)$"]' + a + ";" +
    ");out tags center " + CAP + ";"
  );
}

async function census(lat: number, lng: number, radiusM: number): Promise<OverpassElement[] | null> {
  const key = "supply:" + lat.toFixed(2) + ":" + lng.toFixed(2) + ":" + radiusM;
  const hit = store.get(key) as CacheEntry<OverpassElement[] | null> | undefined;
  if (hit) {
    const good = hit.value !== null && hit.value.length > 0;
    if (Date.now() - hit.ts < (good ? TTL_OK : TTL_EMPTY)) return hit.value;
  }
  const value = await overpass(query(lat, lng, radiusM));
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { ts: Date.now(), value });
  return value;
}

const round = (n: number, d = 2): number => Number(n.toFixed(d));

export async function getSupplyPoint(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<SupplyPointPayload> {
  const gaps: string[] = [];
  const radiusM = Math.min(30_000, Math.round(radiusKm * 1000));

  const elements = await census(lat, lng, radiusM);

  const counts = new Map<LodgingKind, number>();
  const brands = new Map<string, number>();
  let total = 0;
  let chainCount = 0;

  if (elements) {
    for (const e of elements) {
      const tags = e.tags ?? {};
      const kind = tags.tourism as LodgingKind | undefined;
      if (!kind || !(kind in KIND_LABEL)) continue;
      const pos = positionOf(e);
      // Overpass ya filtro por radio, pero una via grande puede tener su
      // centro apenas afuera: se vuelve a chequear para que el conteo case con
      // el radio que se muestra.
      if (pos && haversineKm(lat, lng, pos.lat, pos.lon) > radiusKm) continue;

      total++;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);

      const brand = tags.brand || tags.operator;
      if (brand) {
        chainCount++;
        brands.set(brand, (brands.get(brand) ?? 0) + 1);
      }
    }
  }

  const byKind: LodgingCount[] = (Object.keys(KIND_LABEL) as LodgingKind[])
    .map((kind) => ({ kind, label: KIND_LABEL[kind], count: counts.get(kind) ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  let substituteCount = 0;
  for (const [kind, n] of counts) if (SUBSTITUTE_KINDS.has(kind)) substituteCount += n;

  const top: Chain[] = [...brands.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);

  const areaKm2 = Math.PI * radiusKm * radiusKm;

  const strRegulation: StrRule[] = strRulesNear(lat, lng, haversineKm).map((r) => ({
    city: r.city,
    severity: r.severity,
    summary: r.summary,
    asOf: r.asOf,
    distanceKm: r.distanceKm,
  }));

  const truncated = Boolean(elements && elements.length >= CAP);

  // ── Gaps ──
  if (elements === null) {
    gaps.push("Overpass no respondio: no hay censo de oferta. No es que no haya hoteles");
  } else if (total === 0) {
    gaps.push("Sin alojamientos mapeados en el radio: puede ser zona sin oferta o sin mapear");
  }
  if (truncated) {
    gaps.push("Overpass corto en " + CAP + " elementos: los conteos son un piso, no el total");
  }
  gaps.push(
    "Plazas y categoria: OSM casi no las publica (en pruebas, 12 de 250 con estrellas y 2 con habitaciones). Se cuentan establecimientos, no camas",
  );
  gaps.push(
    "Aperturas y cierres: el timestamp de OSM dice cuando se mapeo, no cuando abrio. Detectarlas pide comparar censos propios en el tiempo",
  );
  gaps.push("Oferta de Airbnb: no hay API publica; OSM solo ve lo que alguien mapeo como apartamento");
  gaps.push("Cambios de bandera o marca: se ve la marca actual, no su historial");
  if (!strRegulation.length) {
    gaps.push("Sin norma de alquiler temporario relevada: la tabla curada cubre las plazas grandes");
  }

  const coverage: SupplyCoverage = {
    census: elements !== null,
    truncated,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    total,
    byKind,
    substitutes: {
      count: substituteCount,
      share: total ? round(substituteCount / total, 3) : 0,
    },
    chains: {
      count: chainCount,
      share: total ? round(chainCount / total, 3) : 0,
      top,
    },
    densityPerKm2: areaKm2 ? round(total / areaKm2, 2) : 0,
    strRegulation,
    coverage,
    sources: [
      "OpenStreetMap Overpass (censo de alojamientos)",
      "Tabla curada de regulacion de alquiler temporario (§8)",
    ],
    timestamp: new Date().toISOString(),
  };
}
