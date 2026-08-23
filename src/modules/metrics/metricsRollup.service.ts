import { MetricsDaily, MetricsJobState } from "./metrics.model";
import {
  getGuestModel,
  getInductionModel,
  getLinkhubEventModel,
  getOperativeSpaceModel,
  getReservationModel,
  getReviewModel,
  getRmsConfigModel,
  getRmsFactModel,
  getRmsRecommendationModel,
  getRmsRuleModel,
  getSearchEventModel,
  getSiteEventModel,
  getSiteModel,
} from "./metricsSources";
import { getCompanyModel, getPropertyModel } from "../hotels/pmsModels";
import { getPmsConnection } from "../../shared/pmsDb";
import { computeAppDay } from "./metricsAppRollup.service";
import { AnalyticsEvent } from "../analytics/analytics.model";
import { UsageDailyRollup } from "../usage/usage.model";
import { ConversationSession } from "../conversations/conversations.model";

/**
 * Consolidación diaria. Ver METRICAS-COMPORTAMIENTO-SPEC.md §10.
 *
 * Idempotente por diseño: recomputa una ventana de días y hace upsert, así que
 * correrlo dos veces sobre el mismo día da el mismo resultado (mismo patrón que
 * el `factsIngestService` del RMS). Eso permite recuperarse de una caída sin
 * intervención: la próxima corrida rellena lo que faltó.
 */

/** Companies de prueba a excluir (hotel-test, seeds…). */
const EXCLUDED = (process.env.METRICS_EXCLUDED_COMPANY_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Acumulador mutable por propiedad; se vuelca tal cual al doc del rollup. */
type Bucket = Record<string, number | null | Record<string, number>>;

function emptyBucket(): Bucket {
  return {};
}

function bump(b: Bucket, key: string, by = 1): void {
  b[key] = ((b[key] as number) ?? 0) + by;
}

function bumpMap(b: Bucket, key: string, sub: string, by = 1): void {
  const map = (b[key] as Record<string, number>) ?? {};
  map[sub] = (map[sub] ?? 0) + by;
  b[key] = map;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, z) => a - z);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 10000) / 100;
}

interface DayContext {
  day: string;
  start: Date;
  end: Date;
  /** propertyId → companyId */
  companyByProperty: Map<string, string>;
  companyIds: string[];
}

/** Devuelve el bucket de una propiedad, creándolo si hace falta. */
function bucketFor(map: Map<string, Bucket>, propertyId: string): Bucket {
  let b = map.get(propertyId);
  if (!b) {
    b = emptyBucket();
    map.set(propertyId, b);
  }
  return b;
}

// ── Recolectores ──────────────────────────────────────────────────────────

async function collectReservations(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
): Promise<void> {
  const Reservation = await getReservationModel();
  const rows = await Reservation.find({
    createdAt: { $gte: ctx.start, $lt: ctx.end },
  })
    .select({
      propertyId: 1,
      origin: 1,
      sourceChannelId: 1,
      nights: 1,
      totalAmount: 1,
      createdAt: 1,
      confirmedAt: 1,
    })
    .lean();

  const confirmLatency = new Map<string, number[]>();

  for (const r of rows) {
    if (!r.propertyId) continue;
    const b = bucketFor(byProperty, r.propertyId);
    // Sin `origin` (reservas anteriores al backfill) se asume motor, que es el
    // default del schema; el backfill ya las marcó, así que esto casi no aplica.
    const origin = r.origin ?? "engine";
    if (origin === "engine") bump(b, "res_engine_created");
    else if (origin === "agent") bump(b, "res_agent_created");
    else bump(b, "res_staff_created");

    bump(b, "res_nights", r.nights ?? 0);
    bump(b, "res_amount_base", r.totalAmount ?? 0);
    bumpMap(b, "res_by_source", r.sourceChannelId || "__none__");

    if (r.confirmedAt && r.createdAt) {
      const mins =
        (new Date(r.confirmedAt).getTime() - new Date(r.createdAt).getTime()) /
        60000;
      if (mins >= 0) {
        const arr = confirmLatency.get(r.propertyId) ?? [];
        arr.push(mins);
        confirmLatency.set(r.propertyId, arr);
      }
    }
  }

  for (const [propertyId, values] of confirmLatency) {
    const b = bucketFor(byProperty, propertyId);
    b.res_time_to_confirm_p50_min = median(values);
  }

  // Transiciones del día: se cuentan por su timestamp propio, no por el estado
  // actual — una reserva confirmada hoy y cancelada mañana cuenta en cada día.
  for (const [field, key] of [
    ["confirmedAt", "res_confirmed"],
    ["cancelledAt", "res_cancelled"],
    ["noShowAt", "res_noshow"],
  ] as const) {
    const agg = await Reservation.aggregate<{ _id: string; n: number }>([
      { $match: { [field]: { $gte: ctx.start, $lt: ctx.end } } },
      { $group: { _id: "$propertyId", n: { $sum: 1 } } },
    ]);
    for (const row of agg) {
      if (!row._id) continue;
      bump(bucketFor(byProperty, row._id), key, row.n);
    }
  }

  // Share motor vs. manual. El agente queda fuera del ratio a propósito: la
  // pregunta del piloto es si el HUÉSPED usa el motor o si el hotel carga a
  // mano, y una reserva del agente no responde ni una cosa ni la otra.
  for (const b of byProperty.values()) {
    const engine = (b.res_engine_created as number) ?? 0;
    const staff = (b.res_staff_created as number) ?? 0;
    b.res_engine_share_pct = pct(engine, engine + staff);
  }
}

async function collectSearches(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
): Promise<void> {
  const SearchEvent = await getSearchEventModel();
  const rows = await SearchEvent.aggregate<{
    _id: { propertyId: string; source: string; had: boolean };
    n: number;
  }>([
    { $match: { createdAt: { $gte: ctx.start, $lt: ctx.end } } },
    {
      $group: {
        _id: {
          propertyId: "$propertyId",
          source: "$source",
          had: "$hadAvailability",
        },
        n: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    if (!row._id?.propertyId) continue;
    const b = bucketFor(byProperty, row._id.propertyId);
    bump(b, "searches_total", row.n);
    if (row._id.had === false) bump(b, "searches_no_avail", row.n);
    if (row._id.source === "agent") bump(b, "searches_agent", row.n);
  }
}

/** Pasos del embudo → campo del rollup. */
const FUNNEL_MAP: Record<string, string> = {
  engine_search_initiated: "funnel_search",
  engine_results_viewed: "funnel_results",
  engine_category_selected: "funnel_category",
  engine_checkout_started: "funnel_checkout",
  engine_auth_completed: "funnel_auth",
  engine_reservation_created: "funnel_created",
};

async function collectAnalyticsEvents(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
  byCompany: Map<string, Bucket>,
): Promise<void> {
  // Embudo: sesiones DISTINTAS por paso, no cantidad de eventos (una búsqueda
  // repetida cinco veces no son cinco recorridos).
  const funnel = await AnalyticsEvent.aggregate<{
    _id: { propertyId: string | null; eventName: string };
    sessions: number;
  }>([
    {
      $match: {
        serverTimestamp: { $gte: ctx.start, $lt: ctx.end },
        eventName: { $in: Object.keys(FUNNEL_MAP) },
        sessionId: { $ne: "server" },
      },
    },
    {
      $group: {
        _id: {
          propertyId: "$propertyId",
          eventName: "$eventName",
          sessionId: "$sessionId",
        },
      },
    },
    {
      $group: {
        _id: { propertyId: "$_id.propertyId", eventName: "$_id.eventName" },
        sessions: { $sum: 1 },
      },
    },
  ]);
  for (const row of funnel) {
    if (!row._id?.propertyId) continue;
    const field = FUNNEL_MAP[row._id.eventName];
    if (field) bump(bucketFor(byProperty, row._id.propertyId), field, row.sessions);
  }
  for (const b of byProperty.values()) {
    b.funnel_conversion_pct = pct(
      (b.funnel_created as number) ?? 0,
      (b.funnel_search as number) ?? 0,
    );
  }

  // Uso del PMS: por compañía (el staff no siempre trabaja sobre una property).
  const opens = await AnalyticsEvent.aggregate<{
    _id: { companyId: string; appId: string };
    n: number;
  }>([
    {
      $match: {
        serverTimestamp: { $gte: ctx.start, $lt: ctx.end },
        eventName: "app_opened",
      },
    },
    {
      $group: {
        _id: { companyId: "$companyId", appId: "$payload.appId" },
        n: { $sum: 1 },
      },
    },
  ]);
  for (const row of opens) {
    if (!row._id?.companyId || !row._id.appId) continue;
    bumpMap(bucketFor(byCompany, row._id.companyId), "pms_app_opens", row._id.appId, row.n);
  }

  const dau = await AnalyticsEvent.aggregate<{ _id: string; users: number }>([
    {
      $match: {
        serverTimestamp: { $gte: ctx.start, $lt: ctx.end },
        userId: { $ne: null },
        category: { $in: ["pms", "onboarding", "builder"] },
      },
    },
    { $group: { _id: { companyId: "$companyId", userId: "$userId" } } },
    { $group: { _id: "$_id.companyId", users: { $sum: 1 } } },
  ]);
  for (const row of dau) {
    if (!row._id) continue;
    bump(bucketFor(byCompany, row._id), "pms_dau", row.users);
  }

  // Onboarding y guías.
  const simple: Array<[string, string, "company"]> = [
    ["onboarding_started", "ob_started", "company"],
    ["onboarding_completed", "ob_completed", "company"],
    ["guide_completed", "pms_guides_completed", "company"],
    ["agentic_endpoint_hit", "agentic_hits", "company"],
  ];
  for (const [eventName, field] of simple) {
    const rows = await AnalyticsEvent.aggregate<{ _id: string; n: number }>([
      {
        $match: {
          serverTimestamp: { $gte: ctx.start, $lt: ctx.end },
          eventName,
        },
      },
      { $group: { _id: "$companyId", n: { $sum: 1 } } },
    ]);
    for (const row of rows) {
      if (!row._id) continue;
      bump(bucketFor(byCompany, row._id), field, row.n);
    }
  }

  // Dónde se traba la gente: último paso alcanzado por compañía en el día.
  const steps = await AnalyticsEvent.aggregate<{
    _id: { companyId: string; stepIndex: number };
    n: number;
  }>([
    {
      $match: {
        serverTimestamp: { $gte: ctx.start, $lt: ctx.end },
        eventName: "onboarding_step_completed",
      },
    },
    {
      $group: {
        _id: { companyId: "$companyId", stepIndex: "$payload.stepIndex" },
        n: { $sum: 1 },
      },
    },
  ]);
  for (const row of steps) {
    if (!row._id?.companyId || row._id.stepIndex == null) continue;
    bumpMap(
      bucketFor(byCompany, row._id.companyId),
      "ob_step_hist",
      String(row._id.stepIndex),
      row.n,
    );
  }
}

async function collectLinkhubAndSites(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
  byCompany: Map<string, Bucket>,
): Promise<void> {
  const LinkhubEvent = await getLinkhubEventModel();
  const lh = await LinkhubEvent.aggregate<{
    _id: {
      propertyId: string;
      type: string;
      kind: string | null;
      blockType: string | null;
      source: string | null;
    };
    n: number;
    visitors: string[];
  }>([
    { $match: { day: ctx.day } },
    {
      $group: {
        _id: {
          propertyId: "$propertyId",
          type: "$type",
          kind: "$kind",
          blockType: "$blockType",
          source: "$source",
        },
        n: { $sum: 1 },
        visitors: { $addToSet: "$visitorId" },
      },
    },
  ]);
  const lhVisitors = new Map<string, Set<string>>();
  for (const row of lh) {
    const pid = row._id?.propertyId;
    if (!pid) continue;
    const b = bucketFor(byProperty, pid);
    if (row._id.type === "view") {
      bump(b, "lh_views", row.n);
      const set = lhVisitors.get(pid) ?? new Set<string>();
      for (const v of row.visitors) if (v) set.add(v);
      lhVisitors.set(pid, set);
      if (row._id.source === "qr") bump(b, "lh_src_qr", row.n);
      if (row._id.source === "share") bump(b, "lh_src_share", row.n);
    } else if (row._id.type === "click") {
      bump(b, "lh_clicks", row.n);
      // El clic al bloque de reservas es el paso previo al motor: es lo que
      // permite medir la conversión del link-in-bio, el canal del piloto.
      if (row._id.blockType === "booking") bump(b, "lh_booking_clicks", row.n);
    }
  }
  for (const [pid, set] of lhVisitors) {
    bucketFor(byProperty, pid).lh_visitors = set.size;
  }

  // Sitios públicos (colección nueva de F1; si aún no existe, no rompe).
  try {
    const SiteEvent = await getSiteEventModel();
    const se = await SiteEvent.aggregate<{
      _id: { companyId: string; propertyId: string | null; type: string; kind: string | null };
      n: number;
      visitors: string[];
    }>([
      { $match: { day: ctx.day } },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            propertyId: "$propertyId",
            type: "$type",
            kind: "$kind",
          },
          n: { $sum: 1 },
          visitors: { $addToSet: "$visitorId" },
        },
      },
    ]);
    const webVisitors = new Map<string, Set<string>>();
    for (const row of se) {
      const target = row._id?.propertyId
        ? bucketFor(byProperty, row._id.propertyId)
        : row._id?.companyId
          ? bucketFor(byCompany, row._id.companyId)
          : null;
      if (!target) continue;
      if (row._id.type === "view") {
        bump(target, "web_views", row.n);
        if (row._id.propertyId) {
          const set = webVisitors.get(row._id.propertyId) ?? new Set<string>();
          for (const v of row.visitors) if (v) set.add(v);
          webVisitors.set(row._id.propertyId, set);
        }
      } else if (row._id.kind === "whatsapp") {
        bump(target, "web_wa_clicks", row.n);
      }
    }
    for (const [pid, set] of webVisitors) {
      bucketFor(byProperty, pid).web_visitors = set.size;
    }
  } catch {
    // `siteevents` todavía no existe en entornos donde F1 no se desplegó.
  }
}

/** Regla canónica de "subsite publicado" (espeja `isSubsitePublished` del PMS). */
function isPublished(status: unknown): boolean {
  const raw = status == null ? "" : String(status).trim().toLowerCase();
  return !["indraft", "draft", "inactive"].includes(raw);
}

async function collectStocks(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
  byCompany: Map<string, Bucket>,
): Promise<void> {
  const [Site, Guest, Space, Review, Property] = await Promise.all([
    getSiteModel(),
    getGuestModel(),
    getOperativeSpaceModel(),
    getReviewModel(),
    getPropertyModel(),
  ]);

  // Sitios: la unidad "una web" es el subsite, no el doc Site.
  const sites = await Site.find({}).select({ companyId: 1, sitesByLanguage: 1 }).lean();
  for (const s of sites) {
    if (!s.companyId) continue;
    const cb = bucketFor(byCompany, s.companyId);
    for (const v of s.sitesByLanguage ?? []) {
      bump(cb, "web_sites_total");
      if (isPublished((v as { status?: unknown }).status)) {
        bump(cb, "web_sites_published");
        const pid = (v as { propertyId?: string }).propertyId;
        if (pid) bump(bucketFor(byProperty, pid), "web_sites_published");
      }
    }
  }

  // StayPass: stock por compañía + altas del día desde `originLog` (F0).
  const guests = await Guest.find({ status: { $ne: "deleted" } })
    .select({ originCompanyIds: 1, originLog: 1, auth0Sub: 1 })
    .lean();
  for (const g of guests) {
    for (const cid of g.originCompanyIds ?? []) {
      const cb = bucketFor(byCompany, cid);
      bump(cb, "sp_guests_stock");
      if (g.auth0Sub) bump(cb, "sp_registered_auth0");
    }
    for (const entry of g.originLog ?? []) {
      // Los entries del backfill llevan una fecha aproximada (el alta global),
      // así que contarlos como altas del día sería inventar una serie.
      if (!entry?.at || entry.method === "backfill") continue;
      const at = new Date(entry.at);
      if (at >= ctx.start && at < ctx.end && entry.companyId) {
        bump(bucketFor(byCompany, entry.companyId), "sp_guests_new");
      }
    }
  }

  // Apps activadas: los espacios de administración ven el catálogo completo
  // sin pasar por `integrationsAppsOS`, así que contarlos inflaría el número.
  const spaces = await Space.find({ isAdminSpace: { $ne: true } })
    .select({ propertyId: 1, companyId: 1, integrationsAppsOS: 1 })
    .lean();
  for (const sp of spaces) {
    const enabled = (sp.integrationsAppsOS ?? []).filter(
      (a) => (a as { enabled?: boolean }).enabled,
    ).length;
    if (sp.propertyId) bump(bucketFor(byProperty, sp.propertyId), "stock_apps_enabled", enabled);
    if (sp.companyId) bump(bucketFor(byCompany, sp.companyId), "stock_apps_enabled", enabled);
  }

  const reviews = await Review.aggregate<{
    _id: string;
    n: number;
    avg: number;
  }>([
    { $match: { isActive: { $ne: false } } },
    { $group: { _id: "$propertyId", n: { $sum: 1 }, avg: { $avg: "$rating" } } },
  ]);
  for (const r of reviews) {
    if (!r._id) continue;
    const b = bucketFor(byProperty, r._id);
    bump(b, "stock_reviews", r.n);
    b.stock_review_score = r.avg ? Math.round(r.avg * 100) / 100 : null;
  }

  const props = await Property.find({}).select({ propertyId: 1, companyId: 1 }).lean();
  for (const p of props) {
    // Sólo a nivel propiedad: el plegado property→company ya la suma. Contarla
    // también en la company la duplicaba (19 propiedades daban 38).
    if (p.propertyId) bucketFor(byProperty, p.propertyId).stock_properties = 1;
  }
}

async function collectIa(
  ctx: DayContext,
  byCompany: Map<string, Bucket>,
): Promise<void> {
  const sessions = await ConversationSession.aggregate<{
    _id: string;
    sessions: number;
    turns: number;
    users: string[];
  }>([
    { $match: { startedAt: { $gte: ctx.start, $lt: ctx.end } } },
    {
      $group: {
        _id: "$context.companyId",
        sessions: { $sum: 1 },
        turns: { $sum: "$turnCount" },
        users: { $addToSet: "$context.userId" },
      },
    },
  ]);
  for (const row of sessions) {
    if (!row._id) continue;
    const b = bucketFor(byCompany, row._id);
    bump(b, "ia_sessions", row.sessions);
    bump(b, "ia_turns", row.turns ?? 0);
    b.ia_users = row.users.filter(Boolean).length;
  }

  // Costo: se reusa el rollup de consumo que ya existe, no se recalcula.
  const usage = await UsageDailyRollup.aggregate<{
    _id: string;
    cost: number;
    toolCalls: number;
  }>([
    { $match: { day: ctx.day } },
    {
      $group: {
        _id: "$companyId",
        cost: { $sum: "$costUsd" },
        toolCalls: { $sum: "$toolCallCount" },
      },
    },
  ]);
  for (const row of usage) {
    if (!row._id) continue;
    const b = bucketFor(byCompany, row._id);
    b.ia_cost_usd = Math.round((row.cost ?? 0) * 1e6) / 1e6;
    bump(b, "ia_tool_calls", row.toolCalls ?? 0);
  }
}

async function collectRms(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
): Promise<void> {
  try {
    const [Fact, Reco, Rule, Config] = await Promise.all([
      getRmsFactModel(),
      getRmsRecommendationModel(),
      getRmsRuleModel(),
      getRmsConfigModel(),
    ]);

    const facts = await Fact.find({ date: ctx.day }).lean();
    for (const f of facts) {
      if (!f.propertyId) continue;
      const b = bucketFor(byProperty, f.propertyId);
      b.rms_revenue_usd = f.revenue_total_usd ?? 0;
      b.rms_occupancy_pct = f.occupancy_pct ?? null;
      b.rms_adr_usd = f.adr_usd ?? null;
      b.rms_revpar_usd = f.revpar_usd ?? null;
    }

    // Adopción del RMS. `applied` es el éxito; `accepted` significa que el push
    // al motor falló, así que NO cuenta como adopción.
    const recos = await Reco.aggregate<{
      _id: { propertyId: string; status: string };
      n: number;
    }>([
      { $match: { resolvedAt: { $gte: ctx.start, $lt: ctx.end } } },
      { $group: { _id: { propertyId: "$propertyId", status: "$status" }, n: { $sum: 1 } } },
    ]);
    for (const row of recos) {
      if (!row._id?.propertyId) continue;
      const b = bucketFor(byProperty, row._id.propertyId);
      if (row._id.status === "applied") bump(b, "rms_reco_applied", row.n);
      if (row._id.status === "rejected") bump(b, "rms_reco_rejected", row.n);
    }

    const rules = await Rule.aggregate<{ _id: string; n: number }>([
      { $match: { isActive: true } },
      { $group: { _id: "$propertyId", n: { $sum: 1 } } },
    ]);
    for (const r of rules) {
      if (!r._id) continue;
      bump(bucketFor(byProperty, r._id), "rms_rules_active", r.n);
    }

    // "Existe un doc" no es configuración: `getOrCreate` lo crea al primer
    // acceso. Se exige señal de que alguien lo tocó de verdad.
    const configs = await Config.find({}).lean();
    for (const c of configs) {
      if (!c.propertyId) continue;
      const configured =
        (c.competitors?.length ?? 0) > 0 ||
        c.minRateUsd != null ||
        (c.updatedAt && c.createdAt && +new Date(c.updatedAt) > +new Date(c.createdAt));
      bucketFor(byProperty, c.propertyId).rms_configured = configured ? 1 : 0;
    }
  } catch (err) {
    // El RMS puede no estar configurado en este entorno: el resto del rollup
    // vale igual, así que se degrada en vez de abortar el día entero.
    console.warn(
      "[metrics] RMS no disponible, se omite:",
      err instanceof Error ? err.message : err,
    );
  }
}


/**
 * Estado del alta guiada leído del MODELO, no de los eventos.
 *
 * Los eventos de onboarding sólo existen desde que se instrumentó (F1): todo
 * lo anterior — meses de altas reales y de pruebas — no dejó ni un evento.
 * Pero `companies.onboarding` viene guardando el progreso desde siempre, así
 * que la completitud y el paso donde se trabó cada hotel SÍ son recuperables.
 *
 * Qué da cada fuente, para no confundirlas:
 *  - **Estado (esto)**: cuántos completaron, en qué paso están los que no, y
 *    cuándo cerraron cada etapa. Histórico completo.
 *  - **Eventos**: tiempos por paso, abandono dentro del paso, fricción de
 *    decisión vs. esfuerzo, reanudaciones. Sólo desde que se instrumentó.
 */
async function collectOnboardingState(
  ctx: DayContext,
  byCompany: Map<string, Bucket>,
): Promise<void> {
  const conn = await getPmsConnection();
  const rows = await conn
    .collection("companies")
    .find(
      { status: { $ne: "deleted" } },
      { projection: { companyId: 1, onboarding: 1, createdAt: 1, _id: 0 } },
    )
    .toArray();

  for (const r of rows) {
    const companyId = r.companyId as string | undefined;
    if (!companyId || EXCLUDED.includes(companyId)) continue;
    const b = bucketFor(byCompany, companyId);
    const o = (r.onboarding ?? null) as Record<string, unknown> | null;

    // Sin el subdocumento no es "incompleto": es una company anterior al alta
    // guiada. Mezclarlas inflaría el abandono con casos que nunca empezaron.
    if (!o) {
      b.ob_state_unknown = 1;
      continue;
    }

    const completed = Boolean(o.completed);
    b.ob_state_completed = completed ? 1 : 0;
    b.ob_state_incomplete = completed ? 0 : 1;

    const step = typeof o.currentStep === "number" ? o.currentStep : null;
    if (step !== null) b.ob_state_step = step;
    // Histograma de dónde quedaron los que NO terminaron: es la respuesta a
    // "en qué paso se cae la gente" sin depender de la instrumentación nueva.
    if (!completed && step !== null) {
      bumpMap(b, "ob_state_stuck_hist", String(step));
    }

    const stage = typeof o.stage === "number" ? o.stage : null;
    if (stage !== null) b.ob_state_stage = stage;

    const dl = (o.dataLoading ?? {}) as Record<string, unknown>;
    b.ob_state_setup_done = o.setupCompletedAt ? 1 : 0;
    b.ob_state_data_done = o.dataLoadingCompletedAt ? 1 : 0;
    // El gatillo que el piloto prohíbe romper: sin disponibilidad inicializada
    // la propiedad figura "completa" pero no puede recibir una reserva.
    b.ob_state_availability_ok = dl.availabilityInitializedAt ? 1 : 0;
    b.ob_state_availability_err = dl.availabilityInitError ? 1 : 0;

    // Días desde la última señal de avance: separa "en curso" de "abandonado".
    const last =
      (o.dataLoadingCompletedAt as Date | undefined) ??
      (o.setupCompletedAt as Date | undefined) ??
      (r.createdAt as Date | undefined);
    if (!completed && last) {
      const days = Math.floor(
        (ctx.end.getTime() - new Date(last).getTime()) / 86400000,
      );
      if (days >= 0) b.ob_state_dormant_days = days;
    }
  }
}


/**
 * Cuentas de la plataforma: compañías, propiedades, espacios operativos y
 * usuarios del staff — stock y **altas del día**.
 *
 * Las altas SÍ son históricas: las cuatro colecciones tienen `createdAt`, así
 * que recomputar un día viejo devuelve el número real de ese día (a diferencia
 * de los stocks, que son la foto del momento del cómputo).
 *
 * El stock global de compañías se cuenta aparte porque una company no
 * pertenece a otra: sumarlo desde el scope de company daría 1 por cada una.
 */
async function collectAccounts(
  ctx: DayContext,
  byProperty: Map<string, Bucket>,
  byCompany: Map<string, Bucket>,
  global: Bucket,
): Promise<void> {
  const conn = await getPmsConnection();
  const range = { $gte: ctx.start, $lt: ctx.end };

  // ── Compañías: stock global + altas del día ──────────────────────────────
  const companiesTotal = await conn
    .collection("companies")
    .countDocuments({ status: { $ne: "deleted" } });
  global.stock_companies = companiesTotal;

  const newCompanies = await conn
    .collection("companies")
    .find({ createdAt: range }, { projection: { companyId: 1, _id: 0 } })
    .toArray();
  bump(global, "companies_new", newCompanies.length);
  for (const c of newCompanies) {
    const companyId = c.companyId as string | undefined;
    if (companyId && !EXCLUDED.includes(companyId)) {
      bucketFor(byCompany, companyId).company_created = 1;
    }
  }

  // ── Propiedades, espacios, usuarios y unidades ───────────────────────────
  // Mismo patrón para las cuatro: stock por compañía + altas del día.
  const perCompany = async (
    collection: string,
    stockField: string,
    newField: string,
    match: Record<string, unknown> = {},
  ): Promise<void> => {
    const stock = await conn
      .collection(collection)
      .aggregate<{ _id: string; n: number }>([
        { $match: match },
        { $group: { _id: "$companyId", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const r of stock) {
      if (!r._id) continue;
      bucketFor(byCompany, r._id)[stockField] = r.n;
    }

    const created = await conn
      .collection(collection)
      .aggregate<{ _id: string; n: number }>([
        { $match: { ...match, createdAt: range } },
        { $group: { _id: "$companyId", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const r of created) {
      if (!r._id) continue;
      bump(bucketFor(byCompany, r._id), newField, r.n);
    }
  };

  // Los espacios de administración se excluyen del conteo: ven el catálogo
  // completo sin configurarse, así que no representan un puesto de trabajo real.
  await perCompany("operativespaces", "stock_spaces", "spaces_new", {
    isAdminSpace: { $ne: true },
  });
  await perCompany("users", "stock_users_staff", "users_new");
  await perCompany("units", "stock_units", "units_new");
  await perCompany("properties", "stock_properties_by_company", "properties_new");

  // Los totales globales se cuentan directo contra la base y NO se dejan al
  // plegado: este recolector corre después de armar el global (necesita que el
  // stock de compañías sea un conteo propio), así que lo que escriba en los
  // buckets de company ya no llega arriba.
  //
  // El campo de altas se nombra explicito y NO se deriva del de stock: hacerlo
  // con `field.replace("stock_", "") + "_new"` daba `users_staff_new` para el
  // stock `stock_users_staff`, una clave que el schema no tiene y que mongoose
  // descartaba en silencio. El resultado era un `users_new` global siempre en
  // 0 mientras el scope de company lo contaba bien.
  for (const [collection, stockField, newField, match] of [
    ["operativespaces", "stock_spaces", "spaces_new", { isAdminSpace: { $ne: true } }],
    ["users", "stock_users_staff", "users_new", {}],
    ["units", "stock_units", "units_new", {}],
    ["properties", "stock_properties", "properties_new", {}],
  ] as const) {
    global[stockField] = await conn.collection(collection).countDocuments(match);
    global[newField] = await conn
      .collection(collection)
      .countDocuments({ ...match, createdAt: range });
  }

  // Unidades y espacios también por propiedad, para la tabla del piloto.
  for (const [collection, field] of [
    ["units", "stock_units"],
    ["operativespaces", "stock_spaces"],
  ] as const) {
    const rows = await conn
      .collection(collection)
      .aggregate<{ _id: string; n: number }>([
        {
          $match:
            collection === "operativespaces"
              ? { isAdminSpace: { $ne: true } }
              : {},
        },
        { $group: { _id: "$propertyId", n: { $sum: 1 } } },
      ])
      .toArray();
    for (const r of rows) {
      if (!r._id) continue;
      bucketFor(byProperty, r._id)[field] = r.n;
    }
  }
}

// ── Orquestación ──────────────────────────────────────────────────────────

/** Recomputa y persiste un día completo. */
export async function computeDay(day: string): Promise<number> {
  const { start, end } = dayBounds(day);

  const [Company, Property] = await Promise.all([
    getCompanyModel(),
    getPropertyModel(),
  ]);
  const companies = await Company.find({ status: { $ne: "deleted" } })
    .select({ companyId: 1 })
    .lean();
  const properties = await Property.find({})
    .select({ propertyId: 1, companyId: 1 })
    .lean();

  const companyByProperty = new Map<string, string>();
  for (const p of properties) {
    if (p.propertyId && p.companyId) companyByProperty.set(p.propertyId, p.companyId);
  }
  const companyIds = companies
    .map((c) => c.companyId)
    .filter((id): id is string => Boolean(id) && !EXCLUDED.includes(id));

  const ctx: DayContext = { day, start, end, companyByProperty, companyIds };
  const byProperty = new Map<string, Bucket>();
  const byCompany = new Map<string, Bucket>();

  // Se siembran TODAS las compañías y propiedades vivas antes de recolectar, no
  // sólo las que tuvieron actividad. Sin esto, una compañía sin uso no genera
  // ningún bucket y desaparece del tablero — y para el piloto esa es justo la
  // fila que hay que mirar: el hotel que se dio de alta y no volvió. Un cero
  // explícito y una ausencia significan cosas muy distintas.
  for (const companyId of companyIds) bucketFor(byCompany, companyId);
  for (const [propertyId, companyId] of companyByProperty) {
    if (!EXCLUDED.includes(companyId)) bucketFor(byProperty, propertyId);
  }

  await collectReservations(ctx, byProperty);
  await collectSearches(ctx, byProperty);
  await collectAnalyticsEvents(ctx, byProperty, byCompany);
  await collectLinkhubAndSites(ctx, byProperty, byCompany);
  await collectStocks(ctx, byProperty, byCompany);
  await collectIa(ctx, byCompany);
  await collectOnboardingState(ctx, byCompany);
  await collectRms(ctx, byProperty);

  // Los buckets de propiedad se suman a su compañía; los porcentajes NO se
  // suman (se recalculan sobre los totales ya agregados).
  const RATIO_FIELDS = new Set([
    "res_engine_share_pct",
    "res_time_to_confirm_p50_min",
    "funnel_conversion_pct",
    "ia_tool_error_pct",
    "stock_review_score",
    "rms_occupancy_pct",
    "rms_adr_usd",
    "rms_revpar_usd",
    "activity_score",
    "rms_configured",
  ]);

  for (const [propertyId, b] of byProperty) {
    const companyId = companyByProperty.get(propertyId);
    if (!companyId || EXCLUDED.includes(companyId)) continue;
    const cb = bucketFor(byCompany, companyId);
    for (const [k, v] of Object.entries(b)) {
      if (RATIO_FIELDS.has(k)) continue;
      if (typeof v === "number") bump(cb, k, v);
      else if (v && typeof v === "object") {
        for (const [sub, n] of Object.entries(v)) bumpMap(cb, k, sub, n);
      }
    }
  }

  /**
   * Métricas cuyo total global NO es la suma de las compañías, porque la
   * entidad puede pertenecer a varias. `guests` es compartida entre todos los
   * hoteles: un huésped en 3 compañías cuenta 3 veces si se suma, y "usuarios
   * registrados en la plataforma" quedaría inflado. Se cuenta distinct.
   */
  const globalOverrides: Record<string, number> = {};
  try {
    const Guest = await getGuestModel();
    globalOverrides.sp_guests_stock = await Guest.countDocuments({
      status: { $ne: "deleted" },
      originCompanyIds: { $exists: true, $ne: [] },
    });
  } catch {
    /* si falla, el global cae a la suma (inflado pero no vacío) */
  }

  const global = emptyBucket();
  for (const [companyId, b] of byCompany) {
    if (EXCLUDED.includes(companyId)) continue;
    for (const [k, v] of Object.entries(b)) {
      if (RATIO_FIELDS.has(k)) continue;
      if (typeof v === "number") bump(global, k, v);
      else if (v && typeof v === "object") {
        for (const [sub, n] of Object.entries(v)) bumpMap(global, k, sub, n);
      }
    }
  }

  // Las cuentas se recolectan DESPUÉS del plegado company→global: el stock de
  // compañías es un conteo propio del scope global, no la suma de las filas.
  await collectAccounts(ctx, byProperty, byCompany, global);

  Object.assign(global, globalOverrides);

  // Ratios recalculados sobre los agregados.
  for (const b of [...byCompany.values(), global]) {
    const engine = (b.res_engine_created as number) ?? 0;
    const staff = (b.res_staff_created as number) ?? 0;
    b.res_engine_share_pct = pct(engine, engine + staff);
    b.funnel_conversion_pct = pct(
      (b.funnel_created as number) ?? 0,
      (b.funnel_search as number) ?? 0,
    );
  }

  // Se tipa laxo a propósito: los buckets son mapas dinámicos de contadores y
  // el tipo inferido del schema no los acepta sin castear campo por campo.
  const ops: Parameters<typeof MetricsDaily.bulkWrite>[0] = [];
  for (const [propertyId, b] of byProperty) {
    const companyId = companyByProperty.get(propertyId);
    if (!companyId || EXCLUDED.includes(companyId)) continue;
    ops.push({
      updateOne: {
        filter: { day, scope: "property", companyId, propertyId },
        update: { $set: { ...b, day, scope: "property", companyId, propertyId, computedAt: new Date() } },
        upsert: true,
      },
    });
  }
  for (const [companyId, b] of byCompany) {
    if (EXCLUDED.includes(companyId)) continue;
    ops.push({
      updateOne: {
        filter: { day, scope: "company", companyId, propertyId: null },
        update: { $set: { ...b, day, scope: "company", companyId, propertyId: null, computedAt: new Date() } },
        upsert: true,
      },
    });
  }
  ops.push({
    updateOne: {
      filter: { day, scope: "global", companyId: null, propertyId: null },
      update: { $set: { ...global, day, scope: "global", companyId: null, propertyId: null, computedAt: new Date() } },
      upsert: true,
    },
  });

  for (let i = 0; i < ops.length; i += 500) {
    await MetricsDaily.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  return ops.length;
}

/**
 * Ventana de recómputo: los últimos N días completos más el corriente. Que sea
 * una ventana y no sólo "ayer" es lo que permite recuperarse de una caída sin
 * que nadie intervenga (mismo criterio que el ingest del RMS).
 */
export async function runRollup(options: { days?: number; day?: string } = {}): Promise<{
  days: string[];
  docs: number;
}> {
  const started = Date.now();
  const days: string[] = [];

  if (options.day) {
    days.push(options.day);
  } else {
    const window = options.days ?? 7;
    for (let i = window; i >= 0; i--) {
      days.push(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    }
  }

  let docs = 0;
  try {
    for (const day of days) {
      docs += await computeDay(day);
      // Las métricas por app se recomputan con la misma ventana: si se
      // desincronizan, el tablero por hub contradice al general.
      docs += await computeAppDay(day);
    }
    await MetricsJobState.updateOne(
      { jobId: "metrics_daily" },
      {
        $set: {
          lastRunAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
          lastDurationMs: Date.now() - started,
          daysComputed: days.length,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    await MetricsJobState.updateOne(
      { jobId: "metrics_daily" },
      {
        $set: {
          lastRunAt: new Date(),
          lastError: err instanceof Error ? err.message : String(err),
          lastDurationMs: Date.now() - started,
        },
      },
      { upsert: true },
    );
    throw err;
  }

  return { days, docs };
}
