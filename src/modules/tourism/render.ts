/**
 * El bloque que lee el modelo: texto denso, no JSON.
 *
 * Mismo criterio que `renderSnapshotBlock` del turno estratégico: una línea por
 * indicador con su unidad y su fecha, lo curado marcado, y una sección
 * "Sin datos" explícita para que el modelo no rellene con su conocimiento
 * general. Con las cuatro facetas ronda los 600-900 tokens.
 */

import type { ExperienceLevel } from "../../shared/agentAuth/userScope";
import { PROFILE_LABEL, dossierMissing } from "./card";
import {
  MONTH_LONG,
  ageText,
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
  hubsForFacets,
  type AttentionSlim,
  type CalendarSlim,
  type ClimateSlim,
  type EventItem,
  type EventsSlim,
  type HazardsSlim,
  type HubEnvelope,
  type PlaceSlim,
  type TourismDossier,
  type TourismFacet,
  type TourismHub,
} from "./tourism.types";

const LOCATION_TEXT = {
  property: "exacta (coordenadas cargadas)",
  geocoded: "aproximada (dirección ubicada en el mapa)",
  city: "aproximada a la ciudad (no hay coordenadas ni dirección precisa)",
} as const;

const RENDER_ORDER: TourismHub[] = ["events", "attention", "calendar", "climate", "place", "hazards"];

const pct = (x: number) => `${Math.round(x * 100)}`;

export interface RenderOptions {
  level?: ExperienceLevel;
  now?: Date;
}

export function renderTourismBlock(
  d: TourismDossier,
  facets: readonly TourismFacet[],
  opts: RenderOptions = {},
): string {
  const now = opts.now ?? new Date();
  const level = opts.level ?? "basico";
  const hubs = hubsForFacets(facets);
  const p = d.property;

  const lines: string[] = [
    "## Estado turístico de la zona",
    "Datos reales leídos por el sistema, NO por vos. Las cifras principales ya están en una tarjeta en pantalla: " +
      "interpretalas para este alojamiento, no las repitas ni las redondees distinto. " +
      "Lo marcado [estimado] sale de tablas curadas: es una referencia general, no un dato en vivo.",
    `Propiedad: ${p.typeLabel} "${p.name}" en ${p.addressShort || "ubicación sin dirección"}. ` +
      `Ubicación ${LOCATION_TEXT[d.location.source]}.`,
  ];

  const age = (env: HubEnvelope) =>
    now.getTime() - Date.parse(env.computedAt) > 2 * 60 * 60 * 1000 ? ` (leído ${ageText(env.computedAt, now)})` : "";

  for (const hub of RENDER_ORDER) {
    if (!hubs.includes(hub)) continue;
    const env = d.hubs[hub] as HubEnvelope | undefined;
    if (!env || env.data === null) continue;
    switch (hub) {
      case "events":
        lines.push(...renderEvents(env.data as EventsSlim, now, age(env)));
        break;
      case "attention":
        lines.push(...renderAttention(env.data as AttentionSlim, age(env)));
        break;
      case "calendar":
        lines.push(...renderCalendar(env.data as CalendarSlim, now, age(env)));
        break;
      case "climate":
        lines.push(...renderClimate(env.data as ClimateSlim, now, age(env)));
        break;
      case "place":
        lines.push(...renderPlace(env.data as PlaceSlim, age(env)));
        break;
      case "hazards":
        lines.push(...renderHazards(env.data as HazardsSlim, age(env)));
        break;
    }
  }

  const missing = dossierMissing(d, facets);
  if (missing.length) {
    lines.push(
      `Sin datos: ${missing.join("; ")}. No afirmes nada sobre eso ni lo completes con conocimiento general: ` +
        "decí en media línea que hoy no lo tenés.",
    );
  }

  if (level === "sin_experiencia" || level === "basico") {
    lines.push(
      'Glosario, por si usás el término: "fin de semana largo" = feriado pegado al fin de semana; ' +
        '"puente" = día hábil que se libera para alargarlo; "receso escolar" = vacaciones de las escuelas (viajan familias); ' +
        '"noches-delegado" = asistentes × noches que se quedan; "entre semana" = demanda de martes a jueves.',
    );
  }

  return lines.join("\n");
}

function eventLine(i: EventItem): string {
  const extra = [
    `${dateRange(i.startDate, i.endDate)}`,
    kmAway(i.distanceKm),
    i.kind === "mice" && i.dayPattern === "midweek" ? "entre semana" : null,
    i.confidence === "estimado" ? "[estimado]" : i.confidence === "media" ? "fuente menos confiable" : null,
  ].filter(Boolean);
  return `${truncate(i.name, 48)} (${extra.join(", ")})`;
}

function renderEvents(e: EventsSlim, now: Date, age: string): string[] {
  const today = isoDay(now);
  const k = e.byKind90d;
  const kinds = [
    k.cultura ? `${k.cultura} culturales` : null,
    k.deporte ? `${k.deporte} deportivos` : null,
    k.mice ? `${k.mice} corporativos` : null,
  ].filter(Boolean);
  const out = [
    `Eventos a ${e.radiusKm} km${age}: ${e.next30d}${e.floor30 ? " o más" : ""} empiezan en 30 días · ` +
      `${e.next90d}${e.floor90 ? " o más" : ""} en 90 días${kinds.length ? ` (${kinds.join(", ")})` : ""}.`,
  ];
  const upcoming = e.items.filter((i) => i.startDate >= today && i.origin === "listing").slice(0, 5);
  if (upcoming.length) out.push(`- Próximos en agenda: ${upcoming.map(eventLine).join(" · ")}.`);
  const anchors = e.anchors.slice(0, 3);
  if (anchors.length) {
    out.push(
      `- Grandes eventos que se conocen con antelación: ${anchors
        .map(
          (a) =>
            `${truncate(a.name, 48)} (${dateRange(a.startDate, a.endDate)}, ${kmAway(a.distanceKm)}, impacto ${impactLabel(a.impact)}` +
            `${a.attendees ? `, ~${thousands(a.attendees)} asistentes` : ""}${a.confidence === "estimado" ? ", [estimado]" : ""})`,
        )
        .join(" · ")}.`,
    );
  }
  if (e.delegateNights90d > 0) {
    out.push(
      `- Demanda corporativa en 90 días: ≈ ${thousands(e.delegateNights90d)} noches-delegado (sólo congresos curados) [estimado].`,
    );
  }
  if (!e.feedAvailable) {
    out.push("- La agenda de eventos con ticket no está disponible ahora: sólo hay grandes eventos de tablas curadas.");
  } else if (!e.listingsInRadius) {
    out.push(
      "- No hay eventos con ticket relevados en el radio. La cobertura depende de las ciudades que sigue el radar: " +
        'NO digas "no hay eventos"; decí que no están relevados.',
    );
  }
  return out;
}

function renderAttention(a: AttentionSlim, age: string): string[] {
  const parts = [`~${thousands(a.weeklyViews)} vistas por semana sumando 6 idiomas`];
  if (a.trendPct !== null) {
    parts.push(`última semana vs. las 4 anteriores: ${signedPct(a.trendPct)} (edición ${a.seriesEdition ?? "principal"})`);
  }
  parts.push(a.spikeRatio ? `pico de ${a.spikeRatio}× desde el ${a.spikeSince ? dayMonth(a.spikeSince) : "inicio de semana"}` : "sin pico");
  const langs = a.topLanguages.map((l) => `${l.label} ${pct(l.share)}%`).join(" · ");
  const out = [
    `Interés online en el destino (vistas del artículo de Wikipedia "${a.article}"; la atención anticipa la reserva por semanas)${age}: ` +
      `${parts.join("; ")}. Por idioma (≈ por mercado): ${langs}.`,
  ];
  if (a.resolvedVia === "geosearch") {
    out.push("- Ojo: el artículo se eligió por cercanía; puede ser un lugar puntual y no la ciudad.");
  }
  return out;
}

function renderCalendar(c: CalendarSlim, now: Date, age: string): string[] {
  const today = isoDay(now);
  const out = [`Calendario de ${c.countryName || c.countryCode}${age}:`];
  const weekends = c.longWeekends.filter((l) => l.endDate >= today).slice(0, 3);
  if (weekends.length) {
    out.push(
      `- Fines de semana largos: ${weekends
        .map(
          (l) =>
            `${dateRange(l.startDate, l.endDate)} (${l.dayCount} días${l.needBridgeDay ? ", con puente" : ""}` +
            `${l.holidays[0] ? `, ${l.holidays[0]}` : ""})`,
        )
        .join(" · ")}.`,
    );
  }
  if (c.holidays90d.length) {
    out.push(`- Feriados en 90 días: ${c.holidays90d.slice(0, 5).map((h) => `${dayMonth(h.date)} ${h.name}`).join(" · ")}.`);
  }
  if (c.schoolBreaks.length) {
    out.push(
      `- Recesos escolares: ${c.schoolBreaks
        .slice(0, 2)
        .map(
          (b) =>
            `${dateRange(b.startDate, b.endDate)} ${truncate(b.name, 40)}${b.blockLabel ? ` — ${b.blockLabel}` : ""}` +
            `${b.confidence === "estimado" ? " [estimado]" : b.confidence === "media" ? " (regla verificada contra el último ciclo)" : ""}`,
        )
        .join(" · ")}.`,
    );
  }
  if (c.emitters60d.length) {
    out.push(
      `- Mercados emisores con fin de semana largo o vacaciones en 60 días: ${c.emitters60d
        .slice(0, 6)
        .map(
          (w) =>
            `${w.countryName || w.countryCode} ${dateRange(w.startDate, w.endDate)} ` +
            `(${w.kind === "receso_escolar" ? "vacaciones escolares" : "fin de semana largo"}${w.confidence === "estimado" ? ", [estimado]" : ""})`,
        )
        .join(" · ")}.`,
    );
  }
  if (c.observances90d.length) {
    out.push(
      `- Fechas comerciales [estimado]: ${c.observances90d.slice(0, 3).map((o) => `${o.name} ${dayMonth(o.date)}`).join(" · ")}.`,
    );
  }
  return out.length > 1 ? out : [];
}

function renderClimate(c: ClimateSlim, now: Date, age: string): string[] {
  const seasons = [
    c.best.length ? `mejores meses ${monthSpans(c.best)}` : null,
    c.warmest.length ? `más cálidos ${monthSpans(c.warmest)}` : null,
    c.coldest.length ? `más fríos ${monthSpans(c.coldest)}` : null,
    c.wet.length ? `lluvias ${monthSpans(c.wet)}` : null,
    c.snow.length ? `nieve ${monthSpans(c.snow)}` : null,
  ].filter(Boolean);
  const out = [`Clima ${PROFILE_LABEL[c.profile] ?? c.profile} (promedio de 10 años)${age}: ${seasons.join(" · ")}.`];
  const month = now.getUTCMonth() + 1;
  const n = c.normals.find((x) => x.month === month);
  if (n && n.tMax !== null && n.tMin !== null) {
    out.push(
      `- En ${MONTH_LONG[month - 1]}: máx ${n.tMax}°C, mín ${n.tMin}°C` +
        `${n.rainDays !== null ? `, ${n.rainDays} días de lluvia` : ""}.`,
    );
  }
  if (c.hurricane) out.push(`- Temporada de ciclones (${c.hurricane.basin}): ${monthSpans(c.hurricane.months)} [estimado].`);
  return out;
}

function renderPlace(p: PlaceSlim, age: string): string[] {
  const w = p.walkability;
  const out = [
    `Entorno a pie (${p.radiusKm} km, OpenStreetMap)${age}: caminabilidad ${w.score}/100 "${w.label}" ` +
      `(comercios ${pct(w.components.amenities)}, veredas y cruces ${pct(w.components.pedestrian)}, transporte ${pct(w.components.transit)}) · ` +
      `${p.gastronomy}${p.truncated ? " o más" : ""} lugares para comer · ${p.nightlife} de vida nocturna · ` +
      `ruido "${p.noise.label}"${p.noise.sources.length ? ` (${p.noise.sources.join(", ")})` : ""}; el ruido es geometría, no una medición.`,
  ];
  if (p.nearby.length) {
    out.push(
      `- Cerca: ${p.nearby
        .slice(0, 6)
        .map((n) => `${n.label}${n.name ? ` "${truncate(n.name, 30)}"` : ""}${n.iata ? ` (${n.iata})` : ""} a ${distanceText(n.distanceM)}`)
        .join(" · ")}.`,
    );
  }
  out.push(`- Perfil: ${p.profile}.`);
  return out;
}

function renderHazards(h: HazardsSlim, age: string): string[] {
  const level = { Red: "roja", Orange: "naranja", Green: "verde" } as const;
  const serious = h.active.filter((a) => a.alertLevel !== "Green");
  const air = h.airliftRisk.filter((r) => r.alertLevel !== "Green");
  if (!serious.length && !air.length && !h.anomalies.length) {
    return [`Alertas de desastres (GDACS, ${h.radiusKm} km)${age}: ninguna activa.`];
  }
  const parts = [
    ...serious.map(
      (a) =>
        `${a.typeName} "${a.name}" con alerta ${level[a.alertLevel]} ${a.scope === "country" ? "en el país" : `a ${a.distanceKm} km`}` +
        `${a.ongoing ? "" : " (ya terminó)"}`,
    ),
    ...air.map((r) => `${r.hazard} cerca del aeropuerto ${r.airportIata ?? r.airport} (alerta ${level[r.alertLevel]})`),
    ...h.anomalies.map(
      (a) => `${a.kind === "heat" ? "ola de calor" : "ola de frío"} ${dateRange(a.startDate, a.endDate)} (pico ${a.peakC}°C)`,
    ),
  ];
  return [`Alertas (GDACS y pronóstico, ${h.radiusKm} km)${age}: ${parts.join(" · ")}.`];
}
