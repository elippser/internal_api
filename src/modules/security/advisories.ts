// Alertas de viaje de cancillerias (event-list.md §9).
//
// POR QUE ESTE ES EL DATO CENTRAL DE LA CATEGORIA
// Un hotel no pierde reservas porque suba el delito: las pierde cuando la
// cancilleria del mercado emisor sube el nivel de alerta. Ese acto es el que
// dispara las prohibiciones de viaje corporativo y las exclusiones de los
// seguros. El indice de criminalidad describe el riesgo; la alerta lo
// convierte en cancelaciones.
//
// DOS GOBIERNOS, NO UNO
// Se leen Canada y Estados Unidos porque publican en formato estructurado y
// con escalas equivalentes. Tener dos permite algo que uno solo no da:
// detectar DESACUERDO. Cuando dos cancillerias difieren dos niveles sobre el
// mismo pais, el riesgo esta en disputa y eso es informacion, no ruido.

const CA_URL = "https://data.international.gc.ca/travel-voyage/index-alpha-eng.json";
const US_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml";

const UA = "roombir-internal-security-hub/1.0 (+https://roombir.com)";

/**
 * Escala normalizada 1-4, comun a las dos fuentes:
 *   1 precauciones normales · 2 alta precaucion
 *   3 evitar viajes no esenciales · 4 evitar todo viaje
 *
 * Canada publica 0-3 y Estados Unidos 1-4, asi que el 0 canadiense y el 1
 * estadounidense son el mismo escalon.
 */
export type AdvisoryLevel = 1 | 2 | 3 | 4;

export const LEVEL_LABEL: Record<AdvisoryLevel, string> = {
  1: "Precauciones normales",
  2: "Alta precaucion",
  3: "Evitar viajes no esenciales",
  4: "Evitar todo viaje",
};

export interface CanadaAdvisory {
  level: AdvisoryLevel;
  text: string;
  /** Hay advertencias para regiones puntuales del pais. */
  regional: boolean;
  publishedAt: string;
  /** Que cambio en la ultima actualizacion. Es un indicador adelantado. */
  recentUpdate: string | null;
}

export interface AdvisorySet {
  canada: Map<string, CanadaAdvisory>;
  usa: Map<string, AdvisoryLevel>;
  /** ISO2 -> nombre en ingles, derivado del dataset canadiense. */
  namesByIso: Map<string, string>;
  /** Nombre normalizado en ingles -> ISO2, para parsear fuentes por nombre. */
  isoByName: Map<string, string>;
  canadaFetchedAt: string;
  usaAvailable: boolean;
}

interface CaRecord {
  "country-iso"?: string;
  "country-eng"?: string;
  "advisory-state"?: number;
  "has-regional-advisory"?: number;
  "date-published"?: { date?: string };
  eng?: { "advisory-text"?: string; "recent-updates"?: string };
}

/**
 * Rango de diacriticos combinantes (U+0300-U+036F). Se arma con escapes en
 * vez de escribir los caracteres directamente: son invisibles en el editor y
 * cualquier reencodeo del archivo los corrompe sin que nada falle.
 */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Normaliza un nombre de pais para poder cruzar fuentes que solo dan texto.
 *
 * Se saca "the" y el sufijo "travel advisory" que agrega el RSS estadounidense,
 * pero NO se sacan "republic", "democratic" ni "of": son justamente las
 * palabras que distinguen a la Republica Democratica del Congo de la Republica
 * del Congo. Colapsarlas haria que dos paises distintos compartan clave y que
 * uno pise al otro en el indice, en silencio.
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/&amp;/g, " ")
    .replace(/\btravel advisory\b/g, "")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Como nombra cada feed a los paises donde no coincide con Canada.
 *
 * Canada desambigua con parentesis ("Democratic Republic of Congo (Kinshasa)")
 * y los otros no, asi que 23 de 230 paises no cruzaban por nombre. El RSS trae
 * un `dc:identifier`, pero son codigos FIPS 10-4 (IZ = Iraq, UP = Ucrania), no
 * ISO: usarlos obligaria a mantener otra tabla de 200 filas. Esta lista de
 * excepciones es mas chica y se audita de un vistazo.
 *
 * Las entradas agregadas del RSS —"Mainland China, Hong Kong & Macau",
 * "French West Indies", "Israel, the West Bank and Gaza"— no son un pais y se
 * dejan afuera a proposito.
 */
export const NAME_ALIASES: Record<string, string> = {
  mexico: "MX",
  turkey: "TR",
  turkiye: "TR",
  burma: "MM",
  myanmar: "MM",
  "democratic republic of congo": "CD",
  "democratic republic of congo kinshasa": "CD",
  "republic of congo": "CG",
  "republic of congo brazzaville": "CG",
  "cote d ivoire": "CI",
  "ivory coast": "CI",
  eswatini: "SZ",
  swaziland: "SZ",
  "federated states of micronesia": "FM",
  micronesia: "FM",
  "timor leste": "TL",
  "east timor": "TL",
  macau: "MO",
  macao: "MO",
  "saint vincent and grenadines": "VC",
  "saint vincent grenadines": "VC",
  "kyrgyz republic": "KG",
  kyrgyzstan: "KG",
  "cape verde": "CV",
  "cabo verde": "CV",
  "vatican city": "VA",
  "holy see": "VA",
  israel: "IL",
  "west bank": "PS",
  gaza: "PS",
  "north macedonia": "MK",
  "south korea": "KR",
  "republic of korea": "KR",
  "north korea": "KP",
  laos: "LA",
  "lao people s republic": "LA",
  syria: "SY",
  "syrian arab republic": "SY",
  iran: "IR",
  russia: "RU",
  "russian federation": "RU",
  bolivia: "BO",
  venezuela: "VE",
  tanzania: "TZ",
  "united republic of tanzania": "TZ",
  moldova: "MD",
  "republic of moldova": "MD",
  brunei: "BN",
  "brunei darussalam": "BN",
};

/** Resuelve un nombre a ISO2: primero el indice de la fuente, despues alias. */
export function isoForName(name: string, index: Map<string, string>): string | null {
  const k = normalizeName(name);
  return index.get(k) ?? NAME_ALIASES[k] ?? null;
}

const clampLevel = (n: number): AdvisoryLevel => {
  if (n <= 1) return 1;
  if (n >= 4) return 4;
  return n as AdvisoryLevel;
};

async function loadCanada(): Promise<{
  advisories: Map<string, CanadaAdvisory>;
  namesByIso: Map<string, string>;
  isoByName: Map<string, string>;
}> {
  const res = await fetch(CA_URL, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error("Canada advisories HTTP " + res.status);
  const body = (await res.json()) as { data?: Record<string, CaRecord> };
  const data = body.data ?? {};

  const advisories = new Map<string, CanadaAdvisory>();
  const namesByIso = new Map<string, string>();
  const isoByName = new Map<string, string>();

  for (const rec of Object.values(data)) {
    const iso = (rec["country-iso"] ?? "").toUpperCase();
    if (!iso) continue;
    const eng = rec["country-eng"] ?? "";
    if (eng) {
      namesByIso.set(iso, eng);
      isoByName.set(normalizeName(eng), iso);
    }
    const state = rec["advisory-state"];
    if (typeof state !== "number") continue;
    advisories.set(iso, {
      // Canada arranca en 0; la escala comun arranca en 1.
      level: clampLevel(state + 1),
      text: rec.eng?.["advisory-text"] ?? "",
      regional: rec["has-regional-advisory"] === 1,
      publishedAt: (rec["date-published"]?.date ?? "").slice(0, 10),
      recentUpdate: rec.eng?.["recent-updates"] || null,
    });
  }
  if (advisories.size < 50) throw new Error("Canada advisories: dataset sospechosamente chico");
  return { advisories, namesByIso, isoByName };
}

/**
 * El feed de Estados Unidos es RSS y codifica el nivel en el titulo:
 *   "Iraq - Level 4: Do Not Travel"
 * Se lo cruza contra el indice de nombres del dataset canadiense en vez de
 * mantener otra tabla de paises a mano.
 */
async function loadUsa(isoByName: Map<string, string>): Promise<Map<string, AdvisoryLevel>> {
  const out = new Map<string, AdvisoryLevel>();
  const res = await fetch(US_URL, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error("US advisories HTTP " + res.status);
  const xml = await res.text();

  const re = /<title>([^<]*?)\s+-\s+Level\s+([1-4])\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const iso = isoForName(m[1], isoByName);
    if (!iso) continue;
    out.set(iso, clampLevel(Number(m[2])));
  }
  return out;
}

let cache: AdvisorySet | null = null;
let loadedAt = 0;
let inflight: Promise<AdvisorySet> | null = null;
// Las cancillerias revisan por excepcion, no a diario; 6 h es de sobra y evita
// castigar a dos fuentes oficiales con trafico innecesario.
const TTL = 6 * 60 * 60 * 1000;

async function load(): Promise<AdvisorySet> {
  const ca = await loadCanada();
  // Estados Unidos es complementario: si su RSS falla, el hub sigue con
  // Canada y lo declara. Canada, en cambio, es la columna vertebral.
  let usa = new Map<string, AdvisoryLevel>();
  let usaAvailable = false;
  try {
    usa = await loadUsa(ca.isoByName);
    usaAvailable = usa.size > 20;
  } catch {
    usaAvailable = false;
  }
  return {
    canada: ca.advisories,
    usa,
    namesByIso: ca.namesByIso,
    isoByName: ca.isoByName,
    canadaFetchedAt: new Date().toISOString(),
    usaAvailable,
  };
}

export async function advisorySet(): Promise<AdvisorySet> {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((v) => {
      cache = v;
      loadedAt = Date.now();
      return v;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
