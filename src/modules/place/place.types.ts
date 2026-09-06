// Tipos del hub de ubicacion y entorno fisico (event-list.md §12).
//
// ES EL UNICO HUB QUE SE MIDE CAMINANDO
// Los otros diez trabajan con radios de cientos de kilometros. Aca la unidad
// es la cuadra: lo que define a un alojamiento urbano es lo que hay a diez
// minutos a pie, no a doscientos kilometros. Por eso el radio por defecto es
// 1 km y el maximo, 5.

export interface Nearby {
  /** Nombre del lugar mas cercano de la categoria, si esta etiquetado. */
  name: string | null;
  distanceM: number;
}

/** Que hay cerca, y a que distancia. Null = no se encontro en el radio. */
export interface Proximity {
  attraction: Nearby | null;
  museum: Nearby | null;
  park: Nearby | null;
  beach: Nearby | null;
  water: Nearby | null;
  peak: Nearby | null;
  university: Nearby | null;
  hospital: Nearby | null;
  conventionCentre: Nearby | null;
  transitStop: Nearby | null;
  busTerminal: Nearby | null;
  /** Del catalogo de aeropuertos del §7, no de OSM. */
  airport: (Nearby & { iata: string | null }) | null;
}

export interface DensityCounts {
  gastronomy: number;
  nightlife: number;
  shops: number;
  offices: number;
  /** Locales de marcas reconocibles: senial de zona transitada. */
  chains: number;
  chainNames: string[];
}

/**
 * Caminabilidad. NO es Walk Score: es un proxy propio y sus tres componentes
 * viajan en el payload para que se pueda auditar de donde sale el numero en
 * vez de creerle.
 */
export interface Walkability {
  score: number;
  components: {
    /** Densidad de comercios y servicios a pie. */
    amenities: number;
    /** Infraestructura peatonal: sendas, cruces, peatonales. */
    pedestrian: number;
    /** Acceso a transporte publico. */
    transit: number;
  };
  label: string;
}

/**
 * Ruido estimado a partir de sus tres fuentes nombradas en la lista:
 * autopista, aeropuerto y vida nocturna. Es geometria, no una medicion
 * acustica — y por eso se publican las fuentes, no solo el puntaje.
 */
export interface NoiseEstimate {
  score: number;
  label: string;
  sources: string[];
}

/**
 * Indicios de vista. La vista real depende de la altura del piso y de la
 * orientacion del cuarto, que ningun mapa sabe; esto dice si hay algo que
 * mirar y si el terreno acompania.
 */
export interface ViewHints {
  elevationM: number | null;
  /** Desnivel contra el entorno: positivo = el punto esta mas alto. */
  reliefM: number | null;
  hints: string[];
}

export interface PlaceCoverage {
  census: boolean;
  elevation: boolean;
  gaps: string[];
}

export interface PlacePointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  proximity: Proximity;
  density: DensityCounts;
  walkability: Walkability;
  noise: NoiseEstimate;
  view: ViewHints;
  /** Proporcion de lugares cercanos etiquetados como accesibles en OSM. */
  accessibility: { taggedAccessible: number; taggedTotal: number; share: number | null };
  /** Frase que resume el caracter del entorno. */
  profile: string;
  coverage: PlaceCoverage;
  sources: string[];
  timestamp: string;
}
