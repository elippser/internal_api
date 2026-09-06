// Hub de ubicacion y entorno fisico (event-list.md §12).
//
// EL UNICO HUB QUE SE MIDE CAMINANDO
// Los otros trabajan con radios de cientos de kilometros. Aca la unidad es la
// cuadra: a un alojamiento urbano lo define lo que hay a diez minutos a pie.
// Radio por defecto 1 km, maximo 5.
//
// DOS NUMEROS DERIVADOS, Y POR QUE SE PUBLICAN ABIERTOS
// `walkability` y `noise` no existen como dato: se calculan. Un puntaje
// inventado y sin explicar es exactamente el tipo de cosa que despues nadie
// puede auditar, asi que los dos viajan con sus COMPONENTES y sus FUENTES en
// el payload. El de ruido, ademas, es geometria y no una medicion acustica:
// dice que hay una autopista a 200 m, no cuantos decibeles entran por la
// ventana.
//
// LO QUE NO SE INVENTA
// "Percepcion de seguridad del barrio" no tiene fuente abierta a escala de
// cuadra — el §9 llega hasta el pais — y no se deriva del tono de las
// noticias ni de la renta del barrio. Queda declarado.

import { around, overpass, positionOf, type OverpassElement } from "../shared/overpass";
import { airportsNear, haversineKm } from "../connectivity/airports";
import type {
  DensityCounts,
  NoiseEstimate,
  Nearby,
  PlaceCoverage,
  PlacePointPayload,
  Proximity,
  ViewHints,
  Walkability,
} from "./place.types";

const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const UA = "roombir-internal-place-hub/1.0 (+https://roombir.com)";

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 300;
const TTL_OK = 7 * 24 * 60 * 60 * 1000;
const TTL_EMPTY = 5 * 60 * 1000;
// El relieve no cambia.
const TTL_ELEV = 90 * 24 * 60 * 60 * 1000;

const CAP = 900;

/**
 * Una sola consulta para todo el entorno. Los radios son distintos por
 * categoria a proposito: un bar importa a 300 m y una montania a 20 km, y
 * pedirlos por separado serian seis requests a un servicio que ya se cae solo.
 */
function query(lat: number, lng: number, radiusM: number): string {
  const a = around(radiusM, lat, lng);
  const wide = around(Math.max(radiusM, 20_000), lat, lng);
  return (
    "[out:json][timeout:60];(" +
    'nwr["amenity"~"^(restaurant|cafe|bar|pub|nightclub|fast_food)$"]' + a + ";" +
    'nwr["shop"]' + a + ";" +
    'nwr["office"]' + a + ";" +
    'nwr["leisure"="park"]' + a + ";" +
    'nwr["tourism"~"^(attraction|museum)$"]' + a + ";" +
    'nwr["amenity"~"^(university|hospital|conference_centre|exhibition_centre)$"]' + a + ";" +
    'node["railway"~"^(station|halt|tram_stop)$"]' + a + ";" +
    'node["highway"="bus_stop"]' + a + ";" +
    'nwr["amenity"="bus_station"]' + a + ";" +
    'node["highway"="crossing"]' + a + ";" +
    'way["highway"~"^(footway|pedestrian|living_street)$"]' + a + ";" +
    'way["highway"~"^(motorway|trunk)$"]' + a + ";" +
    // Naturales: radio ancho, son referencias de paisaje, no de caminata.
    'nwr["natural"="beach"]' + wide + ";" +
    'nwr["natural"="peak"]' + wide + ";" +
    'nwr["natural"="water"]' + wide + ";" +
    ");out tags center " + CAP + ";"
  );
}

async function census(lat: number, lng: number, radiusM: number): Promise<OverpassElement[] | null> {
  const key = "place:" + lat.toFixed(3) + ":" + lng.toFixed(3) + ":" + radiusM;
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

/** Altura del punto y de cuatro puntos a ~2 km, para estimar el desnivel. */
async function elevation(lat: number, lng: number): Promise<{ here: number; around: number[] } | null> {
  const key = "elev:" + lat.toFixed(2) + ":" + lng.toFixed(2);
  const hit = store.get(key) as CacheEntry<{ here: number; around: number[] } | null> | undefined;
  if (hit && Date.now() - hit.ts < TTL_ELEV) return hit.value;

  const d = 0.02; // ~2 km
  const lats = [lat, lat + d, lat - d, lat, lat];
  const lngs = [lng, lng, lng, lng + d, lng - d];
  try {
    const res = await fetch(
      ELEVATION_URL + "?latitude=" + lats.join(",") + "&longitude=" + lngs.join(","),
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) throw new Error("elevation HTTP " + res.status);
    const body = (await res.json()) as { elevation?: number[] };
    const e = body.elevation ?? [];
    if (!e.length) throw new Error("sin datos de elevacion");
    const value = { here: e[0], around: e.slice(1) };
    store.set(key, { ts: Date.now(), value });
    return value;
  } catch {
    store.set(key, { ts: Date.now(), value: null });
    return null;
  }
}

const round = (n: number, d = 2): number => Number(n.toFixed(d));

/** Guarda el mas cercano de cada categoria mientras se recorre el censo. */
function closer(current: Nearby | null, name: string | null, distanceM: number): Nearby {
  if (current && current.distanceM <= distanceM) return current;
  return { name, distanceM };
}

const scale = (value: number, full: number): number =>
  Math.max(0, Math.min(1, value / full));

export async function getPlacePoint(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<PlacePointPayload> {
  const gaps: string[] = [];
  const radiusM = Math.min(5000, Math.round(radiusKm * 1000));

  const [elements, elev, airports] = await Promise.all([
    census(lat, lng, radiusM),
    elevation(lat, lng),
    airportsNear(lat, lng, 100).catch(() => []),
  ]);

  const proximity: Proximity = {
    attraction: null, museum: null, park: null, beach: null, water: null, peak: null,
    university: null, hospital: null, conventionCentre: null, transitStop: null,
    busTerminal: null, airport: null,
  };

  const density: DensityCounts = {
    gastronomy: 0, nightlife: 0, shops: 0, offices: 0, chains: 0, chainNames: [],
  };

  const chainSet = new Set<string>();
  let crossings = 0;
  let pedestrianWays = 0;
  let transitStops = 0;
  let motorwayDistanceM: number | null = null;
  let taggedAccessible = 0;
  let taggedTotal = 0;

  if (elements) {
    for (const e of elements) {
      const t = e.tags ?? {};
      const pos = positionOf(e);
      const dist = pos ? Math.round(haversineKm(lat, lng, pos.lat, pos.lon) * 1000) : Number.NaN;
      const name = t.name ?? null;

      // Accesibilidad: solo cuenta lo que ALGUIEN etiqueto, en un sentido o en
      // el otro. Sin etiqueta no se asume nada.
      if (t.wheelchair) {
        taggedTotal++;
        if (t.wheelchair === "yes") taggedAccessible++;
      }

      const amenity = t.amenity;
      if (amenity === "restaurant" || amenity === "cafe" || amenity === "fast_food") {
        density.gastronomy++;
      } else if (amenity === "bar" || amenity === "pub" || amenity === "nightclub") {
        density.nightlife++;
      } else if (amenity === "university") {
        proximity.university = closer(proximity.university, name, dist);
      } else if (amenity === "hospital") {
        proximity.hospital = closer(proximity.hospital, name, dist);
      } else if (amenity === "conference_centre" || amenity === "exhibition_centre") {
        proximity.conventionCentre = closer(proximity.conventionCentre, name, dist);
      } else if (amenity === "bus_station") {
        proximity.busTerminal = closer(proximity.busTerminal, name, dist);
      }

      if (t.shop) density.shops++;
      if (t.office) density.offices++;
      if (t.leisure === "park") proximity.park = closer(proximity.park, name, dist);
      if (t.tourism === "attraction") proximity.attraction = closer(proximity.attraction, name, dist);
      if (t.tourism === "museum") proximity.museum = closer(proximity.museum, name, dist);
      if (t.natural === "beach") proximity.beach = closer(proximity.beach, name, dist);
      if (t.natural === "water") proximity.water = closer(proximity.water, name, dist);
      if (t.natural === "peak") proximity.peak = closer(proximity.peak, name, dist);

      if (t.railway || t.highway === "bus_stop") {
        transitStops++;
        proximity.transitStop = closer(proximity.transitStop, name, dist);
      }
      if (t.highway === "crossing") crossings++;
      if (t.highway === "footway" || t.highway === "pedestrian" || t.highway === "living_street") {
        pedestrianWays++;
      }
      if (t.highway === "motorway" || t.highway === "trunk") {
        if (Number.isFinite(dist) && (motorwayDistanceM === null || dist < motorwayDistanceM)) {
          motorwayDistanceM = dist;
        }
      }

      // Marca reconocible: la lista la nombra como senial de zona transitada.
      const brand = t.brand;
      if (brand && (amenity === "cafe" || amenity === "fast_food" || t.shop)) {
        density.chains++;
        chainSet.add(brand);
      }
    }
  } else {
    gaps.push("Overpass no respondio: no hay censo del entorno. No es que no haya nada alrededor");
  }

  density.chainNames = [...chainSet].sort().slice(0, 8);

  // Aeropuerto: del catalogo del §7, que es un censo real y no depende de OSM.
  const ap = airports.filter((a) => a.scheduledService)[0];
  if (ap) {
    proximity.airport = {
      name: ap.name,
      distanceM: Math.round(ap.distanceKm * 1000),
      iata: ap.iata,
    };
  }

  // ── Caminabilidad ──
  const areaKm2 = Math.PI * (radiusM / 1000) ** 2;
  const amenityDensity = areaKm2 ? (density.gastronomy + density.shops) / areaKm2 : 0;
  const walk: Walkability = {
    score: 0,
    components: {
      // 150 comercios por km2 es un centro urbano consolidado.
      amenities: round(scale(amenityDensity, 150), 2),
      // Cruces y veredas mapeadas: mide si el barrio esta pensado para el peaton.
      pedestrian: round(scale(crossings + pedestrianWays, 120), 2),
      transit: round(scale(transitStops, 25), 2),
    },
    label: "",
  };
  walk.score = Math.round(
    (walk.components.amenities * 0.5 +
      walk.components.pedestrian * 0.3 +
      walk.components.transit * 0.2) *
      100,
  );
  walk.label =
    walk.score >= 75 ? "Todo a pie" :
    walk.score >= 50 ? "Mayormente caminable" :
    walk.score >= 25 ? "Se camina algo" : "Depende del auto";

  // ── Ruido ──
  const noiseSources: string[] = [];
  let noiseScore = 0;
  if (motorwayDistanceM !== null && motorwayDistanceM < 500) {
    noiseScore += 40 * (1 - motorwayDistanceM / 500);
    noiseSources.push("autopista a " + motorwayDistanceM + " m");
  }
  if (proximity.airport && proximity.airport.distanceM < 15_000) {
    noiseScore += 30 * (1 - proximity.airport.distanceM / 15_000);
    noiseSources.push(
      "aeropuerto a " + Math.round(proximity.airport.distanceM / 1000) + " km",
    );
  }
  if (density.nightlife > 0) {
    noiseScore += Math.min(30, density.nightlife * 1.5);
    noiseSources.push(density.nightlife + " locales nocturnos");
  }
  const noise: NoiseEstimate = {
    score: Math.round(Math.min(100, noiseScore)),
    label: "",
    sources: noiseSources,
  };
  noise.label =
    noise.score >= 60 ? "Ruidoso" :
    noise.score >= 30 ? "Con ruido de fondo" : "Tranquilo";

  // ── Vista ──
  const hints: string[] = [];
  let reliefM: number | null = null;
  if (elev && elev.around.length) {
    const avg = elev.around.reduce((s, v) => s + v, 0) / elev.around.length;
    reliefM = Math.round(elev.here - avg);
    if (reliefM >= 30) hints.push("El punto esta " + reliefM + " m por encima de su entorno");
  }
  if (proximity.beach && proximity.beach.distanceM < 2000) hints.push("Playa a menos de 2 km");
  if (proximity.water && proximity.water.distanceM < 1500) hints.push("Agua a la vista posible");
  if (proximity.peak && proximity.peak.distanceM < 25_000) {
    hints.push("Montania a " + Math.round(proximity.peak.distanceM / 1000) + " km");
  }
  if (density.offices > 40) hints.push("Zona de torres: skyline probable");
  const view: ViewHints = { elevationM: elev ? Math.round(elev.here) : null, reliefM, hints };

  // ── Perfil ──
  const traits: string[] = [];
  if (density.gastronomy >= 40) traits.push("gastronomico");
  if (density.nightlife >= 15) traits.push("con vida nocturna");
  if (density.offices >= 40) traits.push("de oficinas");
  if (proximity.attraction && proximity.attraction.distanceM < 800) traits.push("turistico");
  if (walk.score >= 60) traits.push("caminable");
  if (noise.score < 30) traits.push("tranquilo");
  const profile = traits.length
    ? "Entorno " + traits.join(", ")
    : "Entorno sin rasgos dominantes en el radio consultado";

  // ── Gaps ──
  if (elements && elements.length >= CAP) {
    gaps.push("Overpass corto en " + CAP + " elementos: las densidades son un piso");
  }
  // Un censo vacio es legitimo en el oceano y sospechoso en un lugar habitado.
  // El aeropuerto del §7 sirve de senial de "aca vive gente": si hay uno con
  // vuelos a menos de 100 km y el entorno dio cero, el problema es la fuente.
  // Sin esto, Bariloche —que tiene aeropuerto a 13 km— aparecia como un paramo
  // sin un solo comercio.
  const populated = proximity.airport !== null;
  const emptyCensus = elements !== null && elements.length === 0;
  if (emptyCensus && populated) {
    gaps.push(
      "Overpass devolvio vacio en un punto con aeropuerto cerca: el relevamiento del entorno no es confiable aca, no es que no haya nada",
    );
  }
  if (!elev) gaps.push("Sin datos de elevacion: los indicios de vista quedan incompletos");
  gaps.push(
    "Percepcion de seguridad del barrio: no hay fuente abierta a escala de cuadra. El §9 llega hasta el pais y no se deriva de otra cosa",
  );
  gaps.push(
    "Ruido: es geometria, no acustica. Dice que hay una autopista a 200 m, no cuantos decibeles entran por la ventana",
  );
  gaps.push(
    "Vista: depende del piso y la orientacion del cuarto, que ningun mapa sabe. Solo se indica si hay algo que mirar",
  );
  gaps.push(
    "Accesibilidad: sale de la etiqueta wheelchair de OSM, que muy pocos lugares completan",
  );

  const coverage: PlaceCoverage = {
    // Un vacio sospechoso no cuenta como censo: el panel no debe dibujar ceros.
    census: elements !== null && !(emptyCensus && populated),
    elevation: elev !== null,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    proximity,
    density,
    walkability: walk,
    noise,
    view,
    accessibility: {
      taggedAccessible,
      taggedTotal,
      share: taggedTotal ? round(taggedAccessible / taggedTotal, 2) : null,
    },
    profile,
    coverage,
    sources: [
      "OpenStreetMap Overpass (entorno)",
      "Open-Meteo (elevacion)",
      "OurAirports (aeropuerto de referencia)",
    ],
    timestamp: new Date().toISOString(),
  };
}
