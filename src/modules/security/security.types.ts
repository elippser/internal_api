// Tipos del hub de seguridad y estabilidad (event-list.md §9).
//
// La categoria mezcla dos cosas que conviene no confundir:
//
//   · RIESGO MEDIDO — homicidios por 100.000, brotes declarados por la OMS.
//     Son hechos, con su fuente y su anio.
//   · RIESGO PERCIBIDO — el nivel de alerta que publica una cancilleria. Es
//     un juicio de un gobierno, no una medicion.
//
// Para un hotel manda el segundo, aunque suene al reves: la alerta es la que
// dispara prohibiciones de viaje corporativo y exclusiones de seguro. El
// homicidio describe el pais; la alerta cancela la reserva.

import type { AdvisoryLevel } from "./advisories";

export type { AdvisoryLevel };

/** La alerta de una cancilleria sobre el destino. */
export interface Advisory {
  issuer: "CA" | "US";
  issuerName: string;
  level: AdvisoryLevel;
  label: string;
  /** Texto oficial, cuando la fuente lo publica. */
  text: string | null;
  /** Hay advertencias para regiones puntuales dentro del pais. */
  regional: boolean;
  publishedAt: string | null;
  /**
   * Que cambio en la ultima revision. Es lo mas parecido a un indicador
   * adelantado que tiene esta categoria: la cancilleria dice que movio antes
   * de que se note en las reservas.
   */
  recentUpdate: string | null;
}

export interface Indicator {
  value: number | null;
  year: number | null;
  unit: string;
}

/** Brote declarado por la OMS que menciona al pais. */
export interface Outbreak {
  title: string;
  publishedAt: string;
  url: string | null;
}

/** Nota de prensa sobre conflictividad social, via GDELT. */
export interface UnrestItem {
  title: string;
  date: string;
  domain: string | null;
  url: string | null;
}

export interface SecurityCoverage {
  advisories: boolean;
  crime: boolean;
  outbreaks: boolean;
  unrest: boolean;
  gaps: string[];
}

export interface SecurityPointPayload {
  location: { lat: number; lng: number };
  country: { code: string; name: string };
  /** Una entrada por cancilleria que publica sobre este destino. */
  advisories: Advisory[];
  /**
   * Nivel mas alto entre las cancillerias. Es el que manda en la practica:
   * un viajero corporativo se rige por la alerta de SU gobierno, y basta que
   * una la suba para que ese mercado se caiga.
   */
  worstLevel: AdvisoryLevel | null;
  /**
   * true si dos cancillerias difieren en dos niveles o mas. No es un error de
   * datos: es riesgo en disputa, y conviene verlo antes de decidir.
   */
  disagreement: boolean;
  /** Homicidios intencionales por 100.000 habitantes. */
  homicideRate: Indicator;
  outbreaks: Outbreak[];
  unrest: {
    items: UnrestItem[];
    /** Ventana consultada, en dias. */
    windowDays: number;
    available: boolean;
  };
  coverage: SecurityCoverage;
  sources: string[];
  timestamp: string;
}
