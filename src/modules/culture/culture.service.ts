// Hub de eventos culturales y de entretenimiento (event-list.md §4).
//
// Cuarto de la serie. Comparte el eje del §3 (dato puntual con radio) pero la
// mezcla de fuentes es distinta: aca la cola larga YA existia y lo que faltaba
// era el ancla.
//
//   · ANCLAS (curadas, `festivals.ts`): Carnaval, Oktoberfest, Cannes, la
//     Vendimia, San Fermin. Se repiten todos los anios en el mismo lugar, se
//     saben con anios de antelacion y agotan la plaza entera. Ninguna API de
//     ticketing las tiene porque no se venden con ticket, o porque son la
//     ciudad entera y no un recinto.
//   · COLA LARGA (`listings`): los ~8000 eventos que el intelligence-hub ya
//     ingesta de Ticketmaster, Eventbrite, Bandsintown y 12 scrapers.
//   · FIESTAS LUNARES: Ano Nuevo Chino y Diwali, que no se derivan de Pascua
//     ni caen en regla gregoriana. Se leen de Nager.Date, que ya usa el hub de
//     calendario: China y Singapur los publican como feriado oficial.
//
// NORMALIZACION DE TAXONOMIA — el trabajo menos vistoso y el mas necesario:
// los segmentos de la cola larga vienen crudos de cada fuente y son un
// desastre medido. En una corrida real habia 50 valores distintos mezclando
// ingles y espanol ("Music" y "musica"), mayusculas inconsistentes
// ("miscellaneous" 2896 y "Miscellaneous" 1474 como claves separadas),
// entidades HTML sin decodificar ("music &amp; comedy") y taxonomias locales
// de cada scraper ("biblioverano", "artes circenses", "paocc"). Sin
// normalizar, filtrar por categoria no sirve para nada.

import { fetchJson } from "../intelligence/core/http";
import { fetchIntelligence, isConfigured } from "../global/lib/intelligence";
import { festivalsFor, type CultureCategory } from "./festivals";
import type {
  CultureCoverage,
  CultureEvent,
  CulturePointPayload,
} from "./culture.types";

const NAGER_BASE = "https://date.nager.at/api/v3";
const MS_DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();

async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await load();
  store.set(key, { ts: Date.now(), value });
  return value;
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Normalizacion de la taxonomia ─────────────────────────────────────────

/** Decodifica las entidades que llegan sin resolver desde las fuentes. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Quita acentos para que "musica" y "música" caigan en el mismo cubo. */
const deaccent = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Mapea la etiqueta cruda de la fuente a una categoria del hub. El orden
 * importa: se evalua por inclusion, asi que lo mas especifico va primero.
 */
const RULES: Array<[RegExp, CultureCategory]> = [
  [/carnaval|carnival/, "carnival"],
  [/music|musica|concert|concierto|recital|comedy|dj|banda/, "music"],
  [/film|cine|movie|cortometraje|audiovisual/, "film"],
  [/gastro|food|wine|vino|cerveza|beer|culinar|degustacion/, "food"],
  [/book|libro|librer|literatura|bibliote|library|biblioverano|lectura/, "book"],
  // theatre va ANTES que art a proposito: "Arts & Theatre" es la categoria
  // de escenicas de Ticketmaster, no de artes visuales, y con el orden al
  // reves caia en art junto con los museos.
  [/theat|teatro|danza|dance|circo|circens|titere|performing|opera|ballet/, "theatre"],
  [/art|arte|museo|museum|galer|galler|exhibi|exposicion|fotograf|pintura|escultura|diseno|artesania|patrimonio/, "art"],
  [/fashion|moda|pasarela/, "fashion"],
  [/parade|desfile|pride|orgullo|fiesta|festival|feria|fair/, "parade"],
  [/religio|iglesia|patronal|peregrina|semana santa|procesion/, "religious"],
];

export function normalizeSegment(raw: string | null | undefined): CultureCategory | "other" {
  if (!raw) return "other";
  const s = deaccent(decodeEntities(String(raw))).toLowerCase().trim();
  if (!s || /^(miscellaneous|undefined|otros?|other|general)$/.test(s)) return "other";
  for (const [re, cat] of RULES) if (re.test(s)) return cat;
  return "other";
}

/** Segmentos que NO son culturales: los cubren otros hubs. */
const NON_CULTURAL = /^(sports?|sports? ?& ?recreation|conference|deporte)/;

function isCultural(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const s = deaccent(decodeEntities(String(raw))).toLowerCase().trim();
  return !NON_CULTURAL.test(s);
}

// ── Fiestas lunares (Nager: China y Singapur las publican) ────────────────

interface NagerHoliday { date: string; localName: string; name: string }

/**
 * Ano Nuevo Chino y Diwali. No salen de Pascua ni de una regla gregoriana, y
 * no hay API libre de calendario lunisolar chino/hindu. Pero China y Singapur
 * los declaran feriado oficial, asi que Nager —que ya usamos en el §2— los
 * publica con fecha exacta.
 */
async function lunarFeasts(years: number[]): Promise<Array<{ date: string; name: string; kind: "cny" | "diwali" }>> {
  const out: Array<{ date: string; name: string; kind: "cny" | "diwali" }> = [];
  for (const year of years) {
    try {
      const holidays = await memo(`nager:SG:${year}`, 7 * 24 * 60 * 60 * 1000, () =>
        fetchJson<NagerHoliday[]>(`${NAGER_BASE}/PublicHolidays/${year}/SG`, { timeoutMs: 12_000 }),
      );
      const seen = new Set<string>();
      for (const h of holidays) {
        const n = `${h.name} ${h.localName}`.toLowerCase();
        // El Ano Nuevo Chino son dos dias: se queda el primero.
        if (/chinese new year|lunar new year/.test(n) && !seen.has("cny")) {
          seen.add("cny");
          out.push({ date: h.date, name: "Ano Nuevo Chino", kind: "cny" });
        }
        if (/deepavali|diwali/.test(n) && !seen.has("diwali")) {
          seen.add("diwali");
          out.push({ date: h.date, name: "Diwali (Deepavali)", kind: "diwali" });
        }
      }
    } catch {
      /* un anio sin datos no invalida el resto */
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Ciudades ancla de cada fiesta lunar, para poder ubicarlas en el mapa. */
const LUNAR_ANCHORS: Record<"cny" | "diwali", Array<{ city: string; country: string; lat: number; lng: number; impact: number }>> = {
  cny: [
    { city: "Pekin", country: "China", lat: 39.9042, lng: 116.4074, impact: 0.95 },
    { city: "Singapur", country: "Singapur", lat: 1.3521, lng: 103.8198, impact: 0.9 },
    { city: "Hong Kong", country: "China", lat: 22.3193, lng: 114.1694, impact: 0.9 },
    { city: "San Francisco", country: "Estados Unidos", lat: 37.7749, lng: -122.4194, impact: 0.6 },
  ],
  diwali: [
    { city: "Delhi", country: "India", lat: 28.6139, lng: 77.209, impact: 0.9 },
    { city: "Bombay", country: "India", lat: 19.076, lng: 72.8777, impact: 0.85 },
    { city: "Singapur", country: "Singapur", lat: 1.3521, lng: 103.8198, impact: 0.7 },
  ],
};

// ── Cola larga del intelligence-hub ───────────────────────────────────────

async function listings(): Promise<CultureEvent[]> {
  if (!isConfigured()) return [];
  try {
    const data = await memo("intel:events", 30 * 60 * 1000, () => fetchIntelligence());
    return (data.events ?? [])
      .filter(
        (e: any) =>
          typeof e.lat === "number" &&
          typeof e.lng === "number" &&
          isCultural(e.segment),
      )
      .map((e: any, i: number) => {
        const raw = e.segment ? decodeEntities(String(e.segment)) : "";
        return {
          id: `listing-${i}`,
          name: String(e.name ?? "Evento"),
          category: normalizeSegment(e.segment),
          origin: "listing" as const,
          startDate: String(e.start ?? "").slice(0, 10),
          endDate: String(e.end ?? e.start ?? "").slice(0, 10),
          city: e.city ?? "",
          country: e.country ?? "",
          venue: e.venue ?? null,
          lat: e.lat as number,
          lng: e.lng as number,
          distanceKm: 0,
          leadDays: 0,
          impact: Math.min(0.55, typeof e.magnitude === "number" ? e.magnitude : 0.3),
          source: String(e.source ?? "Intelligence Hub"),
          ...(raw ? { rawSegment: raw } : {}),
          ...(e.url ? { url: String(e.url) } : {}),
        };
      })
      .filter((e: CultureEvent) => /^\d{4}-\d{2}-\d{2}$/.test(e.startDate));
  } catch {
    return [];
  }
}

// ── Servicio principal ────────────────────────────────────────────────────

/** Cuantos eventos de la cola larga se devuelven como maximo. */
const LISTINGS_CAP = 60;

/**
 * Un "evento" que dura mas que esto no es un evento: es una institucion.
 * Medido: 741 de los 8000 registros del hub son museos y centros culturales
 * que el scraper de ChileCultura ingesta con una ventana falsa de
 * 2019-01-01 a 2030-12-31 (uno se llama literalmente "(Cerrado)"). Pasan
 * cualquier filtro de fecha y, al ordenar por inicio, copan la lista entera
 * desplazando a los eventos reales.
 */
const MAX_LISTING_DAYS = 120;

const durationDays = (start: string, end: string): number =>
  Math.round(
    (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
      MS_DAY,
  ) + 1;

export async function getCulturePoint(
  lat: number,
  lng: number,
  radiusKm = 150,
  months = 24,
): Promise<CulturePointPayload> {
  const now = new Date();
  const from = iso(now);
  const to = iso(new Date(now.getTime() + months * 30 * MS_DAY));
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y);

  const [longTail, lunar] = await Promise.all([
    listings().catch(() => [] as CultureEvent[]),
    lunarFeasts(years).catch(() => []),
  ]);

  // ── Anclas curadas ──
  const anchorPool: CultureEvent[] = festivalsFor(years).map((f) => ({
    id: `anchor-${f.key}-${f.startDate}`,
    name: f.name,
    category: f.category,
    origin: "anchor" as const,
    startDate: f.startDate,
    endDate: f.endDate,
    city: f.city,
    country: f.country,
    venue: null,
    lat: f.lat,
    lng: f.lng,
    distanceKm: 0,
    leadDays: 0,
    impact: f.impact,
    source: "Tabla curada",
    ...(f.approximate ? { approximate: true } : {}),
    ...(f.note ? { note: f.note } : {}),
  }));

  // Fiestas lunares, replicadas en sus ciudades ancla.
  for (const l of lunar) {
    for (const a of LUNAR_ANCHORS[l.kind]) {
      anchorPool.push({
        id: `lunar-${l.kind}-${l.date}-${a.city}`,
        name: `${l.name} — ${a.city}`,
        category: "religious",
        origin: "anchor",
        startDate: l.date,
        // Ambas se celebran varios dias; la ventana util es mas larga que el feriado.
        endDate: iso(new Date(new Date(`${l.date}T00:00:00Z`).getTime() + 4 * MS_DAY)),
        city: a.city,
        country: a.country,
        venue: null,
        lat: a.lat,
        lng: a.lng,
        distanceKm: 0,
        leadDays: 0,
        impact: a.impact,
        source: "Nager.Date (feriado oficial)",
        note: "Fecha del calendario lunisolar; mueve viaje familiar en toda la region",
      });
    }
  }

  const today = new Date(`${from}T00:00:00Z`).getTime();
  const place = (e: CultureEvent): CultureEvent => ({
    ...e,
    distanceKm: Math.round(distanceKm(lat, lng, e.lat, e.lng)),
    leadDays: Math.round((new Date(`${e.startDate}T00:00:00Z`).getTime() - today) / MS_DAY),
  });
  const inScope = (e: CultureEvent) =>
    e.distanceKm <= radiusKm && e.endDate >= from && e.startDate <= to;

  const anchors = anchorPool.map(place).filter(inScope)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const scoped = longTail.map(place).filter(inScope);
  // Se separan las instituciones para poder declararlas, no descartarlas en silencio.
  const institutions = scoped.filter(
    (e) => durationDays(e.startDate, e.endDate) > MAX_LISTING_DAYS,
  ).length;
  const allListings = scoped.filter(
    (e) => durationDays(e.startDate, e.endDate) <= MAX_LISTING_DAYS,
  );
  // La cola larga puede ser de miles: se ordena por fecha y se recorta, pero se
  // informa el total para que el panel no mienta sobre lo que hay.
  const listingsTotal = allListings.length;
  // Lo que VIENE va primero, y despues lo que ya esta en curso. Ordenar solo
  // por fecha de inicio pone adelante muestras que arrancaron hace meses y
  // siguen abiertas: son contexto, no agenda, y con el tope de la lista
  // terminaban tapando todos los eventos futuros.
  const sortKey = (e: CultureEvent) =>
    e.startDate >= from ? `0${e.startDate}` : `1${e.endDate}`;
  const shown = allListings
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .slice(0, LISTINGS_CAP);

  const byCategory: Record<string, number> = {};
  for (const e of [...anchors, ...allListings]) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }

  const headline =
    anchors.length > 0
      ? anchors.reduce((best, e) => (e.impact > best.impact ? e : best))
      : (shown[0] ?? null);

  const gaps: string[] = [];
  if (!isConfigured()) {
    gaps.push("Sin cola larga: el intelligence-hub no esta configurado");
  } else if (listingsTotal === 0) {
    gaps.push("El intelligence-hub no tiene eventos culturales en este radio");
  }
  if (institutions > 0) {
    gaps.push(
      `${institutions} registro(s) del hub son instituciones permanentes (museos con ventana de anios), no eventos: se excluyen`,
    );
  }
  if (lunar.length === 0) {
    gaps.push("Nager no devolvio Ano Nuevo Chino ni Diwali para la ventana");
  }
  gaps.push(
    "Las anclas curadas cubren los festivales globales; las fiestas patronales locales solo aparecen si algun scraper del hub las publica",
  );

  const coverage: CultureCoverage = {
    anchors: anchors.length > 0,
    listings: listingsTotal > 0,
    lunarFeasts: lunar.length > 0,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    window: { from, to },
    anchors,
    listings: shown,
    byCategory,
    headline,
    listingsTotal,
    coverage,
    sources: [
      "Tabla curada (festivales ancla)",
      "Intelligence Hub (Ticketmaster, Eventbrite, scrapers)",
      "Nager.Date (fiestas lunares)",
    ],
    timestamp: new Date().toISOString(),
  };
}
