// Matriz de visados (event-list.md §8), desde passport-index-dataset.
//
// Es la unica fuente abierta que cubre los 199x199 pares de pasaporte y
// destino. No hay API: es un CSV en GitHub mantenido por la comunidad a partir
// de las tablas de Wikipedia y del IATA Travel Centre.
//
// SOBRE LA FRESCURA, QUE ACA IMPORTA MAS QUE EN NINGUN OTRO HUB
// El dataset se actualiza a mano y por lotes. Su ultima actualizacion de DATOS
// se consulta contra la API de GitHub filtrando por el archivo (los commits al
// readme no cuentan) y viaja en el payload: una politica de visados que
// cambio despues de esa fecha no esta reflejada aca, y el panel lo dice en vez
// de presentar el dato como si fuera de hoy.

const CSV_URL =
  "https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-tidy-iso2.csv";
const COMMITS_URL =
  "https://api.github.com/repos/ilyankou/passport-index-dataset/commits?path=passport-index-tidy-iso2.csv&per_page=1";

/** Ultima actualizacion de datos conocida al escribir esto. Sirve de piso si
 *  GitHub no contesta: mejor una fecha vieja cierta que ninguna. */
const KNOWN_DATA_DATE = "2025-01-12";

export type VisaCategory =
  | "visa-free"
  | "eta"
  | "visa-on-arrival"
  | "e-visa"
  | "visa-required"
  | "no-admission"
  | "same-country"
  | "unknown";

export interface VisaRule {
  category: VisaCategory;
  /** Dias de estadia sin visa, cuando el dataset los especifica. */
  days: number | null;
  /** Valor crudo del dataset, para poder auditar la clasificacion. */
  raw: string;
}

/**
 * El dataset codifica la respuesta en una sola columna con tres formas
 * distintas: un numero (dias de estadia libre), una etiqueta de tramite, o -1
 * para la diagonal. Se normaliza a categoria + dias.
 */
export function classify(raw: string): VisaRule {
  const v = (raw ?? "").trim().toLowerCase();

  if (v === "-1") return { category: "same-country", days: null, raw };

  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    // Un numero son los dias que se puede estar sin visa.
    return { category: "visa-free", days: n, raw };
  }

  if (v === "visa free" || v === "visa-free" || v === "freedom of movement") {
    return { category: "visa-free", days: null, raw };
  }
  if (v === "eta") return { category: "eta", days: null, raw };
  if (v === "visa on arrival") return { category: "visa-on-arrival", days: null, raw };
  if (v === "e-visa" || v === "evisa") return { category: "e-visa", days: null, raw };
  if (v === "visa required") return { category: "visa-required", days: null, raw };
  if (v === "no admission") return { category: "no-admission", days: null, raw };

  return { category: "unknown", days: null, raw };
}

/** Cuanta friccion de entrada implica cada categoria, de menor a mayor. */
export const FRICTION: Record<VisaCategory, number> = {
  "same-country": 0,
  "visa-free": 1,
  eta: 2,
  "visa-on-arrival": 3,
  "e-visa": 4,
  "visa-required": 5,
  "no-admission": 6,
  unknown: 9,
};

export interface VisaMatrix {
  /** pasaporte -> destino -> regla */
  get(passport: string, destination: string): VisaRule | null;
  /** Fecha ISO de la ultima actualizacion de datos del dataset. */
  dataDate: string;
  passports: number;
}

let cache: VisaMatrix | null = null;
let loadedAt = 0;
let inflight: Promise<VisaMatrix> | null = null;
const TTL = 24 * 60 * 60 * 1000;

const UA = "roombir-internal-policy-hub/1.0 (+https://roombir.com)";

/** Fecha del ultimo commit que toco el CSV. Los del readme no cuentan. */
async function fetchDataDate(): Promise<string> {
  try {
    const res = await fetch(COMMITS_URL, {
      headers: { "user-agent": UA, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return KNOWN_DATA_DATE;
    const rows = (await res.json()) as Array<{ commit?: { committer?: { date?: string } } }>;
    const d = Array.isArray(rows) ? rows[0]?.commit?.committer?.date : undefined;
    return d ? d.slice(0, 10) : KNOWN_DATA_DATE;
  } catch {
    return KNOWN_DATA_DATE;
  }
}

async function load(): Promise<VisaMatrix> {
  const [res, dataDate] = await Promise.all([
    fetch(CSV_URL, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) }),
    fetchDataDate(),
  ]);
  if (!res.ok) throw new Error("passport-index HTTP " + res.status);
  const text = await res.text();

  const lines = text.split("\n");
  // Sin comillas ni comas dentro de los campos: son tres codigos cortos por
  // fila, asi que un split alcanza y evita arrastrar un parser de CSV.
  const table = new Map<string, VisaRule>();
  const passports = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const passport = parts[0].trim().toUpperCase();
    const destination = parts[1].trim().toUpperCase();
    const raw = parts.slice(2).join(",").trim();
    if (!passport || !destination) continue;
    passports.add(passport);
    table.set(passport + ">" + destination, classify(raw));
  }
  if (table.size < 1000) throw new Error("passport-index devolvio una matriz sospechosamente chica");

  return {
    get: (p, d) => table.get(p.toUpperCase() + ">" + d.toUpperCase()) ?? null,
    dataDate,
    passports: passports.size,
  };
}

export async function visaMatrix(): Promise<VisaMatrix> {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((m) => {
      cache = m;
      loadedAt = Date.now();
      return m;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Cuantos meses tiene el dato. Es lo que decide si se muestra una advertencia. */
export function monthsOld(dataDate: string): number {
  const then = new Date(dataDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / (30 * 86_400_000)));
}
