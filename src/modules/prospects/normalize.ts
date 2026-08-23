import { PhoneNumberUtil, PhoneNumberFormat } from "google-libphonenumber";
import { LODGING_TYPES, type LodgingType } from "./prospects.model";

/**
 * Normalizacion de los datos crudos de un prospecto. Vive aparte del service
 * porque la usan dos entradas distintas: el import masivo (`importProspects`) y
 * el alta/edicion a mano desde el panel, y las dos tienen que dejar la ficha
 * exactamente igual.
 */

const phoneUtil = PhoneNumberUtil.getInstance();

// ---------------------------------------------------------------------------
// Telefono
// ---------------------------------------------------------------------------

export interface NormalizedPhone {
  /** E.164 (`+5493514567890`) o null si el numero no es valido. */
  e164: string | null;
  /** ISO-3166 alpha-2 del numero, o null. */
  country: string | null;
}

/**
 * Lleva un telefono a E.164. La fuente los trae en cualquier formato
 * (`3525 404037`, `+54 9 351 702 4200`, `011 6807-4773`, `54 9 2617085803`),
 * asi que se prueba en orden: tal cual si ya viene con `+`, y despues contra la
 * region que sugiere la ubicacion, con AR como ultimo recurso — la lista es
 * mayormente argentina y un numero local sin prefijo no se puede resolver de
 * otra manera.
 *
 * Si no valida en ninguna region devuelve `e164: null`: preferimos dejar el
 * crudo a la vista antes que inventar un numero que despues nadie atiende.
 */
export function normalizePhone(
  raw: string | null | undefined,
  hintRegion?: string | null,
): NormalizedPhone {
  const value = (raw ?? "").trim();
  if (!value) return { e164: null, country: null };

  const regions = [
    ...(value.startsWith("+") ? [undefined] : []),
    ...(hintRegion ? [hintRegion] : []),
    "AR",
  ];

  for (const region of regions) {
    try {
      const parsed = phoneUtil.parseAndKeepRawInput(value, region as string);
      if (!phoneUtil.isValidNumber(parsed)) continue;
      return {
        e164: phoneUtil.format(parsed, PhoneNumberFormat.E164),
        country: phoneUtil.getRegionCodeForNumber(parsed) ?? null,
      };
    } catch {
      // Formato imposible para esta region: se prueba la siguiente.
    }
  }
  return { e164: null, country: null };
}

// ---------------------------------------------------------------------------
// Web y email
// ---------------------------------------------------------------------------

/** Dominio normalizado (sin `www.`). Se usa para dedupe y para mostrar. */
export function domainOf(website?: string | null): string | undefined {
  if (!website) return undefined;
  const raw = website.trim().toLowerCase();
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Deja el sitio con esquema, para que el link del panel abra de verdad. */
export function normalizeWebsite(website?: string | null): string | undefined {
  const domain = domainOf(website);
  if (!domain) return undefined;
  const raw = (website ?? "").trim();
  return raw.includes("://") ? raw : `https://${domain}`;
}

export function normalizeEmail(email?: string | null): string | undefined {
  const value = (email ?? "").trim().toLowerCase();
  if (!value || !value.includes("@")) return undefined;
  return value;
}

/** Handle de Instagram: acepta `@perfil`, `perfil` o la URL entera. */
export function normalizeHandle(input?: string | null): string | undefined {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const fromUrl = raw.match(/instagram\.com\/([^/?#]+)/);
  const handle = (fromUrl ? fromUrl[1] : raw).replace(/^@/, "").replace(/\/$/, "");
  return /^[a-z0-9._]{1,64}$/.test(handle) ? handle : undefined;
}

// ---------------------------------------------------------------------------
// Tipo de alojamiento
// ---------------------------------------------------------------------------

/**
 * El `tipo_alojamiento` de la fuente viene como texto libre con barras
 * (`posada/hosteria/B&B`). Se mapea al catalogo cerrado; lo que no matchea cae
 * en `other` en vez de crear un valor nuevo — un enum abierto haria inutil el
 * filtro por tipo.
 */
const LODGING_ALIASES: Record<string, LodgingType> = {
  hotel: "hotel",
  "apart hotel": "apart_hotel",
  aparthotel: "apart_hotel",
  apart: "apart_hotel",
  resort: "resort",
  "lodge/refugio": "lodge",
  lodge: "lodge",
  refugio: "lodge",
  "posada/hosteria/b&b": "inn_bnb",
  posada: "inn_bnb",
  hosteria: "inn_bnb",
  "b&b": "inn_bnb",
  cabanias: "cabins",
  cabañas: "cabins",
  cabanas: "cabins",
  "depto/alquiler temporario": "apartment",
  depto: "apartment",
  departamento: "apartment",
  "alquiler temporario": "apartment",
  "casa/alojamiento": "house",
  casa: "house",
  "estancia/casa de campo": "country_house",
  estancia: "country_house",
  "casa de campo": "country_house",
  "glamping/domos": "glamping",
  glamping: "glamping",
  domos: "glamping",
  villas: "villas",
  villa: "villas",
  hostel: "hostel",
  camping: "camping",
  alojamiento: "other",
};

export function normalizeLodgingType(raw?: string | null): LodgingType {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "other";
  if ((LODGING_TYPES as readonly string[]).includes(value)) return value as LodgingType;
  return LODGING_ALIASES[value] ?? "other";
}

// ---------------------------------------------------------------------------
// Ubicacion
// ---------------------------------------------------------------------------

/**
 * La fuente trae la ubicacion como el texto del post ("Lago Puelo, Chubut,
 * Patagonia Argentina", "Sheraton Salta", "Puerto Varas, Los Lagos, Chile"), o
 * sea que a veces es un pais, a veces una provincia y a veces el nombre del
 * hotel. No se intenta estructurarla: se guarda el crudo y solo se deduce el
 * PAIS, que es lo unico que se puede afirmar sin inventar.
 */
const COUNTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\bargentina\b|\bpatagonia\b/i, "AR"],
  [/\buruguay\b|\bpunta del este\b|\bmontevideo\b|\bcolonia del sacramento\b/i, "UY"],
  [/\bchile\b/i, "CL"],
  [/\bbrasil\b|\bbrazil\b/i, "BR"],
  [/\bparaguay\b|\basunci[oó]n\b/i, "PY"],
  [/\bbolivia\b/i, "BO"],
  [/\bper[uú]\b/i, "PE"],
  [/\bcolombia\b/i, "CO"],
  [/\bm[eé]xico\b|\bmexico\b/i, "MX"],
  [/\bespa[nñ]a\b|\bspain\b/i, "ES"],
  [/\bestados unidos\b|\bunited states\b|\busa\b|\bflorida\b|\bmiami\b/i, "US"],
];

/**
 * Provincias argentinas y los destinos que en la fuente aparecen SIN pais. Se
 * usa solo despues de los patrones de pais, para no pisar "Cordoba, Espana".
 */
const AR_HINTS = [
  "buenos aires",
  "c[oó]rdoba",
  "cordoba",
  "mendoza",
  "salta",
  "jujuy",
  "tucum[aá]n",
  "neuqu[eé]n",
  "chubut",
  "santa cruz",
  "r[ií]o negro",
  "rio negro",
  "misiones",
  "entre r[ií]os",
  "corrientes",
  "chaco",
  "formosa",
  "santiago del estero",
  "catamarca",
  "la rioja",
  "san juan",
  "san luis",
  "santa fe",
  "la pampa",
  "tierra del fuego",
  "bariloche",
  "villa la angostura",
  "san mart[ií]n de los andes",
  "mar del plata",
  "mar de las pampas",
  "villa gesell",
  "pinamar",
  "c[aá]riló",
  "tandil",
  "el calafate",
  "el chalt[eé]n",
  "ushuaia",
  "puerto madryn",
  "traslasierra",
  "alta gracia",
  "villa general belgrano",
  "merlo",
  "cafayate",
  "purmamarca",
  "tilcara",
  "el bols[oó]n",
  "las grutas",
  "monte hermoso",
  "sierra de la ventana",
  "gualeguaych[uú]",
  "colon",
  "termas de r[ií]o hondo",
  "iguaz[uú]",
  "esquel",
  "villa carlos paz",
  "la cumbrecita",
  "nono",
  "mina clavero",
  "chascom[uú]s",
];
const AR_HINT_RX = new RegExp(`\\b(${AR_HINTS.join("|")})\\b`, "i");

/** Devuelve ISO-3166 alpha-2, o null cuando el texto no alcanza para afirmarlo. */
export function countryFromLocation(location?: string | null): string | null {
  const value = (location ?? "").trim();
  if (!value) return null;
  for (const [rx, code] of COUNTRY_PATTERNS) {
    if (rx.test(value)) return code;
  }
  return AR_HINT_RX.test(value) ? "AR" : null;
}

/**
 * Region = el ultimo segmento del texto que NO es el pais. Es la unidad con la
 * que un vendedor arma su ruta ("hoy llamo a los de Cordoba"), aunque a veces
 * caiga una ciudad en vez de una provincia; imperfecto pero util, y siempre se
 * puede leer el crudo al lado.
 */
export function regionFromLocation(location?: string | null): string | undefined {
  const value = (location ?? "").trim();
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (COUNTRY_PATTERNS.some(([rx]) => rx.test(part))) continue;
    return part.slice(0, 80);
  }
  // Todos los segmentos eran el pais ("Montevideo, Uruguay"): igual sirve el
  // primero como region antes que no devolver nada.
  return parts[0].slice(0, 80);
}

// ---------------------------------------------------------------------------
// Ficha completa
// ---------------------------------------------------------------------------

export interface RawProspectInput {
  name: string;
  handle?: string | null;
  handleUrl?: string | null;
  lodgingType?: string | null;
  location?: string | null;
  country?: string | null;
  region?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
}

export interface NormalizedProspect {
  name: string;
  handle?: string;
  handleUrl?: string;
  lodgingType: LodgingType;
  location?: string;
  country?: string;
  region?: string;
  contact: {
    phoneRaw?: string;
    phone?: string;
    phoneCountry?: string;
    email?: string;
    website?: string;
    websiteDomain?: string;
  };
}

/** Aplica todas las normalizaciones de arriba sobre una fila cruda. */
export function normalizeProspect(input: RawProspectInput): NormalizedProspect {
  const location = (input.location ?? "").trim() || undefined;
  const country = (input.country ?? "").trim().toUpperCase() || countryFromLocation(location);
  const phone = normalizePhone(input.phone, country);
  const website = normalizeWebsite(input.website);
  const handle = normalizeHandle(input.handle ?? input.handleUrl);

  return {
    name: input.name.trim().slice(0, 200),
    handle,
    handleUrl: handle ? `https://www.instagram.com/${handle}/` : undefined,
    lodgingType: normalizeLodgingType(input.lodgingType),
    location,
    // El pais del telefono manda sobre el texto: `+598 ...` es Uruguay aunque
    // el post diga "Punta del Este" sin mas.
    country: phone.country ?? country ?? undefined,
    region: (input.region ?? "").trim() || regionFromLocation(location),
    contact: {
      phoneRaw: (input.phone ?? "").trim() || undefined,
      phone: phone.e164 ?? undefined,
      phoneCountry: phone.country ?? undefined,
      email: normalizeEmail(input.email),
      website,
      websiteDomain: domainOf(website),
    },
  };
}
