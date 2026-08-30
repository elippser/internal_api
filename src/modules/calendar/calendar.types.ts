// Tipos del hub de calendario y feriados (event-list.md §2).
//
// Un payload por punto del mapa: el calendario del país del destino (feriados,
// fines de semana largos con puentes, vacaciones escolares, efemérides
// comerciales, fechas de cobro) más las ventanas móviles religiosas y los
// fines de semana largos de los mercados emisores.

/** Cómo se resolvió el país a partir de la coordenada. */
export interface CalendarLocation {
  lat: number;
  lng: number;
  countryCode: string; // ISO 3166-1 alpha-2
  countryName: string;
  region: string | null;
  displayName: string | null;
}

export type HolidayKind =
  | "public" // feriado nacional/regional oficial
  | "observance" // efeméride comercial sin asueto (día de la madre, etc.)
  | "religious" // festividad móvil religiosa (Ramadán, Pésaj…)
  | "payday"; // aguinaldo / fecha de cobro

export interface CalendarEntry {
  date: string; // YYYY-MM-DD (inicio si es rango)
  endDate: string | null; // YYYY-MM-DD si abarca varios días
  name: string;
  kind: HolidayKind;
  /** Nacional (true) o acotado a subdivisiones (false). */
  nationwide: boolean;
  /** Subdivisiones afectadas cuando no es nacional. */
  subdivisions?: string[];
  /** Día de la semana del inicio, 0=domingo. Útil para leer el calendario. */
  weekday: number;
  source: string;
  /** Sólo en `observance`/`payday`: la regla es curada, no viene de una API. */
  curated?: boolean;
  note?: string;
}

/**
 * Fin de semana largo. `bridgeDays` son los días hábiles que hay que "puentear"
 * para encadenarlo — exactamente los puentes turísticos que decretan algunos
 * gobiernos, y la señal de viaje más fuerte del calendario.
 */
export interface LongWeekend {
  startDate: string;
  endDate: string;
  dayCount: number;
  needBridgeDay: boolean;
  bridgeDays: string[];
  /** Feriados que lo originan, resueltos contra la lista de feriados. */
  holidays: string[];
}

export interface SchoolBreak {
  startDate: string;
  endDate: string;
  name: string;
  nationwide: boolean;
  subdivisions: string[];
  /** verano | invierno | primavera | media | otra. */
  season: "summer" | "winter" | "spring" | "mid" | "other";
  dayCount: number;
  /** De dónde salió: la API oficial o la tabla curada del Cono Sur. */
  source: "openholidays" | "curado";
  /**
   * Sólo en los curados: `verified` = la regla reproduce el calendario oficial
   * del último ciclo publicado; `approximate` = ventana estimada (el verano,
   * que depende de cada jurisdicción).
   */
  precision?: "verified" | "approximate";
  /** Sólo en los curados: qué bloque/región toma este receso. */
  blockLabel?: string;
  note?: string;
}

/** Fin de semana largo de un mercado emisor, para leer demanda entrante. */
export interface EmitterWindow {
  countryCode: string;
  countryName: string;
  longWeekends: LongWeekend[];
  schoolBreaks: SchoolBreak[];
}

/** Ventanas móviles religiosas, globales (no dependen del país del punto). */
export interface MoveableFeasts {
  ramadan: { start: string; end: string; hijriYear: number } | null;
  eidAlFitr: string | null;
  eidAlAdha: string | null;
  /**
   * Festividades judías mayores del período, ya colapsadas a bloques: Pésaj
   * llega como un rango de 8 días, no como 8 entradas sueltas.
   */
  jewish: Array<{ date: string; endDate: string; name: string }>;
  /** Pascua cristiana y las fechas que se derivan de ella. */
  easter: { date: string; goodFriday: string; ascension: string; pentecost: string } | null;
}

/** Qué quedó sin cubrir para este país y por qué — honestidad en el payload. */
export interface CalendarCoverage {
  publicHolidays: boolean;
  longWeekends: boolean;
  schoolHolidays: boolean;
  observances: boolean;
  paydays: boolean;
  /** Motivos legibles de cada `false`. */
  gaps: string[];
}

export interface CalendarPointPayload {
  location: CalendarLocation;
  window: { from: string; to: string };
  /** Feriados, efemérides y fechas de cobro del país, ordenados por fecha. */
  entries: CalendarEntry[];
  longWeekends: LongWeekend[];
  schoolBreaks: SchoolBreak[];
  emitters: EmitterWindow[];
  moveable: MoveableFeasts;
  coverage: CalendarCoverage;
  sources: string[];
  timestamp: string;
}
