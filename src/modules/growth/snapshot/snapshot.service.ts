/**
 * Armado del PropertySnapshot y su render para el prompt.
 *
 * Todas las fuentes se leen EN PARALELO con `allSettled` y timeout individual
 * (ver collectors). El costo de la foto completa es el de la fuente más lenta,
 * no la suma — que es lo que la vuelve viable dentro de un turno.
 */

import { mintAgentJwt } from "../../../shared/agentAuth/agentJwt";
import {
  collectRmsConfig,
  collectDashboard,
  collectEngineSettings,
  collectGbp,
  collectInventoryCounts,
  collectLinkhub,
  collectMarketSignals,
  collectOtas,
  collectPace,
  collectPricingRules,
  collectPromos,
  collectProperty,
  collectRatePlans,
  collectRecommendations,
  collectRestrictions,
  collectReviews,
  collectSites,
  collectSocialConnections,
  collectVisibility,
  MARKET_RADIUS_KM,
  type HttpContext,
} from "./collectors";
import {
  buildDemand,
  buildDirect,
  buildIdentity,
  buildMarket,
  buildOps,
  buildPresence,
  buildReputation,
  buildRevenue,
} from "./indicators";
import type { PropertySnapshot, SnapshotBlock } from "./snapshot.types";

/** Nivel de experiencia del usuario. Sólo cambia el glosario del render. */
export type ExperienceLevel =
  | "sin_experiencia"
  | "basico"
  | "intermedio"
  | "avanzado";

const CACHE_TTL_MS = Number(process.env.GROWTH_SNAPSHOT_TTL_MS ?? 10 * 60 * 1000);

const cache = new Map<string, { value: PropertySnapshot; expiresAt: number }>();

export function invalidateSnapshot(propertyId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${propertyId}:`)) cache.delete(key);
  }
}

export function resetSnapshotCache(): void {
  cache.clear();
}

export interface BuildSnapshotInput {
  propertyId: string;
  companyId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  /** Inyectable en tests para fijar la temporada y las ventanas. */
  now?: Date;
  /** Saltea la caché (lo usa el seguimiento de un plan, que compara contra baseline). */
  fresh?: boolean;
}

/**
 * La foto comercial de la propiedad.
 *
 * Devuelve `null` SÓLO si no se pudo leer la propiedad en sí: sin identidad no
 * hay snapshot que valga. Cualquier otra fuente ausente deja su bloque en
 * `null` y su nombre en `missing`.
 */
export async function buildPropertySnapshot(
  input: BuildSnapshotInput,
): Promise<PropertySnapshot | null> {
  const now = input.now ?? new Date();
  const cacheKey = `${input.propertyId}:${input.userId ?? "anon"}`;
  if (!input.fresh) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const start = Date.now();

  // La identidad va primero y sola: de ella salen lat/lng (para el mercado) y
  // el companyId real. Es la única fuente que, si falla, cancela la foto.
  const property = await collectProperty(input.propertyId);
  if (!property) {
    console.warn(
      `[growth/snapshot] sin propiedad ${input.propertyId}: no hay foto`,
    );
    return null;
  }
  const companyId =
    (typeof property.companyId === "string" && property.companyId) ||
    input.companyId ||
    "";

  // JWT delegado para las fuentes HTTP. Sin userId no se mintea y esas fuentes
  // devuelven null: la foto sale igual, más chica y con los bloques declarados.
  let agentJwt: string | undefined;
  if (input.userId) {
    try {
      agentJwt = await mintAgentJwt({
        userId: input.userId,
        companyId,
        agentId: input.agentId,
        sessionId: input.sessionId,
      });
    } catch (err) {
      console.warn(
        "[growth/snapshot] no se pudo mintear el JWT delegado:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const ctx: HttpContext = { propertyId: input.propertyId, companyId, agentJwt };

  const address =
    property.address && typeof property.address === "object"
      ? (property.address as Record<string, unknown>)
      : {};
  const lat = typeof address.lat === "number" ? address.lat : null;
  const lng = typeof address.lng === "number" ? address.lng : null;

  // Todo lo demás, en paralelo. `allSettled` no hace falta: cada recolector ya
  // atrapa lo suyo y devuelve null (así un rechazo no puede escaparse acá).
  const [
    inventory,
    pace,
    dashboard,
    engineSettings,
    ratePlans,
    promos,
    restrictions,
    sites,
    linkhub,
    visibility,
    gbp,
    otas,
    social,
    reviews,
    rules,
    recommendations,
    rmsConfig,
    signals,
  ] = await Promise.all([
    collectInventoryCounts(input.propertyId),
    collectPace(ctx),
    collectDashboard(ctx),
    collectEngineSettings(ctx),
    collectRatePlans(ctx),
    collectPromos(ctx),
    collectRestrictions(ctx),
    collectSites(input.propertyId, companyId),
    collectLinkhub(input.propertyId),
    collectVisibility(input.propertyId),
    collectGbp(input.propertyId),
    collectOtas(input.propertyId),
    collectSocialConnections(input.propertyId),
    collectReviews(input.propertyId),
    collectPricingRules(ctx),
    collectRecommendations(ctx),
    collectRmsConfig(ctx),
    collectMarketSignals({ lat, lng, now }),
  ]);

  const identity = buildIdentity({
    propertyId: input.propertyId,
    property,
    units: inventory?.units ?? 0,
    categories: inventory?.categories ?? 0,
    now,
  });

  const demand = pace ? buildDemand(pace, now) : null;
  const ops = dashboard ? buildOps(dashboard) : null;
  const direct =
    engineSettings || ratePlans || promos
      ? buildDirect({ engineSettings, ratePlans, promos, restrictions })
      : null;
  const presence =
    sites || linkhub || visibility || gbp || otas || social
      ? buildPresence({
          sites: sites ?? [],
          linkhub,
          visibility,
          gbp,
          otas: otas ?? [],
          socialConnections: social ?? [],
          propertyId: input.propertyId,
        })
      : null;
  const reputation = reviews ? buildReputation(reviews, now) : null;
  const market = signals
    ? buildMarket({ signals, now, lat, radiusKm: MARKET_RADIUS_KM })
    : null;
  const revenue =
    rules || recommendations
      ? buildRevenue({ rules, recommendations, config: rmsConfig })
      : null;

  const missing: SnapshotBlock[] = [];
  if (!demand) missing.push("demand");
  if (!ops) missing.push("ops");
  if (!direct) missing.push("direct");
  if (!presence) missing.push("presence");
  if (!reputation) missing.push("reputation");
  if (!market) missing.push("market");
  if (!revenue) missing.push("revenue");

  const snapshot: PropertySnapshot = {
    propertyId: input.propertyId,
    companyId,
    takenAt: now.toISOString(),
    missing,
    collectedInMs: Date.now() - start,
    identity,
    demand,
    ops,
    direct,
    presence,
    reputation,
    market,
    revenue,
  };

  cache.set(cacheKey, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
  return snapshot;
}

// ── Render para el prompt ────────────────────────────────────────────────────

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "s/d";
  return `${Math.round(v * 100)}%`;
}

function money(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "s/d";
  return `${Math.round(v).toLocaleString("es-AR")} ${currency}`.trim();
}

function nOr(v: number | null | undefined, suffix = ""): string {
  return v === null || v === undefined ? "s/d" : `${v}${suffix}`;
}

/** Concordancia de número. La foto la lee un modelo, pero la escribe una persona. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Términos técnicos que el snapshot usa y que un principiante puede no conocer.
 * No se sacan del texto — se explican. Un plan que evita nombrar el ADR no le
 * enseña nada a nadie; uno que lo nombra y lo explica, sí.
 */
const GLOSSARY: Array<{ term: string; gloss: string }> = [
  { term: "OTB", gloss: "noches ya vendidas para fechas futuras" },
  { term: "pace index", gloss: "ritmo de venta comparado con el mismo momento de años anteriores: 1,0 es el ritmo normal" },
  { term: "ADR", gloss: "tarifa promedio por noche vendida" },
  { term: "pickup", gloss: "noches vendidas en los últimos 7 días" },
  { term: "comp-set", gloss: "el grupo de hoteles con los que te comparás" },
];

const MISSING_LABEL: Record<SnapshotBlock, string> = {
  identity: "identidad de la propiedad",
  demand: "ritmo de venta futuro (pace)",
  ops: "ocupación e ingresos de los últimos 30 días",
  direct: "motor de reservas, tarifas y promociones",
  presence: "sitio web, LinkHub, Google y OTAs",
  reputation: "reseñas",
  market: "eventos y feriados de la zona",
  revenue: "reglas y recomendaciones de precio",
};

/**
 * El snapshot como texto denso para el prompt: ~600-900 tokens.
 *
 * Texto y no JSON a propósito: el JSON gasta tokens en llaves y comillas, y el
 * modelo lee peor una estructura anidada que una línea por hecho.
 */
export function renderSnapshotBlock(
  snap: PropertySnapshot,
  level: ExperienceLevel = "basico",
): string {
  const i = snap.identity;
  const cur = i.currency || "";
  const lines: string[] = [
    "## Foto de la propiedad (datos reales, leídos ahora)",
    `Tomada: ${snap.takenAt.slice(0, 16).replace("T", " ")} UTC. Todo lo que afirmes sobre el negocio tiene que salir de acá o de una herramienta de este turno.`,
    "",
    `**Identidad** — ${i.name || "sin nombre"} · ${i.type} · ${[i.city, i.countryCode].filter(Boolean).join(", ") || "sin ubicación"} · moneda ${cur || "s/d"}`,
    `- Inventario: ${i.units} unidades en ${i.categories} categorías (modelo de venta: ${i.salesModel})`,
    `- Antigüedad en la plataforma: ${i.monthsOnPlatform} meses`,
  ];

  if (snap.demand) {
    const d = snap.demand;
    lines.push(
      "",
      "**Venta futura** (lo ya vendido para los próximos días)",
      `- Noches vendidas (OTB): ${d.otb30} a 30 días · ${d.otb60} a 60 · ${d.otb90} a 90`,
      `- Ocupación de los próximos 30 días: ${pct(d.occ30)} · tarifa promedio: ${money(d.adr, "USD")} · ingresos comprometidos: ${money(d.revenueOtb30, "USD")}`,
      `- Pickup últimos 7 días: ${d.pickup7d} noches`,
      d.hasHistory
        ? `- Pace index promedio: ${nOr(d.paceIndexAvg)} · fechas por debajo del umbral lento: ${d.datesAtRisk}`
        : `- Pace index: NO CONFIABLE todavía (${d.historyDays} días de historia, sin benchmark propio). No saques ninguna conclusión sobre el ritmo de venta.`,
    );
  }

  if (snap.ops) {
    const o = snap.ops;
    lines.push(
      "",
      "**Operación y canales**",
      `- Reservas del período: ${o.reservationsCurrent} (período anterior: ${o.reservationsPrevious}` +
        (o.reservationsDeltaPct !== null
          ? `, ${o.reservationsDeltaPct >= 0 ? "+" : ""}${Math.round(o.reservationsDeltaPct)}%)`
          : ")"),
      `- Hoy en casa: ${o.activeToday} · llegan esta semana: ${o.incomingThisWeek}`,
      o.directSharePct !== null
        ? `- Reservas por canal directo: ${o.directSharePct}% (de ${o.channels} canales con ventas)`
        : "- Sin reservas en el período: no se puede medir la mezcla de canales",
      o.cancellationRatePct !== null
        ? `- Cancelaciones: ${o.cancellationRatePct}% · de último momento: ${o.lastMinuteCancellations}`
        : "- Sin datos de cancelación",
      `- Estadía promedio: ${o.avgStayNights === null ? "s/d" : plural(o.avgStayNights, "noche", "noches")} · reservas pendientes vencidas: ${o.pendingOverdue}`,
    );
  }

  if (snap.direct) {
    const d = snap.direct;
    lines.push(
      "",
      "**Canal directo (motor de reservas propio)**",
      `- Motor: ${d.engineActive ? "activo" : "INACTIVO"} · ${plural(d.ratePlans, "plan de tarifa", "planes de tarifa")} · ${plural(d.promosActive, "promoción vigente", "promociones vigentes")}`,
      `- Promoción exclusiva de la web propia: ${d.webOnlyPromo ? "sí" : "no"} · restricciones por día cargadas: ${d.hasRestrictions ? "sí" : "no"}`,
    );
  }

  if (snap.presence) {
    const p = snap.presence;
    lines.push(
      "",
      "**Presencia digital**",
      `- Sitio web: ${p.sitePublished ? `publicado (${p.siteLanguages} idiomas)` : "SIN PUBLICAR"} · LinkHub: ${p.linkhubPublished ? "publicado" : "sin publicar"}`,
      `- Score de visibilidad: ${nOr(p.visibilityScore, "/100")} (SEO ${nOr(p.seoScore)}, GEO ${nOr(p.geoScore)})`,
      `- Ficha de Google completa al ${pct(p.gbpCompleteness)} · fichas de OTA al ${pct(p.otaCompleteness)}${p.otaPlatforms.length ? ` (${p.otaPlatforms.join(", ")})` : " (ninguna cargada)"}`,
      `- Redes conectadas: ${p.socialConnected}`,
    );
  }

  if (snap.reputation) {
    const r = snap.reputation;
    lines.push(
      "",
      "**Reputación**",
      r.reviews === 0
        ? "- Sin reseñas cargadas"
        : `- ${nOr(r.rating)} de 5 sobre ${r.reviews} reseñas · ${r.responded} respondidas (${pct(r.responded / r.reviews)}) · ${r.last90d} en los últimos 90 días`,
    );
  }

  if (snap.market) {
    const m = snap.market;
    lines.push(
      "",
      `**Mercado (${m.radiusKm} km alrededor)**`,
      `- Temporada actual: ${m.season}`,
      `- Próximos 90 días: ${m.eventsNext90d} eventos · ${m.longWeekendsNext90d} feriados o fines de semana largos`,
      ...(m.topEvents.length
        ? [`- Eventos destacados: ${m.topEvents.map((e) => `${e.name} (${e.date})`).join(" · ")}`]
        : []),
    );
  }

  if (snap.revenue) {
    const r = snap.revenue;
    lines.push(
      "",
      "**Revenue**",
      `- Reglas de precio activas: ${r.rulesActive} · recomendaciones sin resolver: ${r.recommendationsPending}`,
      `- Comp-set: ${r.compsetConfigured ? `${r.competitors} competidores cargados` : "SIN configurar (no podés afirmar nada sobre el mercado)"} · aplicación automática: ${r.autoApply ? "sí" : "no"}`,
    );
  }

  if (snap.missing.length > 0) {
    lines.push(
      "",
      "**Sin datos** (no se pudieron leer; NO afirmes nada sobre estos temas y decilo si es relevante):",
      ...snap.missing.map((b) => `- ${MISSING_LABEL[b]}`),
    );
  }

  if (level === "sin_experiencia" || level === "basico") {
    const used = GLOSSARY.filter((g) =>
      lines.some((l) => l.toLowerCase().includes(g.term.toLowerCase())),
    );
    if (used.length > 0) {
      lines.push(
        "",
        "**Cómo explicar estos términos** (el usuario puede no conocerlos; usalos y aclaralos la primera vez):",
        ...used.map((g) => `- ${g.term}: ${g.gloss}`),
      );
    }
  }

  return lines.join("\n");
}
