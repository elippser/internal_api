// Tipos del hub de politicas migratorias y regulatorias (event-list.md §8).
//
// Cierra el hilo de los mercados emisores que abrio el §6 y siguio el §7:
//   §6 -> para quien el destino esta barato
//   §7 -> quien puede volar hasta aca
//   §8 -> a quien lo dejan entrar sin tramite
//
// Los tres comparten la misma lista de emisores, asi que se leen en fila sobre
// el mismo punto del mapa.

import type { VisaCategory } from "./visa";
import type { StrSeverity } from "./regulation";

export type { VisaCategory, StrSeverity };

/** Un mercado emisor visto desde la frontera del destino. */
export interface EmitterEntry {
  countryCode: string;
  countryName: string;
  category: VisaCategory;
  /** Dias de estadia sin visa, cuando la fuente los precisa. */
  days: number | null;
  /** 1 = entra sin nada; 6 = no lo admiten. Ordena la tabla. */
  friction: number;
  /** Bloques de libre transito compartidos con el destino. */
  blocs: string[];
  /** Valor crudo del dataset, para poder auditar la clasificacion. */
  raw: string;
  /**
   * true si el tratado dice libre transito pero la matriz pide visa. Es una
   * contradiccion entre fuentes, no un dato: se marca para revisarla.
   */
  conflict: boolean;
}

export interface StrRegulation {
  city: string;
  severity: StrSeverity;
  summary: string;
  asOf: number;
  distanceKm: number;
}

export interface HealthEntry {
  /** Exigencia de fiebre amarilla del destino. */
  yellowFever: "all-travellers" | "from-endemic-areas" | "none";
  note: string;
}

export interface PolicyCoverage {
  visaMatrix: boolean;
  blocs: boolean;
  strRegulation: boolean;
  gaps: string[];
}

export interface PolicyPointPayload {
  location: { lat: number; lng: number };
  country: { code: string; name: string };
  /**
   * Los emisores ordenados por friccion de entrada. Es la respuesta al primer
   * item de la categoria y el remate de la serie: un mercado barato, con vuelo
   * directo y sin visa es el que hay que atacar.
   */
  emitters: EmitterEntry[];
  /**
   * Los tres cubos suman `total` siempre. Se agrupan por TRAMITE PREVIO y no
   * por "visa si / visa no", porque es la distincion que decide una reserva:
   * una visa en destino no frena a nadie, una que hay que sacar con un mes de
   * anticipacion frena a todos. Con los cubos de antes, un pais donde todos
   * entran con e-visa daba "0 sin visa / 0 con visa".
   */
  headline: {
    /** Entra decidiendo el viaje: sin visa, o con visa en frontera. */
    noPriorPaperwork: number;
    /** Necesita gestionar algo antes de viajar: ETA, e-visa o visa consular. */
    priorPaperwork: number;
    /** No lo admiten. */
    blocked: number;
    total: number;
    /** Emisores que comparten bloque de libre transito con el destino. */
    sameBloc: number;
  };
  /** Bloques a los que pertenece el destino. */
  destinationBlocs: Array<{ key: string; name: string; effect: string }>;
  health: HealthEntry;
  /**
   * Regulacion del alquiler temporario que alcanza al punto. Es el unico item
   * de la categoria que no cambia si el huesped viene, sino con quien se
   * aloja: limitar el alquiler temporario le devuelve demanda a la hoteleria.
   */
  strRegulation: StrRegulation[];
  entryFees: Array<{ name: string; amount: string; appliesTo: string; asOf: number }>;
  /**
   * Frescura del dataset de visados. Viaja siempre: una politica que cambio
   * despues de esta fecha no esta reflejada, y eso hay que poder verlo.
   */
  dataset: { source: string; dataDate: string; monthsOld: number; stale: boolean };
  coverage: PolicyCoverage;
  sources: string[];
  timestamp: string;
}
