// Tipos del hub de eventos deportivos (event-list.md §3).
//
// A diferencia de los hubs de clima (§1, dato local del punto) y calendario
// (§2, dato del pais), acá el dato es PUNTUAL con radio: un evento ocurre en
// una sede concreta y mueve la ocupación de la ciudad alrededor. Por eso el
// endpoint filtra por distancia y devuelve cuán lejos cae cada uno.

export type SportsCategory =
  | "mega" // JJOO, mundiales, torneos continentales
  | "motorsport" // F1, MotoGP, rally
  | "marathon" // maratones y medias
  | "tennis" // Grand Slams
  | "cycling" // grandes vueltas
  | "golf"
  | "final" // finales de copas de clubes
  | "league"; // fixture de liga (viene del intelligence-hub)

export interface SportsEvent {
  id: string;
  name: string;
  category: SportsCategory;
  /** Disciplina legible: "Fútbol", "Automovilismo", "Atletismo"… */
  sport: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (igual al inicio si dura un día)
  city: string;
  country: string;
  venue: string | null;
  lat: number;
  lng: number;
  /** Distancia al punto consultado, en km. */
  distanceKm: number;
  /** Días desde hoy hasta el inicio: la antelación con la que se conoce. */
  leadDays: number;
  /**
   * Impacto esperado sobre la ocupación, 0-1. Curado por tipo de evento, no
   * medido: unos JJOO llenan la ciudad por semanas, un partido de liga una
   * noche.
   */
  impact: number;
  /** Cuántas noches de demanda genera típicamente. */
  nightsHint: number;
  source: string;
  /** true = fecha/sede de tabla curada; false = de una API en vivo. */
  curated: boolean;
  note?: string;
  url?: string;
}

export interface SportsCoverage {
  megaEvents: boolean;
  formula1: boolean;
  recurring: boolean;
  leagueFixtures: boolean;
  gaps: string[];
}

export interface SportsPointPayload {
  location: {
    lat: number;
    lng: number;
    radiusKm: number;
  };
  window: { from: string; to: string };
  events: SportsEvent[];
  /** Resumen por categoría para leer de un vistazo qué hay cerca. */
  byCategory: Record<string, number>;
  /** El de mayor impacto dentro del radio y la ventana. */
  headline: SportsEvent | null;
  coverage: SportsCoverage;
  sources: string[];
  timestamp: string;
}
