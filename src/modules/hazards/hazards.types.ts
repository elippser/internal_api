// Tipos del hub de desastres naturales y disrupciones ambientales
// (event-list.md §10).
//
// NO SE SUPERPONE CON EL §1
// El hub de clima responde la EXPOSICION estructural: "esta plaza tiene
// temporada de huracanes en febrero", y eso sale de treinta anios de
// climatologia. Este responde lo que esta pasando AHORA o en los proximos
// dias. Mismo punto del mapa, preguntas distintas: uno sirve para planificar
// el anio, el otro para decidir esta semana.

import type { AlertLevel } from "./sources";

export type { AlertLevel };

/** Como llega el golpe al hotel. */
export type ImpactPath = "direct" | "airlift";

/**
 * Por que entro el evento al payload.
 *   local   — su centroide cae dentro del radio pedido.
 *   country — GDACS lo declara sobre el pais del punto, aunque el centroide
 *             quede lejisimos. Es el caso de las sequias continentales: una
 *             sola marca en el sur de Alemania cubre 25 paises, Espana entre
 *             ellos. Filtrarlas por distancia daria "no hay sequia" en plena
 *             sequia europea.
 */
export type HazardScope = "local" | "country";

export interface HazardEvent {
  scope: HazardScope;
  /** Codigo GDACS: EQ, TC, FL, DR, WF, VO, TS. */
  type: string;
  typeName: string;
  name: string;
  country: string | null;
  alertLevel: AlertLevel;
  distanceKm: number;
  from: string;
  to: string;
  /** true si la ventana del evento cubre el dia de hoy. */
  ongoing: boolean;
  url: string | null;
}

export interface Quake {
  magnitude: number;
  depthKm: number | null;
  place: string;
  time: string;
  distanceKm: number;
  url: string | null;
}

export interface Volcano {
  name: string;
  distanceKm: number;
  since: string;
  url: string | null;
}

/**
 * Anomalia termica detectada en el pronostico. El umbral es relativo a los
 * ultimos 60 dias del propio lugar, no absoluto.
 */
export interface TempAnomaly {
  kind: "heat" | "cold";
  startDate: string;
  endDate: string;
  days: number;
  /** Temperatura mas extrema de la racha. */
  peakC: number;
  /** Umbral que se supero, en grados. */
  thresholdC: number;
}

/**
 * Amenaza que compromete el acceso aereo. Es el camino indirecto y el menos
 * obvio: el hotel puede estar intacto y quedarse sin huespedes porque la
 * ceniza o el ciclon cerraron el aeropuerto que lo alimenta.
 */
export interface AirliftRisk {
  airport: string;
  airportIata: string | null;
  airportDistanceKm: number;
  hazard: string;
  hazardType: string;
  hazardDistanceKm: number;
  alertLevel: AlertLevel;
}

export interface HazardsCoverage {
  gdacs: boolean;
  quakes: boolean;
  volcanoes: boolean;
  temperature: boolean;
  gaps: string[];
}

export interface HazardsPointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  /**
   * Lo que esta ocurriendo ahora dentro del radio, ordenado por severidad y
   * cercania.
   */
  active: HazardEvent[];
  /** Eventos de la ventana que ya terminaron. Contexto, no alarma. */
  recent: HazardEvent[];
  quakes: Quake[];
  volcanoes: Volcano[];
  anomalies: TempAnomaly[];
  /** Amenazas que ponen en riesgo el acceso aereo (cruce con el §7). */
  airliftRisk: AirliftRisk[];
  headline: {
    /** Nivel mas alto entre los eventos activos. */
    worstAlert: AlertLevel | null;
    activeCount: number;
    /** Como puede llegar el golpe: directo, por el aeropuerto, o ninguno. */
    paths: ImpactPath[];
  };
  window: { days: number; from: string; to: string };
  coverage: HazardsCoverage;
  sources: string[];
  timestamp: string;
}
