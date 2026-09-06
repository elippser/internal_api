// Tipos del hub de oferta hotelera y competencia (event-list.md §11).
//
// UNA ACLARACION QUE EVITA CONFUSION
// En internal-laupser ya existe el modulo `competitors/`, pero mira otra cosa:
// los competidores SaaS de Roombir como empresa. Este hub mira la oferta de
// alojamiento alrededor de un punto del mapa, que es competencia de un hotel,
// no de la plataforma. No se tocan.
//
// LO QUE SE PUEDE Y LO QUE NO
// OpenStreetMap tiene un censo bueno de QUE alojamientos existen, y casi nada
// de su TAMANO: en Buenos Aires, 12 de 250 tienen estrellas y 2 tienen numero
// de habitaciones. Por eso el hub cuenta establecimientos y nunca plazas: una
// cifra de plazas extrapolada de 2 datos seria inventada.

export type LodgingKind =
  | "hotel"
  | "hostel"
  | "guest_house"
  | "motel"
  | "apartment"
  | "chalet"
  | "camp_site";

export interface LodgingCount {
  kind: LodgingKind;
  label: string;
  count: number;
}

export interface Chain {
  name: string;
  count: number;
}

/**
 * Norma de alquiler temporario que alcanza al punto. Viene de la tabla curada
 * del §8: es el unico item de esta categoria que no se puede contar, se
 * consulta.
 */
export interface StrRule {
  city: string;
  severity: "ban" | "heavy" | "moderate" | "registry";
  summary: string;
  asOf: number;
  distanceKm: number;
}

export interface SupplyCoverage {
  census: boolean;
  /** true si Overpass corto la respuesta: los conteos son un piso. */
  truncated: boolean;
  gaps: string[];
}

export interface SupplyPointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  /** Establecimientos, NO plazas. Ver la nota de arriba. */
  total: number;
  byKind: LodgingCount[];
  /**
   * Alojamiento que compite con un hotel sin serlo: hostels, apartamentos,
   * casas de huespedes, camping y glamping. Es un item explicito de la lista y
   * la mitad de la historia del alquiler temporario.
   */
  substitutes: { count: number; share: number };
  /** Establecimientos con marca reconocible, y cuales. */
  chains: { count: number; share: number; top: Chain[] };
  /** Establecimientos por km2 dentro del radio. */
  densityPerKm2: number;
  /**
   * Normas de alquiler temporario vigentes. Se leen JUNTO con `substitutes`:
   * mucha oferta sustituta sin regulacion es un entorno competitivo distinto
   * al de una ciudad que la prohibio.
   */
  strRegulation: StrRule[];
  coverage: SupplyCoverage;
  sources: string[];
  timestamp: string;
}
