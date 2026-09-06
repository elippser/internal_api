// Tipos del hub de conectividad y transporte (event-list.md §7).
//
// Vuelve al eje de §3-§5 (dato puntual con radio), pero con una distincion que
// no aparecia en ninguna categoria anterior: una parte del payload es
// ESTRUCTURA (que aeropuertos y terminales existen, dato completo y estable) y
// otra es OBSERVACION (que esta volando ahora, muestra parcial). Estan
// separadas a proposito y el panel las muestra distinto, porque confundirlas
// llevaria a afirmar que una ruta no existe cuando lo unico cierto es que no
// se la vio.

/**
 * Jerarquia aerea del punto, por TAMANO. OurAirports clasifica por porte de
 * la instalacion, no por si opera vuelos internacionales, asi que estos
 * valores no dicen nada del alcance: Bariloche figura como `major` por su
 * pista, igual que Ezeiza. Si el destino tiene servicio internacional se
 * responde por separado y con evidencia (`internationalService`), no
 * infiriendolo del tamano.
 */
export type AirliftTier = "major" | "regional" | "local" | "none";

/**
 * Si se vio trafico internacional. `observed` sale de una ruta concreta con
 * origen o destino en otro pais; `unknown` es que no se vio, que no es lo
 * mismo que no existir.
 */
export type InternationalService = "observed" | "unknown";

export interface Airport {
  ident: string;
  name: string;
  type: "large_airport" | "medium_airport" | "small_airport";
  iata: string | null;
  icao: string | null;
  municipality: string;
  country: string;
  scheduledService: boolean;
  distanceKm: number;
}

/**
 * Ruta observada en vivo. `observed` es la palabra clave: sale de resolver el
 * callsign de un avion que estaba en el aire durante la consulta, no de un
 * itinerario publicado.
 */
export interface ObservedRoute {
  callsign: string;
  airline: string | null;
  originIata: string | null;
  originName: string | null;
  originCountry: string | null;
  destIata: string | null;
  destName: string | null;
  destCountry: string | null;
  model: string | null;
  seats: number | null;
  /** true si toca alguno de los aeropuertos del radio. */
  touchesLocal: boolean;
}

/**
 * Estado de un mercado emisor frente al destino. Solo dos valores posibles a
 * proposito: o se vio un vuelo directo, o no se sabe. NUNCA "no hay vuelo":
 * una muestra instantanea de madrugada no prueba una ausencia, y afirmarla
 * seria el error mas caro que puede cometer este hub.
 */
export type DirectFlightStatus = "observed" | "unknown";

export interface EmitterLink {
  countryCode: string;
  countryName: string;
  status: DirectFlightStatus;
  /** Rutas concretas que respaldan un "observed". */
  via: string[];
}

/** Capacidad estimada que se vio en el aire durante la consulta. */
export interface LiveAirlift {
  observedAircraft: number;
  commercialAircraft: number;
  cargoAircraft: number;
  /** Suma de asientos de los tipos reconocidos. */
  estimatedSeats: number;
  /** Aeronaves comerciales cuyo tipo no esta en la tabla: el total las omite. */
  unknownTypeAircraft: number;
  byType: Array<{ model: string; count: number; seatsEach: number | null }>;
  carriers: string[];
  sampleRadiusKm: number;
}

export interface GroundNode {
  count: number;
  nearestName: string | null;
  nearestKm: number | null;
}

/** Lo terrestre: la mitad de la categoria que no vuela. */
export interface GroundTransport {
  train: GroundNode;
  subway: GroundNode;
  busTerminal: GroundNode;
  ferry: GroundNode;
  carRental: GroundNode;
  borderCrossing: GroundNode;
  /** true si Overpass corto la respuesta y los conteos son un piso. */
  truncated: boolean;
  available: boolean;
}

export interface ConnectivityCoverage {
  airports: boolean;
  liveTraffic: boolean;
  routes: boolean;
  ground: boolean;
  gaps: string[];
}

export interface ConnectivityPointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  country: { code: string; name: string };
  airports: {
    nearby: Airport[];
    primary: Airport | null;
    /** Por tamano de instalacion. No implica alcance internacional. */
    tier: AirliftTier;
    withScheduledService: number;
    majorCount: number;
    /** Con evidencia: una ruta observada que cruza frontera. */
    internationalService: InternationalService;
  };
  airlift: LiveAirlift | null;
  routes: {
    observed: ObservedRoute[];
    /** Paises de origen vistos conectando con el punto. */
    directOriginCountries: string[];
    /** Cruce con los mercados emisores del hub economico (§6). */
    emitterLinks: EmitterLink[];
    resolvedCallsigns: number;
    sampledAt: string;
  };
  ground: GroundTransport;
  coverage: ConnectivityCoverage;
  sources: string[];
  timestamp: string;
}
