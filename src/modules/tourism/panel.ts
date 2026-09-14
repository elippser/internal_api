/**
 * El panel "Mi estatus turístico": el dossier completo, ordenado por sección y
 * listo para dibujar. Se arma en código para que el front sólo pinte: cada
 * valor ya viene formateado, con su fuente y su confianza.
 *
 * Es SÓLO lectura. Nada de lo que devuelve dispara una acción.
 */

import {
  SOURCE_LABELS,
  buildAlert,
  dossierMissing,
  facetMetrics,
  worseConfidence,
} from "./card";
import {
  MONTH_LONG,
  dateRange,
  dayMonth,
  distanceText,
  isoDay,
  kmAway,
} from "./format";
import type {
  Confidence,
  EventItem,
  HubEnvelope,
  PropertyHeader,
  TourismAlert,
  TourismDossier,
  TourismFacet,
  TourismHub,
  TourismMetric,
} from "./tourism.types";

export interface PanelItem {
  title: string;
  detail: string;
  confidence: Confidence;
  source: string | null;
  url: string | null;
}

export interface PanelSection {
  facet: TourismFacet;
  title: string;
  metrics: TourismMetric[];
  narrative: string | null;
  items: PanelItem[];
  /** Serie diaria para el gráfico (sólo interés online). */
  series: Array<{ date: string; views: number }> | null;
  sources: string[];
  confidence: Confidence | null;
  asOf: string | null;
  missing: string[];
}

export interface TourismPanelPayload {
  propertyId: string;
  property: PropertyHeader;
  location: { lat: number; lng: number; source: string };
  updatedAt: string;
  alert: TourismAlert | null;
  sections: PanelSection[];
  pending: TourismHub[];
  narrativesReady: boolean;
}

const SECTION_ORDER: TourismFacet[] = ["eventos", "movimiento", "entorno", "estacionalidad"];

const SECTION_TITLE: Record<TourismFacet, string> = {
  eventos: "Eventos cerca",
  movimiento: "Interés y mercados",
  entorno: "Entorno a pie",
  estacionalidad: "Temporada y calendario",
};

const SECTION_HUBS: Record<TourismFacet, TourismHub[]> = {
  eventos: ["events"],
  movimiento: ["attention", "calendar"],
  entorno: ["place"],
  estacionalidad: ["calendar", "climate"],
};

const KIND_LABEL: Record<EventItem["kind"], string> = {
  cultura: "cultura",
  deporte: "deporte",
  mice: "congreso o feria",
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const SOURCE_NAMES: Record<string, string> = {
  ticketmaster: "Ticketmaster",
  eventbrite: "Eventbrite",
  bandsintown: "Bandsintown",
  meetup: "Meetup",
  thesportsdb: "TheSportsDB",
  jolpica: "Fórmula 1 (Jolpica)",
};

/** "ih-scraper-meetup" → "Meetup": el id interno del conector no le dice nada al hotelero. */
export function sourceLabel(source: string): string {
  const key = source.toLowerCase().replace(/^ih-/, "").replace(/^scraper[-:]/, "");
  for (const [k, v] of Object.entries(SOURCE_NAMES)) if (key.includes(k)) return v;
  return key.replace(/[-_:]+/g, " ").trim() || source;
}

function eventItems(d: TourismDossier, today: string): PanelItem[] {
  const e = d.hubs.events?.data;
  if (!e) return [];
  return e.items
    .filter((i) => i.endDate >= today)
    .slice(0, 20)
    .map((i) => ({
      title: i.name,
      detail: [
        dateRange(i.startDate, i.endDate),
        kmAway(i.distanceKm),
        KIND_LABEL[i.kind],
        i.kind === "mice" && i.dayPattern === "midweek" ? "entre semana" : null,
        i.attendees ? `~${i.attendees.toLocaleString("es-AR")} asistentes` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      confidence: i.confidence,
      source: i.origin === "anchor" && i.confidence === "estimado" ? "Tabla curada" : sourceLabel(i.source),
      url: i.url,
    }));
}

function movementItems(d: TourismDossier): PanelItem[] {
  const items: PanelItem[] = [];
  const a = d.hubs.attention?.data;
  if (a) {
    for (const l of a.topLanguages) {
      items.push({
        title: `Lectores en ${l.label}`,
        detail: `${Math.round(l.share * 100)}% de las vistas del destino`,
        confidence: "alta",
        source: "Wikipedia",
        url: null,
      });
    }
  }
  const c = d.hubs.calendar?.data;
  if (c) {
    for (const w of c.emitters60d) {
      items.push({
        title: w.countryName || w.countryCode,
        detail: `${w.kind === "receso_escolar" ? "Vacaciones escolares" : "Fin de semana largo"} · ${dateRange(w.startDate, w.endDate)}`,
        confidence: w.confidence,
        source: w.kind === "receso_escolar" ? "OpenHolidays / tabla curada" : "Nager.Date",
        url: null,
      });
    }
  }
  return items;
}

function placeItems(d: TourismDossier): PanelItem[] {
  const p = d.hubs.place?.data;
  if (!p) return [];
  const pct = (x: number) => `${Math.round(x * 100)}/100`;
  const items: PanelItem[] = [
    { title: "Comercios y servicios a pie", detail: `${pct(p.walkability.components.amenities)} · cuántos lugares útiles hay caminando`, confidence: "alta", source: "OpenStreetMap", url: null },
    { title: "Veredas y cruces", detail: `${pct(p.walkability.components.pedestrian)} · qué tan pensado está el barrio para caminar`, confidence: "alta", source: "OpenStreetMap", url: null },
    { title: "Transporte público cerca", detail: `${pct(p.walkability.components.transit)} · paradas a mano para moverse sin auto`, confidence: "alta", source: "OpenStreetMap", url: null },
  ];
  if (p.noise.sources.length) {
    items.push({ title: "De dónde viene el ruido", detail: p.noise.sources.join(" · "), confidence: "alta", source: "OpenStreetMap", url: null });
  }
  for (const n of p.nearby) {
    items.push({
      title: `${capitalize(n.label)}${n.name ? `: ${n.name}` : ""}${n.iata ? ` (${n.iata})` : ""}`,
      detail: `a ${distanceText(n.distanceM)}`,
      confidence: "alta",
      source: n.kind === "airport" ? "OurAirports" : "OpenStreetMap",
      url: null,
    });
  }
  return items;
}

function seasonItems(d: TourismDossier, now: Date): PanelItem[] {
  const items: PanelItem[] = [];
  const today = isoDay(now);
  const c = d.hubs.calendar?.data;
  if (c) {
    for (const l of c.longWeekends.filter((x) => x.endDate >= today).slice(0, 4)) {
      items.push({
        title: "Fin de semana largo",
        detail: [dateRange(l.startDate, l.endDate), `${l.dayCount} días`, l.needBridgeDay ? "con puente" : null, l.holidays[0] ?? null]
          .filter(Boolean)
          .join(" · "),
        confidence: "alta",
        source: "Nager.Date",
        url: null,
      });
    }
    for (const b of c.schoolBreaks.slice(0, 3)) {
      items.push({
        title: b.name,
        detail: [dateRange(b.startDate, b.endDate), b.blockLabel].filter(Boolean).join(" · "),
        confidence: b.confidence,
        source: b.confidence === "alta" ? "OpenHolidays" : "Tabla curada",
        url: null,
      });
    }
    for (const o of c.observances90d.slice(0, 3)) {
      items.push({ title: o.name, detail: dayMonth(o.date), confidence: "estimado", source: "Tabla curada", url: null });
    }
  }
  const cl = d.hubs.climate?.data;
  if (cl) {
    const month = now.getUTCMonth() + 1;
    for (let k = 0; k < 3; k++) {
      const m = ((month - 1 + k) % 12) + 1;
      const n = cl.normals.find((x) => x.month === m);
      if (!n || n.tMax === null || n.tMin === null) continue;
      items.push({
        title: `Clima en ${MONTH_LONG[m - 1]}`,
        detail: `máx ${n.tMax}°C · mín ${n.tMin}°C${n.rainDays !== null ? ` · ${n.rainDays} días de lluvia` : ""}`,
        confidence: "alta",
        source: "Open-Meteo (promedio de 10 años)",
        url: null,
      });
    }
  }
  return items;
}

export function buildPanel(
  d: TourismDossier,
  narratives: Partial<Record<TourismFacet, string>> | null,
  now = new Date(),
): TourismPanelPayload {
  const today = isoDay(now);

  const sections = SECTION_ORDER.map((facet): PanelSection => {
    const metrics = facetMetrics(d, facet, now);
    const envs = SECTION_HUBS[facet]
      .map((h) => ({ hub: h, env: d.hubs[h] as HubEnvelope | undefined }))
      .filter((x): x is { hub: TourismHub; env: HubEnvelope } => !!x.env && x.env.data !== null);
    const items =
      facet === "eventos"
        ? eventItems(d, today)
        : facet === "movimiento"
          ? movementItems(d)
          : facet === "entorno"
            ? placeItems(d)
            : seasonItems(d, now);
    return {
      facet,
      title: SECTION_TITLE[facet],
      metrics,
      narrative: narratives?.[facet] ?? null,
      items,
      series: facet === "movimiento" ? (d.hubs.attention?.data?.series ?? null) : null,
      sources: [...new Set(envs.map((x) => SOURCE_LABELS[x.hub]))],
      confidence: metrics.length
        ? metrics.reduce<Confidence>((acc, m) => worseConfidence(acc, m.confidence), "alta")
        : null,
      asOf: envs.length
        ? envs.reduce((oldest, x) => (x.env.computedAt < oldest ? x.env.computedAt : oldest), envs[0].env.computedAt)
        : null,
      missing: dossierMissing(d, [facet]),
    };
  });

  return {
    propertyId: d.propertyId,
    property: d.property,
    location: { lat: d.location.lat, lng: d.location.lng, source: d.location.source },
    updatedAt: d.updatedAt,
    alert: buildAlert(d),
    sections,
    pending: d.meta.pending,
    narrativesReady: narratives !== null,
  };
}
