// Tablas curadas del hub regulatorio (event-list.md §8).
//
// Nada de esto tiene API. Son marcos normativos: se publican en boletines
// oficiales, cambian por ley y no hay nadie agregandolos en formato abierto.
// Mismo criterio que el calendario escolar del §2 y los congresos del §5:
// curado, fechado, y con lo pendiente declarado en vez de simulado.
//
// CADA ENTRADA LLEVA `asOf`. Una norma derogada que se sigue mostrando es peor
// que no mostrar nada, asi que la fecha viaja hasta la pantalla.

/** Bloques de libre transito o movilidad reducida entre sus miembros. */
export interface TransitBloc {
  key: string;
  name: string;
  /** Que permite en la practica para un turista. */
  effect: string;
  members: string[];
}

export const BLOCS: TransitBloc[] = [
  {
    key: "schengen",
    name: "Espacio Schengen",
    effect: "Sin control fronterizo entre miembros; una sola entrada habilita todo el espacio",
    members: [
      "AT", "BE", "BG", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
      "IS", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO",
      "SK", "SI", "ES", "SE", "CH",
    ],
  },
  {
    key: "mercosur",
    name: "Mercosur (residencia y transito)",
    effect: "Se entra con documento de identidad, sin pasaporte ni visa",
    members: ["AR", "BR", "PY", "UY", "BO", "CL", "PE", "CO", "EC"],
  },
  {
    key: "can",
    name: "Comunidad Andina",
    effect: "Transito con documento nacional entre miembros",
    members: ["BO", "CO", "EC", "PE"],
  },
  {
    key: "ca4",
    name: "CA-4",
    effect: "Libre circulacion centroamericana con documento nacional",
    members: ["GT", "HN", "SV", "NI"],
  },
  {
    key: "caricom",
    name: "CARICOM",
    effect: "Entrada facilitada para nacionales del bloque",
    members: [
      "AG", "BS", "BB", "BZ", "DM", "GD", "GY", "HT", "JM", "KN", "LC", "VC",
      "SR", "TT",
    ],
  },
  {
    key: "gcc",
    name: "Consejo de Cooperacion del Golfo",
    effect: "Circulacion con documento nacional entre miembros",
    members: ["SA", "AE", "KW", "QA", "BH", "OM"],
  },
  {
    key: "eac",
    name: "Comunidad de Africa Oriental",
    effect: "Transito con documento nacional; visa unica turistica en parte del bloque",
    members: ["KE", "UG", "TZ", "RW", "BI", "SS"],
  },
  {
    key: "ecowas",
    name: "CEDEAO",
    effect: "Libre circulacion de nacionales del bloque",
    members: [
      "BJ", "BF", "CV", "CI", "GM", "GH", "GN", "GW", "LR", "ML", "NE", "NG",
      "SN", "SL", "TG",
    ],
  },
  {
    key: "ttta",
    name: "Trans-Tasman Travel Arrangement",
    effect: "Residencia y trabajo reciprocos entre Australia y Nueva Zelanda",
    members: ["AU", "NZ"],
  },
  {
    key: "cta",
    name: "Common Travel Area",
    effect: "Circulacion libre entre Reino Unido e Irlanda",
    members: ["GB", "IE"],
  },
];

/** Bloques que comparten destino y emisor. */
export function blocsFor(a: string, b: string): TransitBloc[] {
  return BLOCS.filter((x) => x.members.includes(a) && x.members.includes(b));
}

// ── Regulacion del alquiler temporario ────────────────────────────────────
//
// Es el item de esta categoria con efecto mas directo sobre un hotel, y va al
// reves que todos los demas: no cambia si el huesped VIENE, cambia CON QUIEN
// se aloja. Una ciudad que limita el alquiler temporario le devuelve demanda a
// la hoteleria; una que lo libera se la saca.

export type StrSeverity = "ban" | "heavy" | "moderate" | "registry";

export interface StrRule {
  /** Ciudad o jurisdiccion. */
  city: string;
  country: string;
  lat: number;
  lng: number;
  /** Radio en km dentro del cual aplica la norma. */
  radiusKm: number;
  severity: StrSeverity;
  summary: string;
  /** Anio de la ultima verificacion de esta entrada. */
  asOf: number;
}

export const STR_RULES: StrRule[] = [
  {
    city: "Barcelona", country: "ES", lat: 41.3874, lng: 2.1686, radiusKm: 20,
    severity: "ban",
    summary: "Baja programada de las ~10.000 licencias de piso turistico hacia 2028; no se emiten nuevas",
    asOf: 2025,
  },
  {
    city: "Nueva York", country: "US", lat: 40.7128, lng: -74.006, radiusKm: 30,
    severity: "ban",
    summary: "Local Law 18: estadias de menos de 30 dias solo con anfitrion presente y registro; la oferta se desplomo",
    asOf: 2025,
  },
  {
    city: "Singapur", country: "SG", lat: 1.3521, lng: 103.8198, radiusKm: 25,
    severity: "ban",
    summary: "Alquiler de menos de 3 meses prohibido en vivienda publica y privada",
    asOf: 2025,
  },
  {
    city: "Amsterdam", country: "NL", lat: 52.3676, lng: 4.9041, radiusKm: 15,
    severity: "heavy",
    summary: "Tope de 30 noches por ano, permiso obligatorio y prohibicion en algunos distritos",
    asOf: 2025,
  },
  {
    city: "Paris", country: "FR", lat: 48.8566, lng: 2.3522, radiusKm: 15,
    severity: "heavy",
    summary: "Tope de 120 noches para vivienda principal y registro obligatorio con numero visible",
    asOf: 2025,
  },
  {
    city: "Lisboa", country: "PT", lat: 38.7223, lng: -9.1393, radiusKm: 15,
    severity: "heavy",
    summary: "Suspension de nuevas licencias de alojamiento local en buena parte de la ciudad",
    asOf: 2025,
  },
  {
    city: "Berlin", country: "DE", lat: 52.52, lng: 13.405, radiusKm: 20,
    severity: "heavy",
    summary: "Prohibicion de uso indebido de vivienda: se necesita permiso para alquilar entero",
    asOf: 2025,
  },
  {
    city: "Londres", country: "GB", lat: 51.5074, lng: -0.1278, radiusKm: 25,
    severity: "moderate",
    summary: "Tope de 90 noches por ano para vivienda entera sin permiso de cambio de uso",
    asOf: 2025,
  },
  {
    city: "Madrid", country: "ES", lat: 40.4168, lng: -3.7038, radiusKm: 20,
    severity: "moderate",
    summary: "Exigencia de acceso independiente en zona central, que excluye a la mayoria de los pisos",
    asOf: 2025,
  },
  {
    city: "San Francisco", country: "US", lat: 37.7749, lng: -122.4194, radiusKm: 20,
    severity: "moderate",
    summary: "Registro obligatorio y tope de 90 noches sin anfitrion presente",
    asOf: 2025,
  },
  {
    city: "Los Angeles", country: "US", lat: 34.0522, lng: -118.2437, radiusKm: 35,
    severity: "moderate",
    summary: "Home-Sharing Ordinance: solo vivienda principal y tope de 120 noches",
    asOf: 2025,
  },
  {
    city: "Ciudad de Mexico", country: "MX", lat: 19.4326, lng: -99.1332, radiusKm: 25,
    severity: "moderate",
    summary: "Registro obligatorio y tope sobre el porcentaje de noches por ano",
    asOf: 2025,
  },
  {
    city: "Japon (nacional)", country: "JP", lat: 35.6762, lng: 139.6503, radiusKm: 60,
    severity: "moderate",
    summary: "Ley minpaku: tope nacional de 180 noches por ano y registro",
    asOf: 2025,
  },
  {
    city: "Viena", country: "AT", lat: 48.2082, lng: 16.3738, radiusKm: 15,
    severity: "moderate",
    summary: "Alquiler turistico restringido en zonas residenciales sin permiso",
    asOf: 2025,
  },
  {
    city: "Buenos Aires", country: "AR", lat: -34.6037, lng: -58.3816, radiusKm: 25,
    severity: "registry",
    summary: "Registro de alojamientos turisticos obligatorio; sin tope de noches",
    asOf: 2025,
  },
];

/** Normas de alquiler temporario que alcanzan a un punto. */
export function strRulesNear(
  lat: number,
  lng: number,
  distance: (aLat: number, aLng: number, bLat: number, bLng: number) => number,
): Array<StrRule & { distanceKm: number }> {
  const out: Array<StrRule & { distanceKm: number }> = [];
  for (const r of STR_RULES) {
    const d = distance(lat, lng, r.lat, r.lng);
    if (d <= r.radiusKm) out.push({ ...r, distanceKm: Math.round(d) });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ── Requisitos sanitarios de entrada ──────────────────────────────────────
//
// De todos los requisitos sanitarios, el unico estable y exigible es la fiebre
// amarilla: la OMS publica la lista y no cambia de un ano a otro. Los de
// pandemia se levantaron y no hay fuente viva que los siga.

/** Paises que exigen certificado de fiebre amarilla a todo viajero. */
export const YELLOW_FEVER_ALL: string[] = [
  "AO", "BJ", "BF", "BI", "CM", "CF", "TD", "CG", "CD", "CI", "GQ", "GA",
  "GH", "GN", "GW", "LR", "ML", "NE", "NG", "RW", "SN", "SL", "SS", "TG",
  "UG", "GF",
];

/** Paises que lo exigen solo a quien llega desde una zona endemica. */
export const YELLOW_FEVER_IF_FROM_ENDEMIC: string[] = [
  "AR", "BR", "BO", "CO", "EC", "PE", "PY", "VE", "PA", "CR", "ZA", "KE",
  "TZ", "ET", "IN", "TH", "ID", "MY", "PH", "VN", "CN", "AU",
];

// ── Tasas y tramites pagos de entrada ─────────────────────────────────────

export interface EntryFee {
  /** Pais que la cobra. */
  country: string;
  name: string;
  amount: string;
  /** A quien alcanza. */
  appliesTo: string;
  asOf: number;
}

export const ENTRY_FEES: EntryFee[] = [
  { country: "US", name: "ESTA", amount: "USD 21", appliesTo: "Programa de Exencion de Visa", asOf: 2025 },
  { country: "GB", name: "ETA", amount: "GBP 16", appliesTo: "Visitantes exentos de visa", asOf: 2025 },
  { country: "AU", name: "ETA / eVisitor", amount: "AUD 20", appliesTo: "Visitantes elegibles", asOf: 2025 },
  { country: "NZ", name: "NZeTA + IVL", amount: "NZD 100", appliesTo: "Casi todo visitante", asOf: 2025 },
  { country: "JP", name: "Tasa de salida", amount: "JPY 1.000", appliesTo: "Todo pasajero que sale", asOf: 2025 },
];

/**
 * Lo que se sabe que falta. Se declara en vez de dejar el hueco mudo: si
 * alguien busca aranceles a extranjeros y no ve nada, tiene que poder saber si
 * es que no hay o que no se releva.
 */
export const PENDING_REGULATION: string[] = [
  "ETIAS de la Union Europea: aun sin fecha firme de entrada en vigor",
  "Tasas turisticas municipales: existen en cientos de ciudades y no hay registro central",
  "Zonas francas turisticas: figuran en normas nacionales dispersas",
  "Regulacion laboral hotelera: es convenio colectivo, cambia por pais y por provincia",
  "Politica de asilo y refugiados: no tiene efecto medible sobre la demanda hotelera",
];
