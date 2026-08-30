// Congresos, ferias y cumbres ancla (event-list.md §5).
//
// POR QUE ESTA CURADO: el intelligence-hub ya levanta los eventos de los
// recintos que scrapea (IFEMA, La Rural, BA Ferial, Anhembi) mas lo que
// publican Eventbrite y Meetup. Eso cubre la agenda local. Lo que no aparece
// es el CALENDARIO ANCLA del sector: MWC, CES, ITB, FITUR, Davos, el G20.
// Son los que agotan la plaza de una ciudad entera y se publican con anios de
// antelacion, igual que los mega-eventos deportivos del §3.
//
// LO QUE DISTINGUE A ESTA CATEGORIA — y por eso el tipo tiene campos propios:
// la demanda MICE es de MITAD DE SEMANA y estadia larga. Una feria llena
// martes a jueves con 3-4 noches por delegado; un festival llena viernes a
// domingo con 2. Un hotel que optimiza tarifa necesita esa diferencia, no solo
// la fecha. Verificado en las fechas 2027: CES miercoles a sabado, MWC lunes a
// jueves, ITB martes a jueves, Davos lunes a viernes.
//
// El otro campo propio es `attendees`: es la metrica con la que la industria
// mide el impacto hotelero de un congreso. 100.000 delegados en Barcelona no
// se comparan con 5.000 en una capital de provincia.

import { resolveRule, type DateRule } from "../calendar/observances";

export type MiceCategory =
  | "trade-fair" // ferias comerciales y sectoriales
  | "congress" // congresos medicos, cientificos, academicos
  | "summit" // cumbres politicas y diplomaticas
  | "forum" // foros economicos
  | "tech"; // eventos tech, hackathons, esports

/** Como se reparte la demanda en la semana. */
export type DayPattern = "midweek" | "weekend" | "full-week";

export interface CongressDef {
  key: string;
  name: string;
  category: MiceCategory;
  /** Sector, para poder leer si el congreso es del rubro del hotel. */
  sector: string;
  city: string;
  country: string;
  venue?: string;
  lat: number;
  lng: number;
  /** Asistentes aproximados: la metrica de impacto de la industria. */
  attendees: number;
  nightsHint: number;
  dayPattern: DayPattern;
  note?: string;
}

/** Edicion anual que se repite por regla en la misma sede. */
export interface RecurringCongress extends CongressDef {
  kind: "recurring";
  start: DateRule;
  days: number;
  /** true = el organizador fija la fecha exacta cada anio. */
  approximate?: boolean;
}

/** Edicion unica con sede adjudicada y fecha anunciada. */
export interface OneOffCongress extends CongressDef {
  kind: "one-off";
  startDate: string;
  endDate: string;
}

export type AnyCongress = RecurringCongress | OneOffCongress;

const wd = (month: number, weekday: number, nth: number): DateRule => ({
  kind: "nthWeekday", month, weekday, nth,
});

export const CONGRESSES: AnyCongress[] = [
  // ── Ferias sectoriales globales (anuales, sede fija) ────────────────────
  {
    kind: "recurring", key: "ces", name: "CES", category: "trade-fair",
    sector: "Tecnologia y electronica",
    start: wd(1, 3, 1), days: 4, approximate: true,
    city: "Las Vegas", country: "Estados Unidos", venue: "Las Vegas Convention Center",
    lat: 36.1699, lng: -115.1398,
    attendees: 140000, nightsHint: 4, dayPattern: "midweek",
    note: "La feria que mas tensiona una plaza hotelera en el mundo",
  },
  {
    kind: "recurring", key: "mwc", name: "MWC Barcelona", category: "trade-fair",
    sector: "Telecomunicaciones",
    start: wd(3, 1, 1), days: 4,
    city: "Barcelona", country: "Espana", venue: "Fira Gran Via",
    lat: 41.3874, lng: 2.1686,
    attendees: 100000, nightsHint: 4, dayPattern: "midweek",
    note: "Dispara las tarifas de Barcelona varias semanas antes",
  },
  {
    kind: "recurring", key: "itb", name: "ITB Berlin", category: "trade-fair",
    sector: "Turismo",
    start: wd(3, 2, 3), days: 3,
    city: "Berlin", country: "Alemania", venue: "Messe Berlin",
    lat: 52.52, lng: 13.405,
    attendees: 100000, nightsHint: 4, dayPattern: "midweek",
    note: "La feria de turismo mas grande; publico profesional",
  },
  {
    kind: "recurring", key: "fitur", name: "FITUR", category: "trade-fair",
    sector: "Turismo",
    start: wd(1, 3, 3), days: 5,
    city: "Madrid", country: "Espana", venue: "IFEMA Madrid",
    lat: 40.4168, lng: -3.7038,
    attendees: 250000, nightsHint: 4, dayPattern: "full-week",
    note: "Arranca profesional y cierra abierta al publico: el patron cambia el fin de semana",
  },
  {
    kind: "recurring", key: "websummit", name: "Web Summit", category: "tech",
    sector: "Tecnologia y startups",
    start: wd(11, 1, 2), days: 4, approximate: true,
    city: "Lisboa", country: "Portugal", venue: "MEO Arena / FIL",
    lat: 38.7223, lng: -9.1393,
    attendees: 70000, nightsHint: 4, dayPattern: "midweek",
  },
  {
    kind: "recurring", key: "gamescom", name: "Gamescom", category: "tech",
    sector: "Videojuegos",
    start: wd(8, 3, 3), days: 5, approximate: true,
    city: "Colonia", country: "Alemania", venue: "Koelnmesse",
    lat: 50.9375, lng: 6.9603,
    attendees: 320000, nightsHint: 3, dayPattern: "full-week",
    note: "Publico masivo, no solo profesional",
  },
  {
    kind: "recurring", key: "hotelga", name: "Hotelga", category: "trade-fair",
    sector: "Hoteleria y gastronomia",
    start: wd(9, 2, 1), days: 3, approximate: true,
    city: "Buenos Aires", country: "Argentina", venue: "La Rural",
    lat: -34.5800, lng: -58.4100,
    attendees: 25000, nightsHint: 3, dayPattern: "midweek",
    note: "La feria del sector propio en el mercado propio",
  },
  {
    kind: "recurring", key: "fit-ar", name: "FIT America Latina", category: "trade-fair",
    sector: "Turismo",
    start: wd(9, 6, -1), days: 4, approximate: true,
    city: "Buenos Aires", country: "Argentina", venue: "La Rural",
    lat: -34.5800, lng: -58.4100,
    attendees: 100000, nightsHint: 3, dayPattern: "full-week",
  },
  {
    kind: "recurring", key: "expo-agro", name: "Expoagro", category: "trade-fair",
    sector: "Agro",
    start: wd(3, 2, 2), days: 4, approximate: true,
    city: "San Nicolas", country: "Argentina",
    lat: -33.3358, lng: -60.2128,
    attendees: 150000, nightsHint: 3, dayPattern: "midweek",
    note: "Satura una ciudad chica: el impacto relativo es enorme",
  },

  // ── Foros economicos ────────────────────────────────────────────────────
  {
    kind: "recurring", key: "davos", name: "Foro Economico Mundial (Davos)", category: "forum",
    sector: "Economia y politica",
    start: wd(1, 1, 3), days: 5,
    city: "Davos", country: "Suiza", venue: "Davos Congress Centre",
    lat: 46.8027, lng: 9.8360,
    attendees: 3000, nightsHint: 5, dayPattern: "midweek",
    note: "Pocos asistentes pero un pueblo de 11.000 habitantes: agota todo el valle",
  },

  // ── Congresos medicos y cientificos ─────────────────────────────────────
  // Sede rotativa anio a anio: solo se listan los de sede estable o ya
  // anunciada. El resto se declara como hueco.
  {
    kind: "recurring", key: "jpmorgan-health", name: "J.P. Morgan Healthcare Conference",
    category: "congress", sector: "Salud y biotecnologia",
    start: wd(1, 1, 2), days: 4, approximate: true,
    city: "San Francisco", country: "Estados Unidos",
    lat: 37.7749, lng: -122.4194,
    attendees: 9000, nightsHint: 4, dayPattern: "midweek",
    note: "La semana mas cara del anio para los hoteles de San Francisco",
  },

  // ── Cumbres con sede ya adjudicada ──────────────────────────────────────
  {
    kind: "one-off", key: "g20-2026", name: "Cumbre del G20 2026", category: "summit",
    sector: "Diplomacia",
    startDate: "2026-12-14", endDate: "2026-12-15",
    city: "Miami", country: "Estados Unidos",
    lat: 25.7617, lng: -80.1918,
    attendees: 5000, nightsHint: 4, dayPattern: "midweek",
    note: "Bloquea zonas enteras por seguridad, ademas de llenar hoteles",
  },
  {
    kind: "one-off", key: "cop31", name: "COP31", category: "summit",
    sector: "Clima y medio ambiente",
    startDate: "2026-11-09", endDate: "2026-11-20",
    city: "Antalya", country: "Turquia", venue: "Antalya Expo Center",
    lat: 36.8969, lng: 30.7133,
    attendees: 50000, nightsHint: 12, dayPattern: "full-week",
    note: "Dos semanas completas: es el evento MICE de estadia mas larga que existe",
  },
  {
    kind: "one-off", key: "cop32", name: "COP32", category: "summit",
    sector: "Clima y medio ambiente",
    startDate: "2027-11-08", endDate: "2027-11-19",
    city: "Addis Abeba", country: "Etiopia",
    lat: 9.0250, lng: 38.7469,
    attendees: 40000, nightsHint: 12, dayPattern: "full-week",
    note: "Fechas estimadas: la CMNUCC todavia no publico el calendario exacto",
  },
];

/** Lo que todavia no tiene sede adjudicada o no se puede afirmar. */
export const PENDING_MICE: string[] = [
  "Cumbre del G20 2027: sede sin confirmar",
  "Congresos medicos de sede rotativa (ESMO, ASCO, ESC): la sede se anuncia con ~1 anio y no hay API",
  "Lanzamientos corporativos, asambleas de accionistas y viajes de incentivo: no se publican en ningun calendario abierto",
];

export interface ResolvedCongress extends CongressDef {
  startDate: string;
  endDate: string;
  category: MiceCategory;
  approximate?: boolean;
}

const MS_DAY = 86_400_000;

/** Resuelve las ediciones (recurrentes por regla + puntuales) de los anios dados. */
export function congressesFor(years: number[]): ResolvedCongress[] {
  const out: ResolvedCongress[] = [];
  for (const def of CONGRESSES) {
    if (def.kind === "one-off") {
      const { kind: _k, startDate, endDate, ...rest } = def;
      out.push({ ...rest, startDate, endDate });
      continue;
    }
    for (const year of years) {
      const startDate = resolveRule(def.start, year);
      const end = new Date(
        new Date(`${startDate}T00:00:00Z`).getTime() + (def.days - 1) * MS_DAY,
      );
      const { kind: _k, start: _s, days: _d, ...rest } = def;
      out.push({ ...rest, startDate, endDate: end.toISOString().slice(0, 10) });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}
