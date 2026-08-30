// Hub de eventos de negocios / MICE (event-list.md §5).
//
// Quinto de la serie. Estructura heredada del §4 (anclas curadas + cola larga
// del intelligence-hub, filtradas por radio), pero con dos campos propios que
// son los que hacen util a esta categoria y no aparecen en las otras:
//
//   · dayPattern — la demanda MICE es de MITAD DE SEMANA. Una feria llena
//     martes a jueves; un festival llena viernes a domingo. Para tarifar, esa
//     diferencia importa mas que la fecha.
//   · attendees — es la metrica con la que la industria dimensiona el impacto
//     hotelero de un congreso. De ahi sale `delegateNights`, que responde
//     "cuanta demanda corporativa entra a esta plaza en la ventana".
//
// La cola larga se lee del intelligence-hub, que ya scrapea los recintos de
// convenciones (IFEMA, La Rural, BA Ferial, Anhembi) y levanta Eventbrite y
// Meetup. Lo que no tiene es el calendario ancla del sector: MWC, CES, ITB,
// FITUR, Davos, el G20 — que es justo lo que agota una plaza entera.

import { fetchIntelligence, isConfigured } from "../global/lib/intelligence";
import { congressesFor, PENDING_MICE } from "./congresses";
import type { DayPattern, MiceCoverage, MiceEvent, MicePointPayload } from "./mice.types";

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

const deaccent = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

/**
 * Que segmentos del hub son corporativos. Es al reves que en el §4: alla se
 * excluia lo no cultural, aca se INCLUYE solo lo de negocios, porque la
 * enorme mayoria de los 8000 eventos del hub son culturales y colarian todos.
 */
const MICE_RULES: Array<[RegExp, "trade-fair" | "congress" | "summit" | "forum" | "tech"]> = [
  [/congres|congreso|simposi|symposi|jornadas medicas/, "congress"],
  [/cumbre|summit|g20|g7/, "summit"],
  [/foro|forum(?!ula)/, "forum"],
  [/hackathon|devfest|meetup|startup|tech talk|workshop tecnic|esports|e-sports/, "tech"],
  [/feria|fair|expo(?!sicion)|trade show|salon profesional|conference|conferencia|convencion|convention|seminario|capacitacion/, "trade-fair"],
];

function classifyMice(raw: string | null | undefined, name: string): MiceEvent["category"] | null {
  const hay = deaccent(decodeEntities(`${raw ?? ""} ${name}`)).toLowerCase();
  for (const [re, cat] of MICE_RULES) if (re.test(hay)) return cat;
  return null;
}

/**
 * Patron semanal a partir de los dias que abarca. Se infiere del calendario y
 * no de la fuente, que nunca lo publica: si cae entre lunes y viernes es
 * corporativo puro; si toca sabado y domingo, mixto.
 */
function inferPattern(startDate: string, endDate: string): DayPattern {
  const s = new Date(`${startDate}T00:00:00Z`);
  const e = new Date(`${endDate}T00:00:00Z`);
  let weekend = 0;
  let total = 0;
  for (let t = s.getTime(); t <= e.getTime() && total < 30; t += MS_DAY) {
    const d = new Date(t).getUTCDay();
    if (d === 0 || d === 6) weekend++;
    total++;
  }
  if (total === 0) return "midweek";
  if (weekend === 0) return "midweek";
  if (weekend >= total - 1) return "weekend";
  return "full-week";
}

// ── Cola larga corporativa del intelligence-hub ───────────────────────────

/** Un "evento" de mas de esto no es un evento: es una institucion (ver §4). */
const MAX_LISTING_DAYS = 120;

const durationDays = (start: string, end: string): number =>
  Math.round(
    (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / MS_DAY,
  ) + 1;

async function listings(): Promise<MiceEvent[]> {
  if (!isConfigured()) return [];
  try {
    const data = await memo("intel:events", 30 * 60 * 1000, () => fetchIntelligence());
    const out: MiceEvent[] = [];
    (data.events ?? []).forEach((e: any, i: number) => {
      if (typeof e.lat !== "number" || typeof e.lng !== "number") return;
      const name = String(e.name ?? "");
      const cat = classifyMice(e.segment, name);
      if (!cat) return; // no es corporativo: lo cubre el hub de cultura
      const startDate = String(e.start ?? "").slice(0, 10);
      const endDate = String(e.end ?? e.start ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return;
      if (durationDays(startDate, endDate) > MAX_LISTING_DAYS) return;
      const raw = e.segment ? decodeEntities(String(e.segment)) : "";
      out.push({
        id: `mice-listing-${i}`,
        name: name || "Evento corporativo",
        category: cat,
        sector: raw || "Sin clasificar",
        origin: "listing",
        startDate,
        endDate,
        city: e.city ?? "",
        country: e.country ?? "",
        venue: e.venue ?? null,
        lat: e.lat,
        lng: e.lng,
        distanceKm: 0,
        leadDays: 0,
        // La cola larga no publica asistentes: se declara en null, no se inventa.
        attendees: null,
        nightsHint: 2,
        dayPattern: inferPattern(startDate, endDate),
        source: String(e.source ?? "Intelligence Hub"),
        ...(raw ? { rawSegment: raw } : {}),
        ...(e.url ? { url: String(e.url) } : {}),
      });
    });
    return out;
  } catch {
    return [];
  }
}

// ── Servicio principal ────────────────────────────────────────────────────

const LISTINGS_CAP = 50;

export async function getMicePoint(
  lat: number,
  lng: number,
  radiusKm = 150,
  months = 36,
): Promise<MicePointPayload> {
  const now = new Date();
  const from = iso(now);
  const to = iso(new Date(now.getTime() + months * 30 * MS_DAY));
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y);

  const longTail = await listings().catch(() => [] as MiceEvent[]);

  const anchorPool: MiceEvent[] = congressesFor(years).map((c) => ({
    id: `mice-anchor-${c.key}-${c.startDate}`,
    name: c.name,
    category: c.category,
    sector: c.sector,
    origin: "anchor" as const,
    startDate: c.startDate,
    endDate: c.endDate,
    city: c.city,
    country: c.country,
    venue: c.venue ?? null,
    lat: c.lat,
    lng: c.lng,
    distanceKm: 0,
    leadDays: 0,
    attendees: c.attendees,
    nightsHint: c.nightsHint,
    dayPattern: c.dayPattern,
    source: "Tabla curada",
    ...(c.approximate ? { approximate: true } : {}),
    ...(c.note ? { note: c.note } : {}),
  }));

  const today = new Date(`${from}T00:00:00Z`).getTime();
  const place = (e: MiceEvent): MiceEvent => ({
    ...e,
    distanceKm: Math.round(distanceKm(lat, lng, e.lat, e.lng)),
    leadDays: Math.round((new Date(`${e.startDate}T00:00:00Z`).getTime() - today) / MS_DAY),
  });
  const inScope = (e: MiceEvent) =>
    e.distanceKm <= radiusKm && e.endDate >= from && e.startDate <= to;

  const anchors = anchorPool.map(place).filter(inScope)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const allListings = longTail.map(place).filter(inScope);
  const listingsTotal = allListings.length;
  // Lo que viene primero y lo en curso despues (mismo criterio que el §4).
  const sortKey = (e: MiceEvent) => (e.startDate >= from ? `0${e.startDate}` : `1${e.endDate}`);
  const shown = allListings
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .slice(0, LISTINGS_CAP);

  const byCategory: Record<string, number> = {};
  for (const e of [...anchors, ...allListings]) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }

  // Noches-delegado: solo de las anclas, que son las unicas con asistentes
  // publicados. Sumar la cola larga con un numero inventado seria peor que
  // no sumarla.
  const delegateNights = anchors.reduce(
    (sum, e) => sum + (e.attendees ?? 0) * e.nightsHint,
    0,
  );

  const headline =
    anchors.length > 0
      ? anchors.reduce((best, e) =>
          (e.attendees ?? 0) * e.nightsHint > (best.attendees ?? 0) * best.nightsHint ? e : best,
        )
      : (shown[0] ?? null);

  const gaps: string[] = [...PENDING_MICE];
  if (!isConfigured()) gaps.push("Sin agenda local: el intelligence-hub no esta configurado");
  else if (listingsTotal === 0) gaps.push("El intelligence-hub no tiene eventos corporativos en este radio");

  const coverage: MiceCoverage = {
    anchors: anchors.length > 0,
    listings: listingsTotal > 0,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    window: { from, to },
    anchors,
    listings: shown,
    listingsTotal,
    byCategory,
    headline,
    delegateNights,
    coverage,
    sources: [
      "Tabla curada (ferias, foros y cumbres ancla)",
      "Intelligence Hub (recintos de convenciones, Eventbrite, Meetup)",
    ],
    timestamp: new Date().toISOString(),
  };
}

export { classifyMice, inferPattern };
