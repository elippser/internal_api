// Tablas de referencia del hub economico (event-list.md §6).
//
// Datos estaticos a proposito: la moneda de un pais y su codigo ISO3 no
// cambian de un mes a otro, asi que no vale gastar una request ni depender de
// un tercero para resolverlos. Mismo criterio que las tablas curadas de §2
// (calendario escolar) y §5 (congresos).

/** ISO2 -> ISO3. Lo piden el FMI y el Banco Mundial; Nominatim devuelve ISO2. */
export const ISO3: Record<string, string> = {
  AR: "ARG", BO: "BOL", BR: "BRA", CL: "CHL", CO: "COL", CR: "CRI", CU: "CUB",
  DO: "DOM", EC: "ECU", GT: "GTM", HN: "HND", MX: "MEX", NI: "NIC", PA: "PAN",
  PE: "PER", PY: "PRY", SV: "SLV", UY: "URY", VE: "VEN", PR: "PRI",
  US: "USA", CA: "CAN",
  ES: "ESP", PT: "PRT", FR: "FRA", DE: "DEU", IT: "ITA", GB: "GBR", IE: "IRL",
  NL: "NLD", BE: "BEL", AT: "AUT", CH: "CHE", SE: "SWE", NO: "NOR", DK: "DNK",
  FI: "FIN", IS: "ISL", PL: "POL", CZ: "CZE", SK: "SVK", HU: "HUN", RO: "ROU",
  BG: "BGR", GR: "GRC", HR: "HRV", SI: "SVN", RS: "SRB", UA: "UKR", TR: "TUR",
  RU: "RUS", EE: "EST", LV: "LVA", LT: "LTU", LU: "LUX", CY: "CYP", MT: "MLT",
  AL: "ALB", BA: "BIH", MK: "MKD", ME: "MNE",
  CN: "CHN", JP: "JPN", KR: "KOR", IN: "IND", ID: "IDN", TH: "THA", VN: "VNM",
  MY: "MYS", SG: "SGP", PH: "PHL", HK: "HKG", TW: "TWN", KH: "KHM", LA: "LAO",
  NP: "NPL", LK: "LKA", BD: "BGD", PK: "PAK", KZ: "KAZ", UZ: "UZB",
  AE: "ARE", SA: "SAU", QA: "QAT", KW: "KWT", BH: "BHR", OM: "OMN", IL: "ISR",
  JO: "JOR", LB: "LBN", EG: "EGY", MA: "MAR", TN: "TUN", DZ: "DZA",
  ZA: "ZAF", KE: "KEN", NG: "NGA", GH: "GHA", TZ: "TZA", ET: "ETH", SN: "SEN",
  AU: "AUS", NZ: "NZL", FJ: "FJI",
};

/**
 * ISO2 -> moneda. La zona euro va toda a EUR, y los paises dolarizados
 * (Ecuador, El Salvador, Panama) a USD: para un viajero eso es lo que importa,
 * no la moneda nominal.
 */
export const CURRENCY: Record<string, string> = {
  AR: "ARS", BO: "BOB", BR: "BRL", CL: "CLP", CO: "COP", CR: "CRC", CU: "CUP",
  DO: "DOP", EC: "USD", GT: "GTQ", HN: "HNL", MX: "MXN", NI: "NIO", PA: "USD",
  PE: "PEN", PY: "PYG", SV: "USD", UY: "UYU", VE: "VES", PR: "USD",
  US: "USD", CA: "CAD",
  ES: "EUR", PT: "EUR", FR: "EUR", DE: "EUR", IT: "EUR", IE: "EUR", NL: "EUR",
  BE: "EUR", AT: "EUR", FI: "EUR", GR: "EUR", HR: "EUR", SI: "EUR", SK: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", LU: "EUR", CY: "EUR", MT: "EUR", ME: "EUR",
  GB: "GBP", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN",
  CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", RS: "RSD", UA: "UAH", TR: "TRY",
  RU: "RUB", AL: "ALL", BA: "BAM", MK: "MKD",
  CN: "CNY", JP: "JPY", KR: "KRW", IN: "INR", ID: "IDR", TH: "THB", VN: "VND",
  MY: "MYR", SG: "SGD", PH: "PHP", HK: "HKD", TW: "TWD", KH: "KHR", LA: "LAK",
  NP: "NPR", LK: "LKR", BD: "BDT", PK: "PKR", KZ: "KZT", UZ: "UZS",
  AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", IL: "ILS",
  JO: "JOD", LB: "LBP", EG: "EGP", MA: "MAD", TN: "TND", DZ: "DZD",
  ZA: "ZAR", KE: "KES", NG: "NGN", GH: "GHS", TZ: "TZS", ET: "ETB", SN: "XOF",
  AU: "AUD", NZ: "NZD", FJ: "FJD",
};

export const COUNTRY_NAME: Record<string, string> = {
  AR: "Argentina", BO: "Bolivia", BR: "Brasil", CL: "Chile", CO: "Colombia",
  UY: "Uruguay", PY: "Paraguay", PE: "Peru", EC: "Ecuador", VE: "Venezuela",
  MX: "Mexico", US: "Estados Unidos", CA: "Canada", CR: "Costa Rica",
  PA: "Panama", DO: "Republica Dominicana", CU: "Cuba", GT: "Guatemala",
  ES: "Espana", PT: "Portugal", FR: "Francia", DE: "Alemania", IT: "Italia",
  GB: "Reino Unido", IE: "Irlanda", NL: "Paises Bajos", BE: "Belgica",
  CH: "Suiza", AT: "Austria", SE: "Suecia", NO: "Noruega", DK: "Dinamarca",
  PL: "Polonia", RU: "Rusia", TR: "Turquia", GR: "Grecia",
  CN: "China", JP: "Japon", KR: "Corea del Sur", IN: "India", AU: "Australia",
  NZ: "Nueva Zelanda", ZA: "Sudafrica", IL: "Israel", AE: "Emiratos Arabes",
};

/**
 * Mercados emisores por destino: de donde viene el turismo receptivo.
 *
 * Curado. No hay API abierta de flujos bilaterales — la OMT vende sus series
 * y el Banco Mundial solo publica llegadas totales, sin desagregar por origen.
 * Estos son los emisores dominantes segun los organismos de turismo de cada
 * pais, y son los que definen contra que monedas se mide el destino.
 */
const EMITTERS_BY_COUNTRY: Record<string, string[]> = {
  AR: ["BR", "CL", "UY", "PY", "US", "ES"],
  BR: ["AR", "US", "CL", "UY", "PT", "DE"],
  CL: ["AR", "BR", "PE", "US", "ES"],
  UY: ["AR", "BR", "US", "ES"],
  PY: ["AR", "BR", "US"],
  PE: ["CL", "US", "EC", "ES", "BR"],
  CO: ["US", "MX", "EC", "ES", "BR"],
  BO: ["AR", "BR", "PE", "CL", "US"],
  EC: ["US", "CO", "PE", "ES"],
  MX: ["US", "CA", "CO", "ES", "AR"],
  US: ["CA", "MX", "GB", "JP", "DE", "BR"],
  CA: ["US", "GB", "FR", "MX", "DE"],
  ES: ["GB", "FR", "DE", "IT", "US", "AR"],
  PT: ["ES", "GB", "FR", "DE", "US", "BR"],
  FR: ["GB", "DE", "BE", "IT", "ES", "US"],
  IT: ["DE", "US", "FR", "GB", "CH"],
  DE: ["NL", "CH", "US", "AT", "GB"],
  GB: ["US", "FR", "DE", "IE", "ES"],
};

/** Emisores de arrastre global: pesan en casi cualquier destino turistico. */
const GLOBAL_EMITTERS = ["US", "DE", "GB", "FR", "CN"];

/** Vecinos regionales, para destinos sin tabla propia. */
const REGIONAL: Record<string, string[]> = {
  SA: ["AR", "BR", "CL", "US", "ES"],
  EU: ["DE", "GB", "FR", "IT", "NL"],
  AS: ["CN", "JP", "KR", "SG", "US"],
  AF: ["FR", "GB", "US", "ZA", "DE"],
  OC: ["AU", "NZ", "US", "GB"],
  NA: ["US", "CA", "MX", "GB"],
};

const REGION_OF: Record<string, string> = {
  AR: "SA", BO: "SA", BR: "SA", CL: "SA", CO: "SA", EC: "SA", PE: "SA",
  PY: "SA", UY: "SA", VE: "SA",
  US: "NA", CA: "NA", MX: "NA", CR: "NA", PA: "NA", DO: "NA", CU: "NA",
  GT: "NA", HN: "NA", NI: "NA", SV: "NA", PR: "NA",
  AU: "OC", NZ: "OC", FJ: "OC",
  ZA: "AF", KE: "AF", NG: "AF", GH: "AF", TZ: "AF", ET: "AF", SN: "AF",
  MA: "AF", TN: "AF", DZ: "AF", EG: "AF",
  CN: "AS", JP: "AS", KR: "AS", IN: "AS", ID: "AS", TH: "AS", VN: "AS",
  MY: "AS", SG: "AS", PH: "AS", HK: "AS", TW: "AS", KH: "AS", LA: "AS",
  NP: "AS", LK: "AS", BD: "AS", PK: "AS", KZ: "AS", UZ: "AS",
  AE: "AS", SA: "AS", QA: "AS", KW: "AS", BH: "AS", OM: "AS", IL: "AS",
  JO: "AS", LB: "AS", TR: "AS",
};

/**
 * Emisores del destino, sin repetir el propio pais. Si no hay tabla curada
 * cae al set regional + los de arrastre global: peor que el dato curado, pero
 * nunca vacio.
 */
export function emittersFor(destination: string): string[] {
  const curated = EMITTERS_BY_COUNTRY[destination];
  const base = curated ?? [
    ...(REGIONAL[REGION_OF[destination] ?? "EU"] ?? REGIONAL.EU),
    ...GLOBAL_EMITTERS,
  ];
  const seen = new Set<string>([destination]);
  const out: string[] = [];
  for (const cc of base) {
    if (seen.has(cc)) continue;
    seen.add(cc);
    out.push(cc);
  }
  return out.slice(0, 6);
}

/** true si el destino tiene tabla curada de emisores (no fallback regional). */
export const hasCuratedEmitters = (cc: string): boolean => cc in EMITTERS_BY_COUNTRY;

/**
 * Monedas que publica el BCE via Frankfurter. Son las unicas con serie
 * historica gratis: para el resto solo hay spot. Verificado contra
 * /v1/currencies.
 */
export const ECB_CURRENCIES = new Set([
  "EUR", "USD", "JPY", "BGN", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK",
  "CHF", "ISK", "NOK", "TRY", "AUD", "BRL", "CAD", "CNY", "HKD", "IDR", "ILS",
  "INR", "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR",
]);
