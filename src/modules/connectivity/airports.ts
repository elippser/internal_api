// Inventario de aeropuertos (event-list.md §7), desde OurAirports.
//
// Es dominio publico, se publica como CSV plano y trae los 86.000 aerodromos
// del mundo con tipo, pais, municipio, codigos IATA/OACI y —lo que mas
// importa aca— si tienen servicio regular de pasajeros.
//
// Se descarga una vez por proceso (12,7 MB) y queda filtrado en memoria: de
// las 86.000 filas solo interesan las ~5.300 con jerarquia de aeropuerto, asi
// que lo que se retiene es chico. El dataset cambia de a poco (una pista nueva
// por mes en todo el mundo), asi que el TTL es largo.

const CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

export interface AirportRecord {
  ident: string;
  type: "large_airport" | "medium_airport" | "small_airport";
  name: string;
  lat: number;
  lng: number;
  country: string;
  municipality: string;
  scheduledService: boolean;
  icao: string | null;
  iata: string | null;
}

let cache: AirportRecord[] | null = null;
let loadedAt = 0;
let inflight: Promise<AirportRecord[]> | null = null;
const TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Parser de una fila CSV con comillas. No se usa una libreria porque el
 * formato de OurAirports es estable y regular: campos separados por coma,
 * comillas dobles para texto, y comillas duplicadas para escaparlas.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const KEEP = new Set(["large_airport", "medium_airport", "small_airport"]);

async function load(): Promise<AirportRecord[]> {
  // fetchJson no sirve: esto es CSV. Se usa fetch directo con el mismo
  // criterio de timeout que el resto del hub.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(CSV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error("OurAirports HTTP " + res.status);
    const text = await res.text();
    const lines = text.split("\n");
    const header = splitCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
    const col = (name: string): number => header.indexOf(name);
    const iIdent = col("ident");
    const iType = col("type");
    const iName = col("name");
    const iLat = col("latitude_deg");
    const iLng = col("longitude_deg");
    const iCountry = col("iso_country");
    const iMuni = col("municipality");
    const iSched = col("scheduled_service");
    const iIcao = col("icao_code");
    const iIata = col("iata_code");

    const out: AirportRecord[] = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      const f = splitCsvLine(raw);
      const type = f[iType];
      if (!KEEP.has(type)) continue;
      const lat = Number(f[iLat]);
      const lng = Number(f[iLng]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Los aerodromos chicos sin servicio regular son ruido para esta
      // categoria: no traen turismo. Se retienen solo si tienen vuelos.
      const scheduled = f[iSched] === "yes";
      if (type === "small_airport" && !scheduled) continue;
      out.push({
        ident: f[iIdent],
        type: type as AirportRecord["type"],
        name: f[iName],
        lat,
        lng,
        country: (f[iCountry] || "").toUpperCase(),
        municipality: f[iMuni] || "",
        scheduledService: scheduled,
        icao: f[iIcao] || null,
        iata: f[iIata] || null,
      });
    }
    if (!out.length) throw new Error("OurAirports devolvio 0 aeropuertos utiles");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Catalogo completo, cacheado. Las llamadas concurrentes comparten la descarga. */
export async function allAirports(): Promise<AirportRecord[]> {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((rows) => {
      cache = rows;
      loadedAt = Date.now();
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const R_EARTH = 6371;
const rad = (d: number): number => (d * Math.PI) / 180;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

export interface NearbyAirport extends AirportRecord {
  distanceKm: number;
}

/** Aeropuertos dentro del radio, del mas cercano al mas lejano. */
export async function airportsNear(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<NearbyAirport[]> {
  const rows = await allAirports();
  const out: NearbyAirport[] = [];
  for (const a of rows) {
    // Filtro barato por caja antes de la trigonometria. Un grado de latitud son
    // ~111 km; se divide por 100 y no por 111 para que la caja quede holgada y
    // nunca descarte un aeropuerto que si entraba en el radio.
    if (Math.abs(a.lat - lat) > radiusKm / 100) continue;
    const d = haversineKm(lat, lng, a.lat, a.lng);
    if (d <= radiusKm) out.push({ ...a, distanceKm: Math.round(d) });
  }
  out.sort((x, y) => x.distanceKm - y.distanceKm);
  return out;
}

/** Indice por codigo OACI, para resolver los aeropuertos que devuelve adsbdb. */
export async function byIcao(): Promise<Map<string, AirportRecord>> {
  const rows = await allAirports();
  const m = new Map<string, AirportRecord>();
  for (const a of rows) {
    if (a.icao) m.set(a.icao.toUpperCase(), a);
    else if (a.ident) m.set(a.ident.toUpperCase(), a);
  }
  return m;
}
