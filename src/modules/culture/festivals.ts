// Calendario cultural de sede fija (event-list.md §4).
//
// POR QUE ESTA CURADO: el intelligence-hub ya trae ~8000 eventos culturales de
// Ticketmaster, Eventbrite y 12 scrapers, pero eso es la COLA LARGA: lo que se
// vende con ticket y se publica con semanas de antelacion. Lo que no aparece
// ahi son los eventos ANCLA de cada ciudad — el Carnaval de Rio, el
// Oktoberfest, Cannes, la Vendimia — que se repiten todos los anios en el
// mismo lugar, se saben con anios de antelacion y son justo los que agotan la
// plaza hotelera entera.
//
// Se curan REGLAS, no fechas (mismo criterio que el calendario escolar del §2
// y los anuales del §3). Los que dependen de Pascua se DERIVAN: el Carnaval es
// exactamente Pascua menos 47/51 dias, verificado contra los feriados que
// publica Nager para Brasil y Argentina.

import { resolveRule, type DateRule } from "../calendar/observances";

export type CultureCategory =
  | "carnival"
  | "music"
  | "film"
  | "food"
  | "book"
  | "art"
  | "religious"
  | "parade"
  | "fashion"
  | "theatre";

export interface FestivalDef {
  key: string;
  name: string;
  category: CultureCategory;
  start: DateRule;
  days: number;
  city: string;
  country: string;
  lat: number;
  lng: number;
  impact: number;
  /** true = el organizador fija la fecha exacta cada anio. */
  approximate?: boolean;
  note?: string;
}

const wd = (month: number, weekday: number, nth: number): DateRule => ({
  kind: "nthWeekday", month, weekday, nth,
});
const fixed = (month: number, day: number): DateRule => ({ kind: "fixed", month, day });
/** Desplazamiento respecto del Domingo de Pascua. */
const easter = (days: number): DateRule => ({ kind: "easterOffset", days });

export const FESTIVALS: FestivalDef[] = [
  // ── Carnavales (todos derivados de Pascua) ──────────────────────────────
  // Viernes de carnaval = Pascua - 51; martes = Pascua - 47.
  {
    key: "carnival-rio", name: "Carnaval de Rio", category: "carnival",
    start: easter(-51), days: 5,
    city: "Rio de Janeiro", country: "Brasil", lat: -22.9068, lng: -43.1729,
    impact: 1.0, note: "El evento que mas satura la plaza hotelera de Rio",
  },
  {
    key: "carnival-salvador", name: "Carnaval de Salvador", category: "carnival",
    start: easter(-51), days: 6,
    city: "Salvador", country: "Brasil", lat: -12.9777, lng: -38.5016, impact: 0.95,
  },
  {
    key: "carnival-sp", name: "Carnaval de Sao Paulo", category: "carnival",
    start: easter(-51), days: 5,
    city: "Sao Paulo", country: "Brasil", lat: -23.5505, lng: -46.6333, impact: 0.85,
  },
  {
    key: "carnival-gualeguaychu", name: "Carnaval del Pais (Gualeguaychu)", category: "carnival",
    start: easter(-51), days: 4,
    city: "Gualeguaychu", country: "Argentina", lat: -33.0092, lng: -58.5172,
    impact: 0.95, note: "Corsos todos los sabados de enero y febrero; el pico es carnaval",
  },
  {
    key: "carnival-venecia", name: "Carnevale di Venezia", category: "carnival",
    start: easter(-63), days: 17,
    city: "Venecia", country: "Italia", lat: 45.4408, lng: 12.3155,
    impact: 0.9, approximate: true, note: "Arranca ~2 semanas antes del martes de carnaval",
  },
  {
    key: "carnival-oruro", name: "Carnaval de Oruro", category: "carnival",
    start: easter(-48), days: 3,
    city: "Oruro", country: "Bolivia", lat: -17.9833, lng: -67.15,
    impact: 0.9, note: "Patrimonio de la Humanidad (UNESCO)",
  },
  {
    key: "carnival-barranquilla", name: "Carnaval de Barranquilla", category: "carnival",
    start: easter(-49), days: 4,
    city: "Barranquilla", country: "Colombia", lat: 10.9639, lng: -74.7964, impact: 0.9,
  },

  // ── Musica ──────────────────────────────────────────────────────────────
  {
    key: "tomorrowland", name: "Tomorrowland", category: "music",
    start: wd(7, 5, 3), days: 3,
    city: "Boom", country: "Belgica", lat: 51.0894, lng: 4.3706,
    impact: 0.95, approximate: true, note: "Dos fines de semana consecutivos a fines de julio",
  },
  {
    key: "coachella", name: "Coachella", category: "music",
    start: wd(4, 5, 2), days: 3,
    city: "Indio", country: "Estados Unidos", lat: 33.7206, lng: -116.2156,
    impact: 0.95, approximate: true, note: "Dos fines de semana seguidos en abril",
  },
  {
    key: "glastonbury", name: "Glastonbury", category: "music",
    start: wd(6, 3, -1), days: 5,
    city: "Pilton", country: "Reino Unido", lat: 51.1500, lng: -2.5847,
    impact: 0.9, approximate: true, note: "No se hace todos los anios (anio sabatico periodico)",
  },
  {
    key: "rock-in-rio", name: "Rock in Rio", category: "music",
    start: wd(9, 5, 2), days: 7,
    city: "Rio de Janeiro", country: "Brasil", lat: -22.9068, lng: -43.1729,
    impact: 0.85, approximate: true, note: "Bienal en Rio; alterna con Lisboa",
  },
  {
    key: "lollapalooza-ar", name: "Lollapalooza Argentina", category: "music",
    start: wd(3, 5, 3), days: 3,
    city: "San Isidro", country: "Argentina", lat: -34.4708, lng: -58.5083,
    impact: 0.85, approximate: true, note: "Hipodromo de San Isidro, marzo",
  },

  // ── Cine ────────────────────────────────────────────────────────────────
  {
    key: "cannes", name: "Festival de Cannes", category: "film",
    start: wd(5, 2, 2), days: 12,
    city: "Cannes", country: "Francia", lat: 43.5528, lng: 7.0174,
    impact: 0.95, approximate: true, note: "Satura toda la Costa Azul, no solo Cannes",
  },
  {
    key: "berlinale", name: "Berlinale", category: "film",
    start: wd(2, 4, 2), days: 11,
    city: "Berlin", country: "Alemania", lat: 52.52, lng: 13.405,
    impact: 0.8, approximate: true,
  },
  {
    key: "venecia-cine", name: "Mostra de Venecia", category: "film",
    start: wd(8, 3, -1), days: 11,
    city: "Venecia", country: "Italia", lat: 45.4408, lng: 12.3155,
    impact: 0.85, approximate: true,
  },
  {
    key: "sundance", name: "Sundance", category: "film",
    start: wd(1, 4, 3), days: 11,
    city: "Park City", country: "Estados Unidos", lat: 40.6461, lng: -111.4980,
    impact: 0.9, approximate: true, note: "Ciudad chica: el impacto relativo es enorme",
  },
  {
    key: "san-sebastian", name: "Festival de San Sebastian", category: "film",
    start: wd(9, 5, 3), days: 9,
    city: "San Sebastian", country: "Espana", lat: 43.3183, lng: -1.9812,
    impact: 0.85, approximate: true,
  },
  {
    key: "mar-del-plata", name: "Festival de Cine de Mar del Plata", category: "film",
    start: wd(11, 4, 1), days: 9,
    city: "Mar del Plata", country: "Argentina", lat: -38.0055, lng: -57.5426,
    impact: 0.6, approximate: true, note: "Unico clase A de America Latina",
  },

  // ── Gastronomia y vino ──────────────────────────────────────────────────
  {
    key: "oktoberfest", name: "Oktoberfest", category: "food",
    start: wd(9, 6, 3), days: 17,
    city: "Munich", country: "Alemania", lat: 48.1351, lng: 11.5820,
    impact: 1.0,
    note: "Arranca el sabado siguiente al 15/9 y cierra el primer domingo de octubre",
  },
  {
    key: "vendimia", name: "Fiesta Nacional de la Vendimia", category: "food",
    start: wd(3, 6, 1), days: 4,
    city: "Mendoza", country: "Argentina", lat: -32.8895, lng: -68.8458,
    impact: 0.95, note: "Primer fin de semana de marzo; agota Mendoza y alrededores",
  },
  {
    key: "tomatina", name: "La Tomatina", category: "food",
    start: wd(8, 3, -1), days: 1,
    city: "Bunol", country: "Espana", lat: 39.4197, lng: -0.7906,
    impact: 0.8, note: "Ultimo miercoles de agosto",
  },
  {
    key: "san-fermin", name: "San Fermin (encierros)", category: "food",
    start: fixed(7, 6), days: 9,
    city: "Pamplona", country: "Espana", lat: 42.8125, lng: -1.6458,
    impact: 0.95, note: "Del 6 al 14 de julio, fechas fijas",
  },

  // ── Ferias del libro ────────────────────────────────────────────────────
  {
    key: "frankfurt-book", name: "Feria del Libro de Frankfurt", category: "book",
    start: wd(10, 3, 2), days: 5,
    city: "Frankfurt", country: "Alemania", lat: 50.1109, lng: 8.6821,
    impact: 0.85, approximate: true, note: "La feria editorial mas grande del mundo",
  },
  {
    key: "feria-libro-ba", name: "Feria del Libro de Buenos Aires", category: "book",
    start: wd(4, 4, -1), days: 20,
    city: "Buenos Aires", country: "Argentina", lat: -34.5800, lng: -58.4100,
    impact: 0.6, approximate: true, note: "La Rural, tres semanas entre abril y mayo",
  },
  {
    key: "fil-guadalajara", name: "FIL Guadalajara", category: "book",
    start: wd(11, 6, -1), days: 9,
    city: "Guadalajara", country: "Mexico", lat: 20.6597, lng: -103.3496,
    impact: 0.8, approximate: true,
  },

  // ── Arte ────────────────────────────────────────────────────────────────
  {
    key: "bienal-venecia", name: "Bienal de Venecia", category: "art",
    start: wd(4, 6, 3), days: 200,
    city: "Venecia", country: "Italia", lat: 45.4408, lng: 12.3155,
    impact: 0.7, approximate: true,
    note: "Se hace todos los anios alternando arte (pares) y arquitectura (impares)",
  },
  {
    key: "arco-madrid", name: "ARCO Madrid", category: "art",
    start: wd(3, 3, 1), days: 5,
    city: "Madrid", country: "Espana", lat: 40.4168, lng: -3.7038,
    impact: 0.6, approximate: true,
  },

  // ── Desfiles y fechas tematicas ─────────────────────────────────────────
  {
    key: "st-patrick", name: "San Patricio", category: "parade",
    start: fixed(3, 17), days: 1,
    city: "Dublin", country: "Irlanda", lat: 53.3498, lng: -6.2603,
    impact: 0.85, note: "Fecha fija; se celebra en medio mundo",
  },
  {
    key: "dia-muertos", name: "Dia de Muertos", category: "religious",
    start: fixed(11, 1), days: 2,
    city: "Ciudad de Mexico", country: "Mexico", lat: 19.4326, lng: -99.1332,
    impact: 0.9, note: "Patrimonio de la Humanidad; pico turistico de CDMX y Oaxaca",
  },
  {
    key: "halloween", name: "Halloween", category: "parade",
    start: fixed(10, 31), days: 1,
    city: "Nueva York", country: "Estados Unidos", lat: 40.7128, lng: -74.006,
    impact: 0.7, note: "Ancla al Village Halloween Parade; la fecha aplica global",
  },

  // ── Peregrinaciones ─────────────────────────────────────────────────────
  {
    key: "santiago", name: "Camino de Santiago (temporada alta)", category: "religious",
    start: fixed(7, 1), days: 62,
    city: "Santiago de Compostela", country: "Espana", lat: 42.8805, lng: -8.5457,
    impact: 0.8, approximate: true,
    note: "Julio y agosto concentran el grueso; el 25/7 es el Dia de Santiago",
  },
  {
    key: "lourdes", name: "Peregrinacion a Lourdes", category: "religious",
    start: fixed(8, 15), days: 1,
    city: "Lourdes", country: "Francia", lat: 43.0951, lng: -0.0458,
    impact: 0.8, note: "Asuncion: el pico del ano en una ciudad de 13.000 habitantes",
  },

  // ── Moda ────────────────────────────────────────────────────────────────
  // Las cuatro capitales corren en cadena: NY, Londres, Milan y Paris.
  {
    key: "fashion-ny", name: "New York Fashion Week", category: "fashion",
    start: wd(9, 5, 2), days: 6,
    city: "Nueva York", country: "Estados Unidos", lat: 40.7128, lng: -74.006,
    impact: 0.7, approximate: true, note: "Dos ediciones al ano: febrero y septiembre",
  },
  {
    key: "fashion-milan", name: "Milano Fashion Week", category: "fashion",
    start: wd(9, 2, 3), days: 6,
    city: "Milan", country: "Italia", lat: 45.4642, lng: 9.19,
    impact: 0.75, approximate: true, note: "Dos ediciones al ano: febrero y septiembre",
  },
  {
    key: "fashion-paris", name: "Paris Fashion Week", category: "fashion",
    start: wd(9, 1, -1), days: 8,
    city: "Paris", country: "Francia", lat: 48.8566, lng: 2.3522,
    impact: 0.8, approximate: true, note: "Dos ediciones al ano: marzo y septiembre-octubre",
  },
];

export interface ResolvedFestival extends Omit<FestivalDef, "start" | "days"> {
  startDate: string;
  endDate: string;
}

const MS_DAY = 86_400_000;

/** Resuelve los festivales a fechas concretas de los anios dados. */
export function festivalsFor(years: number[]): ResolvedFestival[] {
  const out: ResolvedFestival[] = [];
  for (const year of years) {
    for (const def of FESTIVALS) {
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
