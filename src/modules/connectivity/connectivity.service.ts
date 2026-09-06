// Hub de conectividad y transporte (event-list.md §7).
//
// LA PREGUNTA QUE CONTESTA
// El §6 dice para que mercados el destino esta barato. Este dice cuales de
// esos mercados pueden efectivamente LLEGAR. Un mercado barato sin vuelo
// directo convierte mucho peor que uno caro con vuelo diario: la demanda
// necesita un asiento donde entrar. De ahi que el cruce con los emisores del
// hub economico sea el remate del payload y no un anexo.
//
// ESTRUCTURA VS OBSERVACION, Y POR QUE NO SE MEZCLAN
// Hay dos clases de dato aca y tienen garantias distintas:
//
//   · ESTRUCTURA (OurAirports, Overpass): que aeropuertos y terminales
//     existen. Es un censo, esta completo y no cambia de un dia para otro.
//   · OBSERVACION (ADS-B en vivo): que estaba volando durante la consulta.
//     Es una muestra instantanea. A las 3 de la manana sobre Buenos Aires hay
//     cinco aviones; al mediodia, cuarenta.
//
// Mezclarlas llevaria al error mas caro posible en esta categoria: concluir
// que no hay vuelo directo desde Brasil porque en ese instante no habia
// ninguno en el aire. Por eso `DirectFlightStatus` solo puede valer "observed"
// o "unknown" — no existe el valor "no hay". Una muestra prueba presencias,
// nunca ausencias.
//
// PRESUPUESTO DE REQUESTS
// El catalogo de aeropuertos se baja una vez por proceso. adsbdb se consulta
// una vez por callsign y se cachea largo, porque un callsign es una ruta fija:
// ARG1300 siempre es Ezeiza -> JFK. Asi el uso repetido del hub va enriqueciendo
// el mapa de rutas en vez de repetir trabajo.

import { fetchJson } from "../intelligence/core/http";
// El cliente de Overpass vive en shared/: sus modos de falla (200 con remark,
// espejos que devuelven vacio sin avisar) estan resueltos ahi una sola vez.
import { overpass, type OverpassElement } from "../shared/overpass";
import { airportsNear, byIcao, haversineKm, type NearbyAirport } from "./airports";
import { isCargo, isCommercialType, seatsFor } from "./aircraft";
import { COUNTRY_NAME, emittersFor } from "../economy/reference";
import type {
  Airport,
  AirliftTier,
  ConnectivityCoverage,
  ConnectivityPointPayload,
  DirectFlightStatus,
  EmitterLink,
  GroundNode,
  GroundTransport,
  LiveAirlift,
  ObservedRoute,
} from "./connectivity.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const ADSB_POINT_BASE = "https://api.adsb.lol/v2/point";
const ADSBDB_BASE = "https://api.adsbdb.com/v0/callsign";

/**
 * Identificarse es requisito, no cortesia: adsb.lol devuelve 403 al
 * user-agent por defecto de Node y Overpass pide uno descriptivo. El codigo
 * portado de elippser resuelve esto falsificando IPs residenciales
 * (lib/stealthFetch); aca no se hace eso — son APIs publicas y gratuitas, y
 * corresponde decir quien las esta usando.
 */
const UA = "roombir-internal-connectivity-hub/1.0 (+https://roombir.com)";

// ── Cache con TTL ─────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 3000;

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

const TTL_GEO = 30 * 24 * 60 * 60 * 1000;
// Un callsign es una ruta fija: cachearlo un mes es lo que hace que el mapa de
// rutas se vaya enriqueciendo con el uso en vez de empezar de cero cada vez.
const TTL_ROUTE = 30 * 24 * 60 * 60 * 1000;
const TTL_GROUND = 7 * 24 * 60 * 60 * 1000;
// Un censo vacio o caido se reintenta pronto: casi siempre es Overpass, no el
// territorio.
const TTL_GROUND_EMPTY = 5 * 60 * 1000;
// El trafico en vivo es justamente lo que cambia: cache corta, solo para no
// castigar dos aperturas seguidas del panel.
const TTL_LIVE = 3 * 60 * 1000;

// ── Geocoding inverso ─────────────────────────────────────────────────────

async function resolveCountry(lat: number, lng: number) {
  const key = "geo:" + lat.toFixed(1) + ":" + lng.toFixed(1);
  return memo(key, TTL_GEO, async () => {
    const data = await fetchJson<{ address?: Record<string, string> }>(
      NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=5&addressdetails=1",
      {
        headers: { "user-agent": "roombir-internal-connectivity-hub/1.0" },
        timeoutMs: 12_000,
        retries: 1,
      },
    );
    const addr = data.address ?? {};
    return {
      countryCode: (addr.country_code ?? "").toUpperCase(),
      countryName: addr.country ?? "",
    };
  });
}

// ── Trafico en vivo (ADS-B) ───────────────────────────────────────────────

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
}

/**
 * Aeronaves alrededor de un punto. adsb.lol toma el radio en millas nauticas y
 * lo topea en 250, que a esta escala es justo lo que se quiere: un radio
 * amplio agarra los vuelos que estan por aterrizar y los que acaban de
 * despegar, no solo los que estan encima del aeropuerto.
 */
async function aircraftAround(lat: number, lng: number, radiusNm: number): Promise<AdsbAircraft[]> {
  const nm = Math.min(250, Math.max(10, Math.round(radiusNm)));
  const key = "adsb:" + lat.toFixed(2) + ":" + lng.toFixed(2) + ":" + nm;
  return memo(key, TTL_LIVE, async () => {
    const data = await fetchJson<{ ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] }>(
      ADSB_POINT_BASE + "/" + lat.toFixed(4) + "/" + lng.toFixed(4) + "/" + nm,
      { timeoutMs: 20_000, retries: 1, headers: { "user-agent": UA } },
    );
    return data.ac ?? data.aircraft ?? [];
  });
}

interface AdsbdbResponse {
  response?: {
    flightroute?: {
      airline?: { name?: string };
      origin?: { iata_code?: string; name?: string; country_iso_name?: string; icao_code?: string };
      destination?: { iata_code?: string; name?: string; country_iso_name?: string; icao_code?: string };
    };
  };
}

/** Callsign -> ruta. Devuelve null cuando adsbdb no la conoce (404 habitual). */
async function routeFor(callsign: string): Promise<AdsbdbResponse["response"] | null> {
  return memo("route:" + callsign, TTL_ROUTE, async () => {
    try {
      const data = await fetchJson<AdsbdbResponse>(
        ADSBDB_BASE + "/" + encodeURIComponent(callsign),
        { timeoutMs: 12_000, retries: 0, headers: { "user-agent": UA } },
      );
      return data.response ?? null;
    } catch {
      // Un callsign desconocido es lo normal, no un fallo del hub.
      return null;
    }
  });
}

/** Corre las promesas de a tandas, para no dispararle 40 requests juntos a adsbdb. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

// ── Transporte terrestre (Overpass) ───────────────────────────────────────

const GROUND_CAP = 600;

function overpassQuery(lat: number, lng: number, radiusM: number): string {
  const a = "(around:" + radiusM + "," + lat.toFixed(4) + "," + lng.toFixed(4) + ")";
  return (
    "[out:json][timeout:50];(" +
    'node["railway"="station"]' + a + ";" +
    'node["station"="subway"]' + a + ";" +
    'nwr["amenity"="bus_station"]' + a + ";" +
    'nwr["amenity"="ferry_terminal"]' + a + ";" +
    'nwr["amenity"="car_rental"]' + a + ";" +
    'nwr["barrier"="border_control"]' + a + ";" +
    ");out tags center " + GROUND_CAP + ";"
  );
}

const emptyNode = (): GroundNode => ({ count: 0, nearestName: null, nearestKm: null });

/** true si no se encontro NADA. En un punto habitado eso delata a la fuente. */
function isEmptyGround(g: GroundTransport): boolean {
  return (
    g.train.count === 0 &&
    g.subway.count === 0 &&
    g.busTerminal.count === 0 &&
    g.ferry.count === 0 &&
    g.carRental.count === 0 &&
    g.borderCrossing.count === 0
  );
}

async function groundTransport(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<GroundTransport> {
  const radiusM = Math.min(50_000, Math.round(radiusKm * 1000));
  const key = "ground:" + lat.toFixed(1) + ":" + lng.toFixed(1) + ":" + radiusM;

  // El TTL depende del RESULTADO, no del pedido. Un censo que salio bien dura
  // una semana; uno vacio o fallido dura minutos. Cachear siete dias un cero
  // transitorio de Overpass fue exactamente el bug que dejo a Madrid sin
  // estaciones de tren, y no se nota porque no falla: miente en silencio.
  const hit = store.get(key) as CacheEntry<GroundTransport> | undefined;
  if (hit) {
    const fresh = hit.value.available && !isEmptyGround(hit.value);
    if (Date.now() - hit.ts < (fresh ? TTL_GROUND : TTL_GROUND_EMPTY)) return hit.value;
  }

  return memo(key, 0, async () => {
    const elements = await overpass(overpassQuery(lat, lng, radiusM));
    const out: GroundTransport = {
      train: emptyNode(),
      subway: emptyNode(),
      busTerminal: emptyNode(),
      ferry: emptyNode(),
      carRental: emptyNode(),
      borderCrossing: emptyNode(),
      truncated: false,
      available: elements !== null,
    };
    if (!elements) return out;

    out.truncated = elements.length >= GROUND_CAP;

    for (const e of elements) {
      const t = e.tags ?? {};
      const p = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
      if (!p) continue;

      let bucket: GroundNode | null = null;
      // El subte se chequea primero: una estacion de subte tambien lleva
      // railway=station y caeria en tren.
      if (t.station === "subway") bucket = out.subway;
      else if (t.railway === "station") bucket = out.train;
      else if (t.amenity === "bus_station") bucket = out.busTerminal;
      else if (t.amenity === "ferry_terminal") bucket = out.ferry;
      else if (t.amenity === "car_rental") bucket = out.carRental;
      else if (t.barrier === "border_control") bucket = out.borderCrossing;
      if (!bucket) continue;

      bucket.count++;
      const d = haversineKm(lat, lng, p.lat, p.lon);
      if (bucket.nearestKm === null || d < bucket.nearestKm) {
        bucket.nearestKm = Math.round(d * 10) / 10;
        bucket.nearestName = t.name ?? null;
      }
    }
    return out;
  });
}

// ── Jerarquia aerea ───────────────────────────────────────────────────────

/**
 * Jerarquia por TAMANO de instalacion, que es lo unico que sabe OurAirports.
 * No dice si hay vuelos internacionales: Bariloche y Ezeiza son las dos
 * . El alcance se responde aparte, con rutas observadas.
 */
function tierOf(nearby: NearbyAirport[]): AirliftTier {
  const withService = nearby.filter((a) => a.scheduledService);
  if (!withService.length) return "none";
  if (withService.some((a) => a.type === "large_airport")) return "major";
  if (withService.some((a) => a.type === "medium_airport")) return "regional";
  return "local";
}

const toAirport = (a: NearbyAirport): Airport => ({
  ident: a.ident,
  name: a.name,
  type: a.type,
  iata: a.iata,
  icao: a.icao,
  municipality: a.municipality,
  country: a.country,
  scheduledService: a.scheduledService,
  distanceKm: a.distanceKm,
});

// ── Endpoint ──────────────────────────────────────────────────────────────

export async function getConnectivityPoint(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<ConnectivityPointPayload> {
  const gaps: string[] = [];

  const [geo, nearby] = await Promise.all([
    resolveCountry(lat, lng).catch(() => ({ countryCode: "", countryName: "" })),
    airportsNear(lat, lng, radiusKm),
  ]);

  const withScheduled = nearby.filter((a) => a.scheduledService);
  // El aeropuerto de referencia es el mas jerarquico con servicio, no el mas
  // cercano: un aerodromo a 5 km sin vuelos no explica nada del turismo.
  const rank = { large_airport: 3, medium_airport: 2, small_airport: 1 } as const;
  const primary =
    [...withScheduled].sort(
      (a, b) => rank[b.type] - rank[a.type] || a.distanceKm - b.distanceKm,
    )[0] ?? null;

  // ── Observacion en vivo alrededor del aeropuerto de referencia ──
  let airlift: LiveAirlift | null = null;
  let observed: ObservedRoute[] = [];
  let resolvedCallsigns = 0;
  const sampledAt = new Date().toISOString();

  const localIcao = new Set(
    nearby.map((a) => (a.icao ?? a.ident ?? "").toUpperCase()).filter(Boolean),
  );
  const localIata = new Set(nearby.map((a) => (a.iata ?? "").toUpperCase()).filter(Boolean));

  if (primary) {
    // 150 nm alrededor del aeropuerto: agarra aproximaciones y despegues, no
    // solo lo que esta encima de la pista.
    const raw = await aircraftAround(primary.lat, primary.lng, 150).catch(() => [] as AdsbAircraft[]);

    const commercial = raw.filter(
      (a) => (a.flight ?? "").trim().length > 0 && isCommercialType(a.t),
    );

    // Se resuelven como maximo 40 callsigns por consulta: alcanza para un
    // retrato del trafico y le pone techo al trafico contra adsbdb.
    const toResolve = commercial.slice(0, 40);
    const routes = await inBatches(toResolve, 8, async (a) => {
      const cs = (a.flight ?? "").trim().toUpperCase();
      const r = await routeFor(cs);
      return { ac: a, cs, r };
    });

    let cargoCount = 0;
    let seats = 0;
    let unknownType = 0;
    const typeCount = new Map<string, number>();
    const carriers = new Set<string>();

    for (const { ac, cs, r } of routes) {
      const fr = r?.flightroute;
      const airline = fr?.airline?.name ?? null;
      if (fr) resolvedCallsigns++;

      if (isCargo(cs, airline)) {
        cargoCount++;
        continue;
      }

      const model = ac.t ?? null;
      const s = seatsFor(model);
      if (s === null) unknownType++;
      else seats += s;
      if (model) typeCount.set(model, (typeCount.get(model) ?? 0) + 1);
      if (airline) carriers.add(airline);

      if (fr) {
        const oIcao = (fr.origin?.icao_code ?? "").toUpperCase();
        const dIcao = (fr.destination?.icao_code ?? "").toUpperCase();
        const oIata = (fr.origin?.iata_code ?? "").toUpperCase();
        const dIata = (fr.destination?.iata_code ?? "").toUpperCase();
        observed.push({
          callsign: cs,
          airline,
          originIata: fr.origin?.iata_code ?? null,
          originName: fr.origin?.name ?? null,
          originCountry: fr.origin?.country_iso_name ?? null,
          destIata: fr.destination?.iata_code ?? null,
          destName: fr.destination?.name ?? null,
          destCountry: fr.destination?.country_iso_name ?? null,
          model,
          seats: s,
          touchesLocal:
            localIcao.has(oIcao) || localIcao.has(dIcao) ||
            localIata.has(oIata) || localIata.has(dIata),
        });
      }
    }

    airlift = {
      observedAircraft: raw.length,
      commercialAircraft: commercial.length - cargoCount,
      cargoAircraft: cargoCount,
      estimatedSeats: seats,
      unknownTypeAircraft: unknownType,
      byType: [...typeCount.entries()]
        .map(([model, count]) => ({ model, count, seatsEach: seatsFor(model) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      carriers: [...carriers].sort(),
      sampleRadiusKm: Math.round(150 * 1.852),
    };

    if (commercial.length > 40) {
      gaps.push(
        "Se resolvieron 40 de " + commercial.length + " callsigns: el resto queda sin ruta",
      );
    }
  }

  // Solo las rutas que efectivamente tocan un aeropuerto del radio dicen algo
  // de la conectividad de ESTE punto; el resto es transito de paso.
  const localRoutes = observed.filter((r) => r.touchesLocal);
  const cc = geo.countryCode;

  // Solo el OTRO extremo de la ruta, y solo si esta en otro pais. Un vuelo
  // domestico (Aeroparque -> Bariloche) tiene su punta lejana en el mismo
  // pais: contarlo aca daria por observado un servicio internacional que no
  // existe.
  const originCountries = new Set<string>();
  for (const r of localRoutes) {
    const oLocal = localIata.has((r.originIata ?? "").toUpperCase());
    const far = oLocal ? r.destCountry : r.originCountry;
    if (far && far.toUpperCase() !== cc) originCountries.add(far.toUpperCase());
  }

  // ── Cruce con los mercados emisores del §6 ──
  const emitterLinks: EmitterLink[] = emittersFor(cc).map((ec) => {
    const via = localRoutes
      .filter((r) => r.originCountry === ec || r.destCountry === ec)
      .map((r) => (r.originIata ?? "?") + "->" + (r.destIata ?? "?"))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 4);
    const status: DirectFlightStatus = via.length ? "observed" : "unknown";
    return { countryCode: ec, countryName: COUNTRY_NAME[ec] ?? ec, status, via };
  });

  const ground = await groundTransport(lat, lng, radiusKm).catch(() => ({
    train: emptyNode(),
    subway: emptyNode(),
    busTerminal: emptyNode(),
    ferry: emptyNode(),
    carRental: emptyNode(),
    borderCrossing: emptyNode(),
    truncated: false,
    available: false,
  }));

  // ── Gaps ──
  if (!nearby.length) {
    gaps.push("Sin aeropuertos en el radio: el punto no tiene conectividad aerea propia");
  }
  if (!airlift || airlift.commercialAircraft === 0) {
    gaps.push(
      "Ningun vuelo comercial en el aire durante la consulta: la muestra no dice que no haya rutas, dice que en este momento no volaba ninguna",
    );
  }
  if (airlift && airlift.unknownTypeAircraft > 0) {
    gaps.push(
      airlift.unknownTypeAircraft +
        " aeronaves de tipo no tabulado: sus asientos no entran en el total",
    );
  }
  if (!ground.available) {
    gaps.push("Overpass no respondio: el transporte terrestre queda sin relevar");
  } else if (isEmptyGround(ground) && nearby.length > 0) {
    // Cero de todo en un lugar que tiene aeropuerto no es un dato del
    // territorio, es un sintoma de la fuente. Se degrada a "no relevado" para
    // que la pantalla no muestre una fila de ceros con cara de censo.
    ground.available = false;
    gaps.push(
      "Overpass devolvio vacio para un punto con aeropuerto: no hay relevamiento terrestre confiable, no es que no haya transporte",
    );
  } else if (ground.truncated) {
    gaps.push("Overpass corto en " + GROUND_CAP + " elementos: los conteos terrestres son un piso");
  }
  gaps.push("Volumen de asientos programado: requiere datos de itinerarios, que no son abiertos");
  gaps.push("Apertura y cierre de rutas: solo se detecta comparando observaciones en el tiempo");
  gaps.push("Huelgas, cierres de aeropuerto y obras viales: sin fuente estructurada");
  gaps.push("Itinerarios de cruceros: son dato comercial de cada naviera");

  const coverage: ConnectivityCoverage = {
    airports: nearby.length > 0,
    liveTraffic: Boolean(airlift && airlift.observedAircraft > 0),
    routes: localRoutes.length > 0,
    ground: ground.available,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    country: { code: cc, name: COUNTRY_NAME[cc] ?? geo.countryName ?? cc },
    airports: {
      nearby: nearby.slice(0, 12).map(toAirport),
      primary: primary ? toAirport(primary) : null,
      tier: tierOf(nearby),
      withScheduledService: withScheduled.length,
      majorCount: withScheduled.filter((a) => a.type === "large_airport").length,
      // Con evidencia: alguna ruta observada cruza frontera. Si no se vio, es
      // "unknown" — el tamano del aeropuerto no alcanza para afirmarlo.
      internationalService: originCountries.size > 0 ? "observed" : "unknown",
    },
    airlift,
    routes: {
      observed: localRoutes.slice(0, 30),
      directOriginCountries: [...originCountries].sort(),
      emitterLinks,
      resolvedCallsigns,
      sampledAt,
    },
    ground,
    coverage,
    sources: [
      "OurAirports (censo de aeropuertos)",
      "adsb.lol (posiciones ADS-B en vivo)",
      "adsbdb (callsign a ruta)",
      "OpenStreetMap Overpass (transporte terrestre)",
      "OpenStreetMap Nominatim",
    ],
    timestamp: new Date().toISOString(),
  };
}

// Re-export para que el indice de aeropuertos quede disponible a quien lo
// necesite sin volver a resolver el catalogo.
export { byIcao };
