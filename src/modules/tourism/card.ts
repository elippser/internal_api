/**
 * La tarjeta del estado turístico. Pura, determinística y testeada: cada número
 * que ve el usuario sale de acá, no del modelo.
 *
 * Reglas:
 *  - Máximo 4 métricas, elegidas por prioridad según lo que se preguntó.
 *  - Una métrica sin dato se OMITE. Nunca vale 0 ni "—": un cero que parece
 *    real es peor que una celda menos.
 *  - Cada métrica lleva su confianza; un sobre vencido baja a "media".
 */

import {
  addDaysIso,
  dateRange,
  dayMonth,
  distanceText,
  impactLabel,
  isoDay,
  kmAway,
  monthSpans,
  signedPct,
  thousands,
  truncate,
} from "./format";
import {
  HUB_LABEL,
  hubsForFacets,
  type Confidence,
  type EmitterWindowSlim,
  type HubEnvelope,
  type TourismAlert,
  type TourismCardPayload,
  type TourismDossier,
  type TourismFacet,
  type TourismHub,
  type TourismMetric,
} from "./tourism.types";

export const MAX_METRICS = 4;

const SEVERITY: Record<Confidence, number> = { alta: 0, media: 1, estimado: 2 };

export const worseConfidence = (a: Confidence, b: Confidence): Confidence =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

export function envelopeStale(env: HubEnvelope, now: Date): boolean {
  return now.getTime() - Date.parse(env.computedAt) > env.ttlMs;
}

/** Varios eventos juntos: todos curados = estimado; alguno flojo o mezcla = media. */
export function aggregateConfidence(items: ReadonlyArray<{ confidence: Confidence }>): Confidence {
  if (items.length === 0) return "alta";
  if (items.every((i) => i.confidence === "estimado")) return "estimado";
  if (items.some((i) => i.confidence !== "alta")) return "media";
  return "alta";
}

export const PROFILE_LABEL: Record<string, string> = {
  tropical: "tropical",
  arid: "árido",
  temperate: "templado",
  polar: "frío",
};

// ── Métricas ─────────────────────────────────────────────────────────────────

export type MetricId =
  | "eventos_30d"
  | "eventos_90d"
  | "ancla"
  | "congresos_90d"
  | "deportes_90d"
  | "atencion"
  | "proximo_puente"
  | "emisores_feriado_60d"
  | "receso_escolar"
  | "mejor_clima"
  | "temporada_termica"
  | "caminabilidad"
  | "gastronomia_1km"
  | "transporte"
  | "ruido";

type Built = Omit<TourismMetric, "facet">;
type Draft = Omit<Built, "asOf">;
type Builder = (d: TourismDossier, now: Date) => Built | null;

function finish(env: HubEnvelope, draft: Draft, now: Date): Built {
  return {
    ...draft,
    asOf: env.computedAt,
    confidence: envelopeStale(env, now) ? worseConfidence(draft.confidence, "media") : draft.confidence,
  };
}

function eventsWindow(d: TourismDossier, now: Date, days: number) {
  const env = d.hubs.events;
  const e = env?.data;
  if (!env || !e) return null;
  const today = isoDay(now);
  const end = addDaysIso(today, days);
  return { env, e, today, starting: e.items.filter((i) => i.startDate >= today && i.startDate <= end) };
}

const BUILDERS: Record<MetricId, Builder> = {
  eventos_30d: (d, now) => {
    const w = eventsWindow(d, now, 30);
    if (!w) return null;
    // Cero con la agenda sin eventos en el radio no es "no hay": es "no está
    // relevado" (la cola larga depende de las ciudades que sigue el radar).
    if (w.e.next30d === 0 && !w.e.listingsInRadius) return null;
    const next = w.starting[0];
    return finish(w.env, {
      id: "eventos_30d",
      hub: "events",
      label: "Eventos en 30 días",
      value: `${w.e.next30d}${w.e.floor30 ? "+" : ""}`,
      trend: "neutral",
      hint: next
        ? `${truncate(next.name, 34)} · ${dateRange(next.startDate, next.endDate)} · ${kmAway(next.distanceKm)}`
        : "Ninguno empieza en los próximos 30 días",
      confidence: aggregateConfidence(w.starting),
    }, now);
  },

  eventos_90d: (d, now) => {
    const w = eventsWindow(d, now, 90);
    if (!w) return null;
    if (w.e.next90d === 0 && !w.e.listingsInRadius) return null;
    const k = w.e.byKind90d;
    const kinds = [
      k.cultura ? `${k.cultura} culturales` : null,
      k.deporte ? `${k.deporte} deportivos` : null,
      k.mice ? `${k.mice} corporativos` : null,
    ].filter(Boolean);
    return finish(w.env, {
      id: "eventos_90d",
      hub: "events",
      label: "Eventos en 90 días",
      value: `${w.e.next90d}${w.e.floor90 ? "+" : ""}`,
      trend: "neutral",
      hint: kinds.length ? kinds.join(" · ") : null,
      confidence: aggregateConfidence(w.starting),
    }, now);
  },

  ancla: (d, now) => {
    const w = eventsWindow(d, now, 365);
    if (!w) return null;
    const upcoming = w.e.anchors.filter((a) => a.startDate >= w.today && a.startDate <= addDaysIso(w.today, 365));
    if (upcoming.length === 0) return null;
    // De los tres más próximos, el de más impacto: el más cercano en fecha no
    // siempre es el que llena la plaza.
    const pick = upcoming.slice(0, 3).reduce((best, a) => (a.impact > best.impact ? a : best));
    return finish(w.env, {
      id: "ancla",
      hub: "events",
      label: "Gran evento próximo",
      value: `${truncate(pick.name, 22)} · ${dayMonth(pick.startDate)}`,
      trend: "neutral",
      hint: `${dateRange(pick.startDate, pick.endDate)} · ${kmAway(pick.distanceKm)} · impacto ${impactLabel(pick.impact)}`,
      confidence: pick.confidence,
    }, now);
  },

  congresos_90d: (d, now) => {
    const w = eventsWindow(d, now, 90);
    if (!w || w.e.byKind90d.mice === 0) return null;
    const list = w.starting.filter((i) => i.kind === "mice");
    const first = list[0];
    return finish(w.env, {
      id: "congresos_90d",
      hub: "events",
      label: "Congresos y ferias (90 d)",
      value: String(w.e.byKind90d.mice),
      trend: "neutral",
      hint:
        w.e.delegateNights90d > 0
          ? `≈ ${thousands(w.e.delegateNights90d)} noches-delegado`
          : first
            ? `${truncate(first.name, 30)} · ${dayMonth(first.startDate)}`
            : null,
      confidence: aggregateConfidence(list),
    }, now);
  },

  deportes_90d: (d, now) => {
    const w = eventsWindow(d, now, 90);
    if (!w || w.e.byKind90d.deporte === 0) return null;
    const list = w.starting.filter((i) => i.kind === "deporte");
    const top = list.length ? list.reduce((best, e) => (e.impact > best.impact ? e : best)) : null;
    return finish(w.env, {
      id: "deportes_90d",
      hub: "events",
      label: "Eventos deportivos (90 d)",
      value: String(w.e.byKind90d.deporte),
      trend: "neutral",
      hint: top ? `${truncate(top.name, 30)} · ${dayMonth(top.startDate)}` : null,
      confidence: aggregateConfidence(list),
    }, now);
  },

  atencion: (d, now) => {
    const env = d.hubs.attention;
    const a = env?.data;
    if (!env || !a) return null;
    const lang = a.topLanguages[0];
    const hint = `${thousands(a.weeklyViews)} vistas/semana en Wikipedia${
      lang ? ` · ${Math.round(lang.share * 100)}% en ${lang.label}` : ""
    }`;
    // Un artículo elegido por cercanía puede ser un monumento y no la ciudad.
    const confidence: Confidence = a.resolvedVia === "geosearch" ? "media" : "alta";
    if (a.trendPct === null) {
      return finish(env, {
        id: "atencion", hub: "attention", label: "Vistas por semana",
        value: thousands(a.weeklyViews), trend: "neutral", hint: `Wikipedia · "${truncate(a.article, 30)}"`, confidence,
      }, now);
    }
    return finish(env, {
      id: "atencion",
      hub: "attention",
      label: "Interés online",
      value: signedPct(a.trendPct),
      trend: a.trendPct >= 10 ? "up" : a.trendPct <= -10 ? "down" : "neutral",
      hint,
      confidence,
    }, now);
  },

  proximo_puente: (d, now) => {
    const env = d.hubs.calendar;
    const c = env?.data;
    if (!env || !c) return null;
    const today = isoDay(now);
    const horizon = addDaysIso(today, 120);
    const lw = c.longWeekends.find((l) => l.endDate >= today && l.startDate <= horizon);
    if (!lw) return null;
    return finish(env, {
      id: "proximo_puente",
      hub: "calendar",
      label: "Próximo fin de semana largo",
      value: dateRange(lw.startDate, lw.endDate),
      trend: "neutral",
      hint: [`${lw.dayCount} días`, lw.needBridgeDay ? "con puente" : null, lw.holidays[0] ?? null]
        .filter(Boolean)
        .join(" · "),
      confidence: "alta",
    }, now);
  },

  emisores_feriado_60d: (d, now) => {
    const env = d.hubs.calendar;
    const c = env?.data;
    if (!env || !c) return null;
    const first = new Map<string, EmitterWindowSlim>();
    for (const w of c.emitters60d) if (!first.has(w.countryCode)) first.set(w.countryCode, w);
    const list = [...first.values()];
    if (list.length === 0) return null;
    return finish(env, {
      id: "emisores_feriado_60d",
      hub: "calendar",
      label: "Mercados emisores de vacaciones (60 d)",
      value: `${list.length} ${list.length === 1 ? "mercado" : "mercados"}`,
      trend: "neutral",
      hint: list.slice(0, 3).map((w) => `${w.countryCode} ${dayMonth(w.startDate)}`).join(" · "),
      confidence: aggregateConfidence(list),
    }, now);
  },

  receso_escolar: (d, now) => {
    const env = d.hubs.calendar;
    const c = env?.data;
    if (!env || !c) return null;
    const today = isoDay(now);
    const sb = c.schoolBreaks.find((s) => s.endDate >= today);
    if (!sb) return null;
    return finish(env, {
      id: "receso_escolar",
      hub: "calendar",
      label: "Próximo receso escolar",
      value: dateRange(sb.startDate, sb.endDate),
      trend: "neutral",
      hint: [truncate(sb.name, 34), sb.blockLabel].filter(Boolean).join(" · ") || null,
      confidence: sb.confidence,
    }, now);
  },

  mejor_clima: (d, now) => {
    const env = d.hubs.climate;
    const c = env?.data;
    if (!env || !c || c.best.length === 0) return null;
    return finish(env, {
      id: "mejor_clima",
      hub: "climate",
      label: "Mejor clima",
      value: monthSpans(c.best),
      trend: "neutral",
      hint: `Clima ${PROFILE_LABEL[c.profile] ?? c.profile} · promedio de 10 años`,
      confidence: "alta",
    }, now);
  },

  temporada_termica: (d, now) => {
    const env = d.hubs.climate;
    const c = env?.data;
    if (!env || !c || c.warmest.length === 0) return null;
    return finish(env, {
      id: "temporada_termica",
      hub: "climate",
      label: "Meses más cálidos",
      value: monthSpans(c.warmest),
      trend: "neutral",
      hint: c.wet.length ? `Lluvias: ${monthSpans(c.wet)}` : "Sin temporada de lluvias marcada",
      confidence: "alta",
    }, now);
  },

  caminabilidad: (d, now) => {
    const env = d.hubs.place;
    const p = env?.data;
    if (!env || !p) return null;
    return finish(env, {
      id: "caminabilidad",
      hub: "place",
      label: "Caminabilidad",
      value: `${p.walkability.score}/100`,
      trend: "neutral",
      hint: p.walkability.label,
      confidence: "alta",
    }, now);
  },

  gastronomia_1km: (d, now) => {
    const env = d.hubs.place;
    const p = env?.data;
    if (!env || !p) return null;
    return finish(env, {
      id: "gastronomia_1km",
      hub: "place",
      label: `Gastronomía a ${p.radiusKm} km`,
      value: `${p.gastronomy}${p.truncated ? "+" : ""}`,
      trend: "neutral",
      hint: `${p.nightlife} de vida nocturna · ${p.shops} comercios`,
      confidence: "alta",
    }, now);
  },

  transporte: (d, now) => {
    const env = d.hubs.place;
    const p = env?.data;
    if (!env || !p) return null;
    const stop = p.nearby.find((n) => n.kind === "transitStop");
    const terminal = p.nearby.find((n) => n.kind === "busTerminal");
    const airport = p.nearby.find((n) => n.kind === "airport");
    const node = stop ?? terminal;
    return finish(env, {
      id: "transporte",
      hub: "place",
      label: "Transporte público",
      value: node ? distanceText(node.distanceM) : `Sin paradas a ${p.radiusKm} km`,
      trend: "neutral",
      hint: node
        ? truncate(node.name ?? node.label, 34)
        : airport
          ? `Aeropuerto ${airport.iata ?? ""} a ${distanceText(airport.distanceM)}`.replace("  ", " ")
          : null,
      confidence: "alta",
    }, now);
  },

  ruido: (d, now) => {
    const env = d.hubs.place;
    const p = env?.data;
    if (!env || !p) return null;
    return finish(env, {
      id: "ruido",
      hub: "place",
      label: "Ruido estimado",
      value: p.noise.label,
      trend: "neutral",
      hint: p.noise.sources.length
        ? truncate(p.noise.sources.join(" · "), 44)
        : "Sin autopista, aeropuerto ni vida nocturna cerca",
      confidence: "alta",
    }, now);
  },
};

export const FACET_METRICS: Record<TourismFacet, MetricId[]> = {
  movimiento: ["eventos_30d", "atencion", "proximo_puente", "emisores_feriado_60d", "eventos_90d"],
  eventos: ["eventos_30d", "ancla", "congresos_90d", "deportes_90d", "eventos_90d"],
  entorno: ["caminabilidad", "gastronomia_1km", "transporte", "ruido"],
  estacionalidad: ["proximo_puente", "receso_escolar", "mejor_clima", "temporada_termica", "emisores_feriado_60d"],
};

/** Todas las métricas disponibles de una faceta, sin tope (para el panel). */
export function facetMetrics(d: TourismDossier, facet: TourismFacet, now = new Date()): TourismMetric[] {
  const out: TourismMetric[] = [];
  for (const id of FACET_METRICS[facet]) {
    const m = BUILDERS[id](d, now);
    if (m) out.push({ ...m, facet });
  }
  return out;
}

export function selectMetrics(d: TourismDossier, facets: readonly TourismFacet[], now: Date): TourismMetric[] {
  const cache = new Map<MetricId, Built | null>();
  const build = (id: MetricId): Built | null => {
    if (!cache.has(id)) cache.set(id, BUILDERS[id](d, now));
    return cache.get(id) ?? null;
  };
  const perFacet = Math.max(1, Math.floor(MAX_METRICS / Math.max(1, facets.length)));
  const chosen: TourismMetric[] = [];
  const used = new Set<MetricId>();

  // Primer pase: cuota por faceta, para que una pregunta doble no quede tapada
  // por la primera faceta. Segundo pase: completar huecos en orden.
  for (const pass of [perFacet, MAX_METRICS]) {
    for (const facet of facets) {
      let taken = chosen.filter((m) => m.facet === facet).length;
      for (const id of FACET_METRICS[facet]) {
        if (chosen.length >= MAX_METRICS || taken >= pass) break;
        if (used.has(id)) continue;
        const m = build(id);
        if (!m) continue;
        chosen.push({ ...m, facet });
        used.add(id);
        taken++;
      }
    }
  }
  return chosen;
}

// ── Alerta, faltantes, fuentes ───────────────────────────────────────────────

const LEVEL_TEXT = { Orange: "naranja", Red: "roja" } as const;

export function buildAlert(d: TourismDossier): TourismAlert | null {
  const env = d.hubs.hazards;
  const h = env?.data;
  if (!env || !h) return null;
  const serious = h.active.filter((a) => a.alertLevel !== "Green" && a.ongoing);
  const top = serious.find((a) => a.alertLevel === "Red") ?? serious[0];
  if (top) {
    const level = top.alertLevel as "Orange" | "Red";
    const where = top.scope === "country" ? "en el país" : `a ${top.distanceKm} km`;
    return { level, text: `${top.typeName} con alerta ${LEVEL_TEXT[level]} ${where}`, asOf: env.computedAt };
  }
  const air = h.airliftRisk.find((r) => r.alertLevel !== "Green");
  if (air) {
    const level = air.alertLevel as "Orange" | "Red";
    return {
      level,
      text: `${air.hazard} con alerta ${LEVEL_TEXT[level]} cerca del aeropuerto ${air.airportIata ?? air.airport}`,
      asOf: env.computedAt,
    };
  }
  return null;
}

/** Lo que no se pudo cubrir para estas facetas, en lenguaje llano. */
export function dossierMissing(d: TourismDossier, facets: readonly TourismFacet[]): string[] {
  const out = new Set<string>();
  for (const hub of hubsForFacets(facets)) {
    if (d.meta.pending.includes(hub)) {
      out.add(`${HUB_LABEL[hub]} (todavía se está leyendo)`);
      continue;
    }
    const skip = d.meta.skipped.find((s) => s.hub === hub);
    if (skip) {
      out.add(`${HUB_LABEL[hub]}: ${skip.reason}`);
      continue;
    }
    const env = d.hubs[hub] as HubEnvelope | undefined;
    if (!env || env.data === null) {
      out.add(env?.missing[0] ?? HUB_LABEL[hub]);
      continue;
    }
    // Los huecos finos de las alertas (sismos, volcanes) no son lo que se
    // preguntó: sólo cuenta si no hay alertas en absoluto.
    if (hub === "hazards") continue;
    for (const m of env.missing) out.add(m);
  }
  return [...out];
}

export const SOURCE_LABELS: Record<TourismHub, string> = {
  events: "Agenda de eventos (Ticketmaster, Eventbrite, agendas oficiales) y tablas curadas",
  attention: "Wikipedia",
  calendar: "Nager.Date y OpenHolidays",
  climate: "Open-Meteo (ERA5)",
  place: "OpenStreetMap",
  hazards: "GDACS",
};

function titleFor(facet: TourismFacet, d: TourismDossier): string {
  const where = d.property.city || d.property.name;
  switch (facet) {
    case "movimiento":
      return `Movimiento turístico — ${where}`;
    case "eventos":
      return "Eventos cerca de tu propiedad";
    case "entorno":
      return "Entorno de tu propiedad";
    case "estacionalidad":
      return `Temporada y calendario — ${where}`;
  }
}

export function buildCard(
  d: TourismDossier,
  facetsIn: readonly TourismFacet[],
  now = new Date(),
): TourismCardPayload {
  const facets = (facetsIn.length ? [...new Set(facetsIn)] : ["movimiento"]) as TourismFacet[];
  const metrics = selectMetrics(d, facets, now);
  const alert = buildAlert(d);

  const hubs = new Set<TourismHub>(metrics.map((m) => m.hub));
  if (alert) hubs.add("hazards");

  const confidence = metrics.length
    ? metrics.reduce<Confidence>((acc, m) => worseConfidence(acc, m.confidence), "alta")
    : "media";
  const updatedAt = metrics.length
    ? metrics.reduce((oldest, m) => (m.asOf < oldest ? m.asOf : oldest), metrics[0].asOf)
    : d.updatedAt;

  return {
    kind: "tourism_status",
    version: 1,
    propertyId: d.propertyId,
    title: titleFor(facets[0], d),
    facets,
    metrics,
    alert,
    confidence,
    sources: [...hubs].map((h) => SOURCE_LABELS[h]),
    updatedAt,
    location: { lat: d.location.lat, lng: d.location.lng, source: d.location.source },
    missing: dossierMissing(d, facets),
    detail: { propertyId: d.propertyId, facets },
    layout: "block",
  };
}
