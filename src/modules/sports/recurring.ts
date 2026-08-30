// Eventos deportivos anuales de sede fija (event-list.md §3).
//
// A diferencia de los mega-eventos, estos se repiten TODOS los anios en el
// mismo lugar: los seis maratones Major, los cuatro Grand Slam, el Dakar, el
// Masters de golf. La sede no cambia; la fecha se mueve unos dias.
//
// Por eso se curan como REGLAS y no como fechas (mismo criterio que el
// calendario escolar del §2): hardcodear "2027-04-19" obliga a tocar el
// archivo cada anio, mientras que "tercer lunes de abril" vale siempre. Las
// reglas estan calibradas contra las fechas oficiales de 2027 donde se
// publicaron, y las que son aproximadas van marcadas.
//
// Las grandes vueltas ciclisticas son un caso aparte: el recorrido cambia
// cada anio, asi que solo se puede afirmar el pais y la ventana del mes. Van
// con `approximate: true` y ancladas a la ciudad de salida historica.

import { resolveRule, type DateRule } from "../calendar/observances";
import type { SportsCategory } from "./sports.types";

export interface RecurringEventDef {
  key: string;
  name: string;
  category: SportsCategory;
  sport: string;
  /** Regla de la fecha de inicio. */
  start: DateRule;
  /** Duracion en dias (1 = evento de un solo dia). */
  days: number;
  city: string;
  country: string;
  venue?: string;
  lat: number;
  lng: number;
  impact: number;
  nightsHint: number;
  /** true = la fecha exacta la fija el organizador cada anio. */
  approximate?: boolean;
  note?: string;
}

const sunday = (month: number, nth: number): DateRule => ({
  kind: "nthWeekday", month, weekday: 0, nth,
});
const monday = (month: number, nth: number): DateRule => ({
  kind: "nthWeekday", month, weekday: 1, nth,
});

export const RECURRING_EVENTS: RecurringEventDef[] = [
  // ── Maratones Major ─────────────────────────────────────────────────────
  {
    key: "marathon-tokyo", name: "Maraton de Tokio", category: "marathon",
    sport: "Atletismo", start: sunday(3, 1), days: 1,
    city: "Tokio", country: "Japon", lat: 35.6762, lng: 139.6503,
    impact: 0.75, nightsHint: 3,
  },
  {
    key: "marathon-boston", name: "Maraton de Boston", category: "marathon",
    sport: "Atletismo", start: monday(4, 3), days: 1,
    city: "Boston", country: "Estados Unidos", lat: 42.3601, lng: -71.0589,
    impact: 0.8, nightsHint: 3,
    note: "Siempre el Patriots Day: tercer lunes de abril",
  },
  {
    key: "marathon-london", name: "Maraton de Londres", category: "marathon",
    sport: "Atletismo", start: sunday(4, 4), days: 1,
    city: "Londres", country: "Reino Unido", lat: 51.5072, lng: -0.1276,
    impact: 0.8, nightsHint: 3, approximate: true,
  },
  {
    key: "marathon-berlin", name: "Maraton de Berlin", category: "marathon",
    sport: "Atletismo", start: sunday(9, -1), days: 1,
    city: "Berlin", country: "Alemania", lat: 52.52, lng: 13.405,
    impact: 0.8, nightsHint: 3,
    note: "Ultimo domingo de septiembre",
  },
  {
    key: "marathon-chicago", name: "Maraton de Chicago", category: "marathon",
    sport: "Atletismo", start: sunday(10, 2), days: 1,
    city: "Chicago", country: "Estados Unidos", lat: 41.8781, lng: -87.6298,
    impact: 0.8, nightsHint: 3,
  },
  {
    key: "marathon-nyc", name: "Maraton de Nueva York", category: "marathon",
    sport: "Atletismo", start: sunday(11, 1), days: 1,
    city: "Nueva York", country: "Estados Unidos", lat: 40.7128, lng: -74.006,
    impact: 0.9, nightsHint: 4,
    note: "Primer domingo de noviembre; el Major mas grande",
  },
  {
    key: "marathon-sydney", name: "Maraton de Sidney", category: "marathon",
    sport: "Atletismo", start: sunday(8, -1), days: 1,
    city: "Sidney", country: "Australia", lat: -33.8688, lng: 151.2093,
    impact: 0.7, nightsHint: 3, approximate: true,
    note: "Major desde 2025",
  },
  {
    key: "marathon-capetown", name: "Maraton de Ciudad del Cabo", category: "marathon",
    sport: "Atletismo", start: sunday(10, 3), days: 1,
    city: "Ciudad del Cabo", country: "Sudafrica", lat: -33.9249, lng: 18.4241,
    impact: 0.7, nightsHint: 3, approximate: true,
    note: "Se suma a los Majors en 2027",
  },
  {
    key: "marathon-bsas", name: "Maraton de Buenos Aires", category: "marathon",
    sport: "Atletismo", start: sunday(9, 3), days: 1,
    city: "Buenos Aires", country: "Argentina", lat: -34.6037, lng: -58.3816,
    impact: 0.6, nightsHint: 2, approximate: true,
    note: "Etiqueta oro de World Athletics; mercado propio",
  },

  // ── Grand Slams ─────────────────────────────────────────────────────────
  {
    key: "ao", name: "Abierto de Australia", category: "tennis",
    sport: "Tenis", start: monday(1, 2), days: 15,
    city: "Melbourne", country: "Australia", venue: "Melbourne Park",
    lat: -37.8136, lng: 144.9631, impact: 0.85, nightsHint: 15,
  },
  {
    key: "rg", name: "Roland Garros", category: "tennis",
    sport: "Tenis", start: sunday(5, -1), days: 15,
    city: "Paris", country: "Francia", venue: "Stade Roland Garros",
    lat: 48.8566, lng: 2.3522, impact: 0.85, nightsHint: 15, approximate: true,
  },
  {
    key: "wimbledon", name: "Wimbledon", category: "tennis",
    sport: "Tenis", start: monday(6, -1), days: 14,
    city: "Londres", country: "Reino Unido", venue: "All England Club",
    lat: 51.4340, lng: -0.2144, impact: 0.9, nightsHint: 14, approximate: true,
    note: "Arranca el lunes seis semanas antes del primer lunes de agosto",
  },
  {
    key: "usopen", name: "US Open", category: "tennis",
    sport: "Tenis", start: monday(8, -1), days: 15,
    city: "Nueva York", country: "Estados Unidos", venue: "Flushing Meadows",
    lat: 40.7500, lng: -73.8458, impact: 0.85, nightsHint: 15, approximate: true,
  },

  // ── Grandes vueltas ciclisticas ─────────────────────────────────────────
  // El recorrido cambia cada anio: solo la ventana y el pais son estables.
  // Se anclan a una ciudad de referencia y van marcadas como aproximadas.
  {
    key: "giro", name: "Giro de Italia", category: "cycling",
    sport: "Ciclismo", start: sunday(5, 1), days: 23,
    city: "Italia (recorrido variable)", country: "Italia",
    lat: 41.9028, lng: 12.4964, impact: 0.6, nightsHint: 23, approximate: true,
    note: "La salida cambia cada anio; a veces empieza fuera de Italia",
  },
  {
    key: "tdf", name: "Tour de Francia", category: "cycling",
    sport: "Ciclismo", start: sunday(7, 1), days: 23,
    city: "Francia (recorrido variable)", country: "Francia",
    lat: 46.6034, lng: 1.8883, impact: 0.75, nightsHint: 23, approximate: true,
    note: "Cada etapa mueve su propia ciudad; el Grand Depart suele ser en el extranjero",
  },
  {
    key: "vuelta", name: "Vuelta a Espana", category: "cycling",
    sport: "Ciclismo", start: sunday(8, -1), days: 23,
    city: "Espana (recorrido variable)", country: "Espana",
    lat: 40.4637, lng: -3.7492, impact: 0.6, nightsHint: 23, approximate: true,
  },

  // ── Otros de sede fija ──────────────────────────────────────────────────
  {
    key: "masters-golf", name: "Masters de Augusta", category: "golf",
    sport: "Golf", start: monday(4, 1), days: 7,
    city: "Augusta", country: "Estados Unidos", venue: "Augusta National",
    lat: 33.4735, lng: -82.0105, impact: 0.85, nightsHint: 7, approximate: true,
    note: "Satura una ciudad chica: el impacto relativo es enorme",
  },
  {
    key: "dakar", name: "Rally Dakar", category: "motorsport",
    sport: "Rally", start: { kind: "fixed", month: 1, day: 3 }, days: 14,
    city: "Arabia Saudita (recorrido variable)", country: "Arabia Saudita",
    lat: 24.7136, lng: 46.6753, impact: 0.6, nightsHint: 14, approximate: true,
    note: "Sede rotativa por decada; desde 2020 en Arabia Saudita",
  },
  {
    key: "indy500", name: "Indianapolis 500", category: "motorsport",
    sport: "Automovilismo", start: sunday(5, -1), days: 1,
    city: "Indianapolis", country: "Estados Unidos", venue: "Indianapolis Motor Speedway",
    lat: 39.7950, lng: -86.2347, impact: 0.85, nightsHint: 4,
    note: "Domingo del fin de semana de Memorial Day",
  },
];

export interface ResolvedRecurring extends Omit<RecurringEventDef, "start" | "days"> {
  startDate: string;
  endDate: string;
}

const MS_DAY = 86_400_000;

/** Resuelve los eventos recurrentes a fechas concretas de los anios dados. */
export function recurringEvents(years: number[]): ResolvedRecurring[] {
  const out: ResolvedRecurring[] = [];
  for (const year of years) {
    for (const def of RECURRING_EVENTS) {
      const startDate = resolveRule(def.start, year);
      const end = new Date(
        new Date(`${startDate}T00:00:00Z`).getTime() + (def.days - 1) * MS_DAY,
      );
      const { start: _s, days: _d, ...rest } = def;
      out.push({ ...rest, startDate, endDate: end.toISOString().slice(0, 10) });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}
