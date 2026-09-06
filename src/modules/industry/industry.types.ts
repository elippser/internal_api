// Tipos del hub de industria y sector especifico (§16).
//
// Contesta por que se llena un hotel cuando no es temporada turistica. Se
// infiere del uso del suelo: no hay registro abierto de "que hace esta zona",
// pero si esta mapeado como se usa la tierra.

export type VocationKey =
  | "wine"
  | "mining"
  | "agriculture"
  | "fishing"
  | "forestry"
  | "industry";

export interface Vocation {
  key: VocationKey;
  label: string;
  /** Por que esa actividad genera demanda hotelera. */
  why: string;
  count: number;
  nearestKm: number;
  /**
   * Cuanta demanda mueve, no cuantos elementos hay: una mina con turnos
   * rotativos pesa mucho mas que una hectarea de campo.
   */
  demandWeight: number;
  season: {
    months: number[];
    label: string;
    inSeason: boolean;
    note: string;
    /** true = ventana tipica del hemisferio, no la veda vigente. */
    approximate: boolean;
  } | null;
}

export interface IndustryCoverage {
  census: boolean;
  gaps: string[];
}

export interface IndustryPointPayload {
  location: { lat: number; lng: number; radiusKm: number };
  hemisphere: "north" | "south";
  vocations: Vocation[];
  dominant: string | null;
  /** Vocaciones que estan en temporada este mes. */
  inSeasonNow: string[];
  coverage: IndustryCoverage;
  sources: string[];
  timestamp: string;
}
