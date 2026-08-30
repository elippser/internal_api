// Mega-eventos deportivos con sede y fecha conocidas (event-list.md §3).
//
// POR QUE ESTA CURADO: no existe API libre de "proximos Juegos Olimpicos" ni
// de sedes de mundiales. Y es justo lo mas valioso del §3 — un JJOO o un
// Mundial se adjudican 6-8 anios antes, o sea la antelacion mas larga de todo
// el catalogo de senales. Un hotel de la ciudad sede puede planificar tarifas
// con anios de anticipacion; ninguna otra categoria da eso.
//
// COMO SE MANTIENE: son pocas entradas (decenas, no miles) y cambian cuando
// el COI/FIFA/UEFA adjudican una sede nueva, o sea un par de veces por anio.
// Lo que TODAVIA no esta adjudicado no se inventa: se declara en
// PENDING_HOSTS y sale como hueco en el payload.
//
// Una sede por ciudad: el filtro del hub es por distancia, asi que un torneo
// multi-sede entra como varias filas que comparten `tournament`.

export interface MegaEventDef {
  /** Agrupa las sedes del mismo torneo. */
  tournament: string;
  name: string;
  sport: string;
  startDate: string;
  endDate: string;
  city: string;
  country: string;
  venue?: string;
  lat: number;
  lng: number;
  impact: number;
  nightsHint: number;
  note?: string;
}

export const MEGA_EVENTS: MegaEventDef[] = [
  // ── Juegos Olimpicos ────────────────────────────────────────────────────
  {
    tournament: "Juegos Olimpicos de Verano 2028",
    name: "Juegos Olimpicos Los Angeles 2028",
    sport: "Multideporte",
    startDate: "2028-07-14", endDate: "2028-07-30",
    city: "Los Angeles", country: "Estados Unidos",
    lat: 34.0522, lng: -118.2437,
    impact: 1.0, nightsHint: 17,
    note: "Sede unica; satura toda la cuenca de LA por semanas",
  },
  {
    tournament: "Juegos Olimpicos de Invierno 2030",
    name: "Juegos Olimpicos de Invierno Alpes Franceses 2030",
    sport: "Multideporte (invierno)",
    startDate: "2030-02-01", endDate: "2030-02-17",
    city: "Alpes franceses", country: "Francia",
    lat: 45.2, lng: 6.6,
    impact: 0.95, nightsHint: 17,
    note: "Sedes repartidas entre Saboya, Alta Saboya, Brianconnais y Niza",
  },
  {
    tournament: "Juegos Olimpicos de Verano 2032",
    name: "Juegos Olimpicos Brisbane 2032",
    sport: "Multideporte",
    startDate: "2032-07-23", endDate: "2032-08-08",
    city: "Brisbane", country: "Australia",
    lat: -27.4698, lng: 153.0251,
    impact: 1.0, nightsHint: 17,
  },
  {
    tournament: "Juegos Olimpicos de Invierno 2034",
    name: "Juegos Olimpicos de Invierno Salt Lake City 2034",
    sport: "Multideporte (invierno)",
    startDate: "2034-02-10", endDate: "2034-02-26",
    city: "Salt Lake City", country: "Estados Unidos",
    lat: 40.7608, lng: -111.891,
    impact: 0.95, nightsHint: 17,
  },

  // ── Mundial femenino 2027 (Brasil) ──────────────────────────────────────
  // Primera Copa del Mundo femenina en Sudamerica: mercado propio.
  {
    tournament: "Copa Mundial Femenina 2027",
    name: "Copa Mundial Femenina 2027 — Rio de Janeiro",
    sport: "Futbol",
    startDate: "2027-06-24", endDate: "2027-07-25",
    city: "Rio de Janeiro", country: "Brasil", venue: "Maracana",
    lat: -22.9068, lng: -43.1729,
    impact: 0.9, nightsHint: 32,
    note: "Sede de la final en el Maracana",
  },
  {
    tournament: "Copa Mundial Femenina 2027",
    name: "Copa Mundial Femenina 2027 — Sao Paulo",
    sport: "Futbol",
    startDate: "2027-06-24", endDate: "2027-07-25",
    city: "Sao Paulo", country: "Brasil",
    lat: -23.5505, lng: -46.6333,
    impact: 0.8, nightsHint: 32,
  },
  {
    tournament: "Copa Mundial Femenina 2027",
    name: "Copa Mundial Femenina 2027 — Brasilia",
    sport: "Futbol",
    startDate: "2027-06-24", endDate: "2027-07-25",
    city: "Brasilia", country: "Brasil",
    lat: -15.7939, lng: -47.8828,
    impact: 0.75, nightsHint: 32,
  },
  {
    tournament: "Copa Mundial Femenina 2027",
    name: "Copa Mundial Femenina 2027 — Salvador",
    sport: "Futbol",
    startDate: "2027-06-24", endDate: "2027-07-25",
    city: "Salvador", country: "Brasil",
    lat: -12.9777, lng: -38.5016,
    impact: 0.75, nightsHint: 32,
  },
  {
    tournament: "Copa Mundial Femenina 2027",
    name: "Copa Mundial Femenina 2027 — Belo Horizonte",
    sport: "Futbol",
    startDate: "2027-06-24", endDate: "2027-07-25",
    city: "Belo Horizonte", country: "Brasil",
    lat: -19.9167, lng: -43.9345,
    impact: 0.75, nightsHint: 32,
  },

  // ── Eurocopa 2028 (Reino Unido e Irlanda) ───────────────────────────────
  // Nueve estadios en ocho ciudades, confirmados por UEFA.
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Londres",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Londres", country: "Reino Unido", venue: "Wembley / Tottenham Hotspur",
    lat: 51.5072, lng: -0.1276, impact: 0.95, nightsHint: 31,
    note: "Dos estadios; sede de la final",
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Manchester",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Manchester", country: "Reino Unido", venue: "Manchester City Stadium",
    lat: 53.4808, lng: -2.2426, impact: 0.85, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Liverpool",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Liverpool", country: "Reino Unido", venue: "Everton Stadium",
    lat: 53.4084, lng: -2.9916, impact: 0.85, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Newcastle",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Newcastle", country: "Reino Unido", venue: "St James Park",
    lat: 54.9783, lng: -1.6178, impact: 0.8, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Birmingham",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Birmingham", country: "Reino Unido", venue: "Villa Park",
    lat: 52.4862, lng: -1.8904, impact: 0.8, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Cardiff",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Cardiff", country: "Reino Unido", venue: "National Stadium of Wales",
    lat: 51.4816, lng: -3.1791, impact: 0.8, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Glasgow",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Glasgow", country: "Reino Unido", venue: "Hampden Park",
    lat: 55.8642, lng: -4.2518, impact: 0.8, nightsHint: 31,
  },
  {
    tournament: "Eurocopa 2028", name: "Eurocopa 2028 — Dublin",
    sport: "Futbol", startDate: "2028-06-09", endDate: "2028-07-09",
    city: "Dublin", country: "Irlanda", venue: "Dublin Arena (Aviva)",
    lat: 53.3498, lng: -6.2603, impact: 0.85, nightsHint: 31,
  },

  // ── Mundial 2030 (centenario) ───────────────────────────────────────────
  // Sede principal Espana/Portugal/Marruecos, MAS tres partidos del
  // centenario en Sudamerica. Esos tres importan especialmente aca: son
  // mercado propio y llevan demanda internacional a la region.
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Madrid",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-07-21",
    city: "Madrid", country: "Espana", lat: 40.4168, lng: -3.7038,
    impact: 1.0, nightsHint: 44, note: "Sede principal",
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Barcelona",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-07-21",
    city: "Barcelona", country: "Espana", lat: 41.3874, lng: 2.1686,
    impact: 0.95, nightsHint: 44,
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Lisboa",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-07-21",
    city: "Lisboa", country: "Portugal", lat: 38.7223, lng: -9.1393,
    impact: 0.95, nightsHint: 44,
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Porto",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-07-21",
    city: "Porto", country: "Portugal", lat: 41.1579, lng: -8.6291,
    impact: 0.9, nightsHint: 44,
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Casablanca",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-07-21",
    city: "Casablanca", country: "Marruecos", lat: 33.5731, lng: -7.5898,
    impact: 0.95, nightsHint: 44,
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Montevideo (centenario)",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-06-12",
    city: "Montevideo", country: "Uruguay", venue: "Estadio Centenario",
    lat: -34.9011, lng: -56.1645, impact: 0.9, nightsHint: 5,
    note: "Partido del centenario: 100 anios del primer Mundial",
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Buenos Aires (centenario)",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-06-12",
    city: "Buenos Aires", country: "Argentina",
    lat: -34.6037, lng: -58.3816, impact: 0.85, nightsHint: 5,
    note: "Partido del centenario",
  },
  {
    tournament: "Copa Mundial 2030", name: "Mundial 2030 — Asuncion (centenario)",
    sport: "Futbol", startDate: "2030-06-08", endDate: "2030-06-12",
    city: "Asuncion", country: "Paraguay",
    lat: -25.2637, lng: -57.5759, impact: 0.85, nightsHint: 5,
    note: "Partido del centenario; sede de la CONMEBOL",
  },

  // ── Mundial 2034 (Arabia Saudita) ───────────────────────────────────────
  {
    tournament: "Copa Mundial 2034", name: "Mundial 2034 — Riad",
    sport: "Futbol", startDate: "2034-06-01", endDate: "2034-07-15",
    city: "Riad", country: "Arabia Saudita", lat: 24.7136, lng: 46.6753,
    impact: 1.0, nightsHint: 45,
    note: "Fechas aun no confirmadas por FIFA; ventana estimada",
  },

  // ── Super Bowl (sede anunciada con anios de antelacion) ─────────────────
  {
    tournament: "Super Bowl", name: "Super Bowl LXI",
    sport: "Futbol americano", startDate: "2027-02-14", endDate: "2027-02-14",
    city: "Inglewood (Los Angeles)", country: "Estados Unidos", venue: "SoFi Stadium",
    lat: 33.9535, lng: -118.3392, impact: 0.9, nightsHint: 4,
    note: "Primer Super Bowl jugado un 14 de febrero",
  },
  {
    tournament: "Super Bowl", name: "Super Bowl LXII",
    sport: "Futbol americano", startDate: "2028-02-13", endDate: "2028-02-13",
    city: "Atlanta", country: "Estados Unidos", venue: "Mercedes-Benz Stadium",
    lat: 33.7554, lng: -84.4008, impact: 0.9, nightsHint: 4,
  },
];

/**
 * Sedes todavia NO adjudicadas. Se listan a proposito: el hub las reporta
 * como hueco declarado en vez de dejar el silencio, que se lee igual que "no
 * hay nada". Cuando el organismo adjudique, la fila pasa a MEGA_EVENTS.
 */
export const PENDING_HOSTS: string[] = [
  "Copa America 2028: sede sin adjudicar (EE.UU. y Ecuador en negociacion)",
  "Juegos Olimpicos 2036 y 2038: sin adjudicar",
  "Mundial 2034: FIFA todavia no publico fechas exactas ni sedes por ciudad",
];
