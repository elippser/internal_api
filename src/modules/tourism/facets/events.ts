/**
 * Eventos: cultura + deportes + MICE fusionados en una sola agenda.
 *
 * Los tres hubs se solapan (una feria cae como "desfile" en Cultura y como
 * feria en MICE) y ninguno deduplica contra los otros, así que acá se
 * deduplica por nombre + fecha de inicio. Ante un duplicado gana el ancla
 * (trae asistentes e impacto curados) y, entre iguales, el hub más específico
 * (deportes, después MICE, después cultura).
 */

import type { CultureEvent, CulturePointPayload } from "../../culture/culture.types";
import type { SportsEvent, SportsPointPayload } from "../../sports/sports.types";
import type { MiceEvent, MicePointPayload } from "../../mice/mice.types";
import {
  SCRAPER_CONFIDENCE_DEFAULT,
  SOURCE_CONFIDENCE,
} from "../../intelligence/core/signal.types";
import { addDaysIso, deaccent, isoDay } from "../format";
import type { Confidence, EventItem, EventsSlim, Projection } from "../tourism.types";

export const EVENT_ITEMS_CAP = 40;
export const EVENT_ANCHORS_CAP = 8;

/**
 * Confianza de un evento de agenda en vivo, desde la confianza base de su
 * fuente en el radar. Nunca `estimado`: es un evento real publicado; lo que
 * varía es cuánto confiar en su fecha/sede. Los scrapers (0,4) quedan en media.
 */
export function listingConfidence(source: string): Confidence {
  const s = source.toLowerCase();
  let c = SOURCE_CONFIDENCE[s];
  if (c === undefined) {
    const known = Object.keys(SOURCE_CONFIDENCE).find((k) => s.includes(k));
    c = known ? SOURCE_CONFIDENCE[known] : SCRAPER_CONFIDENCE_DEFAULT;
  }
  return c >= 0.6 ? "alta" : "media";
}

/**
 * Peso de un congreso para ordenar, desde sus noches-delegado. Los hubs de
 * cultura y deportes ya traen `impact`; MICE no, porque su medida es otra.
 * 10.000 noches-delegado ≈ 0,67; un millón ≈ tope.
 */
export function miceImpact(attendees: number | null, nightsHint: number): number {
  if (!attendees || attendees <= 0) return 0.35;
  const dn = attendees * Math.max(1, nightsHint);
  return Math.max(0.35, Math.min(0.95, Math.log10(dn) / 6));
}

const nameKey = (name: string): string =>
  deaccent(name).toLowerCase().replace(/[^a-z0-9]+/g, "");

function fromCulture(e: CultureEvent): EventItem {
  return {
    id: `cultura:${e.id}`,
    name: e.name,
    kind: "cultura",
    category: e.category,
    origin: e.origin,
    startDate: e.startDate,
    endDate: e.endDate,
    distanceKm: e.distanceKm,
    impact: e.impact,
    confidence:
      e.origin === "anchor" || e.approximate ? "estimado" : listingConfidence(e.source),
    source: e.source,
    city: e.city,
    venue: e.venue,
    attendees: null,
    nightsHint: null,
    dayPattern: null,
    url: e.url ?? null,
  };
}

function fromSports(e: SportsEvent): EventItem {
  const league = e.category === "league";
  return {
    id: `deporte:${e.id}`,
    name: e.name,
    kind: "deporte",
    category: e.category,
    // Un GP de F1 no es curado pero se conoce con meses y llena la plaza: es
    // un ancla. Un partido de liga es agenda.
    origin: league ? "listing" : "anchor",
    startDate: e.startDate,
    endDate: e.endDate,
    distanceKm: e.distanceKm,
    impact: e.impact,
    confidence: e.curated ? "estimado" : league ? listingConfidence(e.source) : "alta",
    source: e.source,
    city: e.city,
    venue: e.venue,
    attendees: null,
    nightsHint: e.nightsHint,
    dayPattern: null,
    url: e.url ?? null,
  };
}

function fromMice(e: MiceEvent): EventItem {
  return {
    id: `mice:${e.id}`,
    name: e.name,
    kind: "mice",
    category: e.category,
    origin: e.origin,
    startDate: e.startDate,
    endDate: e.endDate,
    distanceKm: e.distanceKm,
    impact: e.origin === "anchor" ? miceImpact(e.attendees, e.nightsHint) : 0.35,
    confidence:
      e.origin === "anchor" || e.approximate ? "estimado" : listingConfidence(e.source),
    source: e.source,
    city: e.city,
    venue: e.venue,
    attendees: e.attendees,
    nightsHint: e.nightsHint,
    dayPattern: e.dayPattern,
    url: e.url ?? null,
  };
}

interface Listed {
  listings: Array<{ startDate: string }>;
  listingsTotal: number;
}

export interface EventsInput {
  culture: CulturePointPayload | null;
  sports: SportsPointPayload | null;
  mice: MicePointPayload | null;
  radiusKm: number;
  now: Date;
}

export function projectEvents(input: EventsInput): Projection<EventsSlim> {
  const missing: string[] = [];
  if (!input.culture) missing.push("eventos culturales");
  if (!input.sports) missing.push("eventos deportivos");
  if (!input.mice) missing.push("congresos y ferias");
  if (!input.culture && !input.sports && !input.mice) return { data: null, missing };

  const today = isoDay(input.now);
  const d30 = addDaysIso(today, 30);
  const d90 = addDaysIso(today, 90);

  // Orden de prioridad ante duplicados: el primero en entrar gana (salvo ancla).
  const pool: EventItem[] = [
    ...(input.sports?.events ?? []).map(fromSports),
    ...(input.mice ? [...input.mice.anchors, ...input.mice.listings].map(fromMice) : []),
    ...(input.culture ? [...input.culture.anchors, ...input.culture.listings].map(fromCulture) : []),
  ];

  const byKey = new Map<string, EventItem>();
  for (const item of pool) {
    const key = `${nameKey(item.name)}|${item.startDate}`;
    const prev = byKey.get(key);
    if (!prev || (prev.origin === "listing" && item.origin === "anchor")) byKey.set(key, item);
  }

  const sortKey = (e: EventItem) => (e.startDate >= today ? `0${e.startDate}` : `1${e.endDate}`);
  const all = [...byKey.values()]
    .filter((e) => e.endDate >= today)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const startsBy = (e: EventItem, end: string) => e.startDate >= today && e.startDate <= end;
  const in30 = all.filter((e) => startsBy(e, d30));
  const in90 = all.filter((e) => startsBy(e, d90));

  // Cultura y MICE recortan su lista (60 y 50), ordenada con lo que viene
  // primero. Si recortaron y el último que mostraron empieza antes del fin de
  // la ventana, pudo quedar afuera algo de esa ventana: el conteo es un piso.
  const truncatedBefore = (p: Listed | null, end: string): boolean => {
    if (!p || p.listingsTotal <= p.listings.length) return false;
    const upcoming = p.listings.filter((l) => l.startDate >= today);
    if (upcoming.length === 0) return true;
    const lastStart = upcoming.reduce((m, l) => (l.startDate > m ? l.startDate : m), upcoming[0].startDate);
    return lastStart <= end;
  };

  const byKind90d: EventsSlim["byKind90d"] = { cultura: 0, deporte: 0, mice: 0 };
  for (const e of in90) byKind90d[e.kind]++;

  const delegateNights90d = in90
    .filter((e) => e.kind === "mice" && e.origin === "anchor" && e.attendees)
    .reduce((sum, e) => sum + (e.attendees ?? 0) * (e.nightsHint ?? 1), 0);

  const upcoming = all.filter((e) => e.startDate >= today);
  const anchors = upcoming
    .filter((e) => e.origin === "anchor")
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, EVENT_ANCHORS_CAP);
  const headline = upcoming.length
    ? upcoming.reduce((best, e) => (e.impact > best.impact ? e : best))
    : null;

  const gaps = [
    ...(input.culture?.coverage.gaps ?? []),
    ...(input.mice?.coverage.gaps ?? []),
  ];
  const feedAvailable = !gaps.some((g) => /no esta configurado/i.test(g));
  if (!feedAvailable) missing.push("agenda de eventos con ticket (cola larga del radar)");

  return {
    data: {
      radiusKm: input.radiusKm,
      items: all.slice(0, EVENT_ITEMS_CAP),
      anchors,
      headline,
      next30d: in30.length,
      next90d: in90.length,
      floor30: truncatedBefore(input.culture, d30) || truncatedBefore(input.mice, d30),
      floor90: truncatedBefore(input.culture, d90) || truncatedBefore(input.mice, d90),
      byKind90d,
      delegateNights90d,
      feedAvailable,
      listingsInRadius: all.some((e) => e.origin === "listing"),
    },
    missing,
  };
}
