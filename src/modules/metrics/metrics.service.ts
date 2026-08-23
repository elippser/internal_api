import { MetricsDaily, MetricsJobState } from "./metrics.model";
import { getCompanyModel } from "../hotels/pmsModels";
import { getPmsConnection } from "../../shared/pmsDb";
import { analyticsService } from "../analytics/analytics.service";
import { ImprovementTicket } from "../tickets/tickets.model";
import { FeedbackRequest } from "../feedback/feedback.model";
import {
  ConversationMessage,
  ConversationSession,
} from "../conversations/conversations.model";
import { UsageRecord } from "../usage/usage.model";

/**
 * Lectura de métricas consolidadas. Todo sale de `metrics_daily` (el rollup);
 * este servicio sólo filtra, suma rangos y arma las vistas.
 *
 * Ver METRICAS-COMPORTAMIENTO-SPEC.md §11.
 */

export interface MetricsQuery {
  dateFrom?: string;
  dateTo?: string;
  companyId?: string;
  propertyId?: string;
}

/** Campos que NO se suman al agregar un rango (son ratios o fotos). */
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
]);

/** Stocks: del rango vale el ÚLTIMO valor, no la suma (si no, se multiplican). */
const STOCK_FIELDS = new Set([
  // Estado del alta: es una foto del modelo, no actividad. Sumarlo por rango
  // multiplicaría cada company por la cantidad de días.
  "ob_state_completed",
  "ob_state_incomplete",
  "ob_state_unknown",
  "ob_state_step",
  "ob_state_stage",
  "ob_state_setup_done",
  "ob_state_data_done",
  "ob_state_availability_ok",
  "ob_state_availability_err",
  "ob_state_dormant_days",
  "web_sites_total",
  "web_sites_published",
  "sp_guests_stock",
  "sp_registered_auth0",
  "stock_companies",
  "stock_spaces",
  "stock_properties_by_company",
  "stock_properties",
  "stock_units",
  "stock_users_staff",
  "stock_apps_enabled",
  "stock_reviews",
  "rms_configured",
  "rms_rules_active",
]);

/**
 * Mapas que son FOTO, no actividad: se toma el último día del rango en vez de
 * sumarlos. `ob_state_stuck_hist` es el caso: describe dónde está trabada cada
 * company HOY, así que sumarlo por 30 días multiplicaría por 30 a los mismos
 * hoteles y el histograma no cerraría contra el total de incompletos.
 */
const STOCK_MAP_FIELDS = new Set(["ob_state_stuck_hist"]);

/**
 * Resuelve nombres de usuario contra la base del PMS. Devuelve un mapa vacío
 * si algo falla: un nombre faltante degrada la tabla a mostrar el id, que sigue
 * siendo útil; abortar la vista entera por esto no lo sería.
 */
async function resolveUserNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return out;
  try {
    const conn = await getPmsConnection();
    const rows = await conn
      .collection("users")
      .find({ userId: { $in: ids } }, { projection: { userId: 1, name: 1, email: 1 } })
      .toArray();
    for (const r of rows) {
      const label = (r.name as string) || (r.email as string) || "";
      if (r.userId && label) out.set(r.userId as string, label);
    }
  } catch (err) {
    console.warn("[metrics] no se pudieron resolver nombres de usuario:", err);
  }
  return out;
}

/** Ídem para compañías. */
async function resolveCompanyNames(
  companyIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(companyIds)];
  if (!ids.length) return out;
  try {
    const Company = await getCompanyModel();
    const rows = await Company.find({ companyId: { $in: ids } })
      .select({ companyId: 1, name: 1 })
      .lean();
    for (const r of rows) if (r.companyId && r.name) out.set(r.companyId, r.name);
  } catch (err) {
    console.warn("[metrics] no se pudieron resolver nombres de compañía:", err);
  }
  return out;
}

function defaultRange(q: MetricsQuery): { from: string; to: string } {
  const to = q.dateTo ?? new Date().toISOString().slice(0, 10);
  const from =
    q.dateFrom ??
    new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from, to };
}

function scopeFilter(q: MetricsQuery): Record<string, unknown> {
  if (q.propertyId) return { scope: "property", propertyId: q.propertyId };
  if (q.companyId) return { scope: "company", companyId: q.companyId };
  return { scope: "global" };
}

type Row = Record<string, unknown>;

/**
 * Colapsa una serie diaria en un solo objeto: suma los contadores, toma el
 * último valor de los stocks y recalcula los ratios sobre los totales (nunca
 * promedia porcentajes, que es la forma clásica de mentir con estos números).
 */
function foldRange(rows: Row[]): Row {
  const out: Row = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (["_id", "day", "scope", "companyId", "propertyId", "computedAt"].includes(k))
        continue;
      if (RATIO_FIELDS.has(k)) continue;
      if (STOCK_FIELDS.has(k)) {
        if (typeof v === "number") out[k] = v; // último gana (rows vienen ordenados)
        continue;
      }
      if (typeof v === "number") {
        out[k] = ((out[k] as number) ?? 0) + v;
      } else if (v && typeof v === "object") {
        if (STOCK_MAP_FIELDS.has(k)) {
          // Último gana: las filas vienen ordenadas por día ascendente.
          out[k] = { ...(v as Record<string, number>) };
          continue;
        }
        const acc = (out[k] as Record<string, number>) ?? {};
        for (const [sub, n] of Object.entries(v as Record<string, number>)) {
          acc[sub] = (acc[sub] ?? 0) + (n ?? 0);
        }
        out[k] = acc;
      }
    }
  }

  const engine = (out.res_engine_created as number) ?? 0;
  const staff = (out.res_staff_created as number) ?? 0;
  out.res_engine_share_pct =
    engine + staff ? Math.round((engine / (engine + staff)) * 10000) / 100 : null;

  const search = (out.funnel_search as number) ?? 0;
  out.funnel_conversion_pct = search
    ? Math.round((((out.funnel_created as number) ?? 0) / search) * 10000) / 100
    : null;

  return out;
}

async function seriesFor(q: MetricsQuery): Promise<{ rows: Row[]; range: { from: string; to: string } }> {
  const range = defaultRange(q);
  const rows = await MetricsDaily.find({
    ...scopeFilter(q),
    day: { $gte: range.from, $lte: range.to },
  })
    .sort({ day: 1 })
    .lean();
  return { rows: rows as Row[], range };
}

export const metricsService = {
  async overview(q: MetricsQuery) {
    const { rows, range } = await seriesFor(q);
    return {
      range,
      totals: foldRange(rows),
      series: rows.map((r) => ({
        day: r.day,
        res_engine_created: r.res_engine_created ?? 0,
        res_staff_created: r.res_staff_created ?? 0,
        res_agent_created: r.res_agent_created ?? 0,
        funnel_search: r.funnel_search ?? 0,
        funnel_created: r.funnel_created ?? 0,
        web_views: r.web_views ?? 0,
        lh_views: r.lh_views ?? 0,
        pms_dau: r.pms_dau ?? 0,
        ia_sessions: r.ia_sessions ?? 0,
      })),
    };
  },

  /**
   * La tabla del checkpoint del piloto: una fila por propiedad con lo que el
   * tracker del concepto pide y el sistema puede computar solo.
   */
  async pilot(q: MetricsQuery) {
    const range = defaultRange(q);
    const rows = (await MetricsDaily.find({
      scope: "property",
      day: { $gte: range.from, $lte: range.to },
      ...(q.companyId ? { companyId: q.companyId } : {}),
    })
      .sort({ day: 1 })
      .lean()) as Row[];

    const byProperty = new Map<string, Row[]>();
    for (const r of rows) {
      const key = String(r.propertyId);
      byProperty.set(key, [...(byProperty.get(key) ?? []), r]);
    }

    const Company = await getCompanyModel();
    const companies = await Company.find({}).select({ companyId: 1, name: 1 }).lean();
    const companyName = new Map(companies.map((c) => [c.companyId, c.name]));

    const properties = [...byProperty.entries()].map(([propertyId, series]) => {
      const folded = foldRange(series);
      const companyId = String(series[0]?.companyId ?? "");
      return {
        propertyId,
        companyId,
        companyName: companyName.get(companyId) ?? null,
        engineReservations: folded.res_engine_created ?? 0,
        staffReservations: folded.res_staff_created ?? 0,
        agentReservations: folded.res_agent_created ?? 0,
        engineSharePct: folded.res_engine_share_pct ?? null,
        bySource: folded.res_by_source ?? {},
        searches: folded.searches_total ?? 0,
        searchesNoAvail: folded.searches_no_avail ?? 0,
        funnelConversionPct: folded.funnel_conversion_pct ?? null,
        sitesPublished: folded.web_sites_published ?? 0,
        whatsappClicks: folded.web_wa_clicks ?? 0,
        linkhubClicks: folded.lh_clicks ?? 0,
        linkhubBookingClicks: folded.lh_booking_clicks ?? 0,
        appsEnabled: folded.stock_apps_enabled ?? 0,
        rmsConfigured: Boolean(folded.rms_configured),
      };
    });

    // Peor share primero: son las propiedades donde el hábito no cambió, que
    // es exactamente lo que el piloto necesita mirar.
    properties.sort((a, b) => {
      // Sin reservas no hay share: van al final, no al principio (un null no
      // es "0% de motor", es "todavía no hay nada que medir").
      const sa = typeof a.engineSharePct === "number" ? a.engineSharePct : 999;
      const sb = typeof b.engineSharePct === "number" ? b.engineSharePct : 999;
      return sa - sb;
    });

    return { range, properties };
  },

  async section(section: "onboarding" | "adoption" | "ia" | "engine" | "web", q: MetricsQuery) {
    const { rows, range } = await seriesFor(q);
    const totals = foldRange(rows);
    return { range, section, totals, series: rows };
  },

  /**
   * Ranking de features pedidas ponderado por uso real (§13 del spec).
   *
   * Con el producto gratis, pedir una feature es barato: contar menciones
   * sueltas premia al que más habla, no al que más usa. Se pondera por el
   * `activity_score` de las compañías que la pidieron.
   */
  async featureDemand(q: MetricsQuery) {
    const range = defaultRange(q);

    const companyRows = (await MetricsDaily.find({
      scope: "company",
      day: { $gte: range.from, $lte: range.to },
    })
      .sort({ day: 1 })
      .lean()) as Row[];

    const scoreByCompany = new Map<string, number>();
    const byCompany = new Map<string, Row[]>();
    for (const r of companyRows) {
      const key = String(r.companyId);
      byCompany.set(key, [...(byCompany.get(key) ?? []), r]);
    }

    // Percentil 90 de cada señal, para que un outlier no aplaste al resto.
    const folded = [...byCompany.entries()].map(([companyId, series]) => ({
      companyId,
      f: foldRange(series),
    }));
    const p90 = (key: string): number => {
      const values = folded
        .map((x) => (x.f[key] as number) ?? 0)
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
      if (!values.length) return 1;
      return values[Math.floor(values.length * 0.9)] ?? values[values.length - 1];
    };
    const p90Engine = p90("res_engine_created");
    const p90Dau = p90("pms_dau");
    const p90Ia = p90("ia_sessions");

    const norm = (v: number, ref: number) => Math.min(v / (ref || 1), 1);

    for (const { companyId, f } of folded) {
      const apps = Object.keys((f.pms_app_opens as Record<string, number>) ?? {}).length;
      const score =
        40 * norm((f.res_engine_created as number) ?? 0, p90Engine) +
        20 * norm((f.pms_dau as number) ?? 0, p90Dau) +
        15 * norm(apps, 6) +
        15 * norm((f.ia_sessions as number) ?? 0, p90Ia) +
        10 * (((f.web_sites_published as number) ?? 0) > 0 ? 1 : 0);
      scoreByCompany.set(companyId, Math.round(score));
    }

    const tickets = await ImprovementTicket.find({
      status: { $in: ["open", "in_progress"] },
    })
      .sort({ priorityScore: -1 })
      .limit(50)
      .lean();

    const ranked = await Promise.all(
      tickets.map(async (t) => {
        const feedbacks = await FeedbackRequest.find({
          feedbackId: { $in: t.linkedFeedbackIds ?? [] },
        })
          .select({ companyId: 1 })
          .lean();
        const scores = feedbacks
          .map((f) => scoreByCompany.get(String(f.companyId)))
          .filter((n): n is number => typeof n === "number");
        const avgActivity = scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0;
        return {
          ticketId: t.ticketId,
          title: t.title,
          type: t.type,
          priority: t.priority,
          priorityScore: t.priorityScore ?? 0,
          requestCount: t.impact?.requestCount ?? 0,
          uniqueCompanies: t.impact?.uniqueCompanies ?? 0,
          avgActivityScore: avgActivity,
          weightedScore:
            Math.round(((t.priorityScore ?? 0) * avgActivity) / 100),
        };
      }),
    );

    ranked.sort((a, b) => b.weightedScore - a.weightedScore);

    return {
      range,
      // Se devuelven las dos columnas a propósito: el criterio de ponderación
      // tiene que ser visible, no una caja negra.
      tickets: ranked,
      companyScores: [...scoreByCompany.entries()]
        .map(([companyId, score]) => ({ companyId, score }))
        .sort((a, b) => b.score - a.score),
    };
  },

  /**
   * Sesiones de Bookfer IA con sus métricas por conversación.
   *
   * El módulo `/conversations` ya permite auditar una conversación suelta, pero
   * no responde las preguntas del piloto: quién usa el agente, cuánto, qué
   * herramientas dispara y si las respuestas sirvieron. Eso último sólo se ve
   * agregando el 👍/👎 por sesión, que es justo lo que no estaba a la vista en
   * ningún lado.
   */
  async iaSessions(
    q: MetricsQuery & { page?: number; limit?: number; onlyWithFeedback?: boolean },
  ) {
    const range = defaultRange(q);
    const from = new Date(`${range.from}T00:00:00.000Z`);
    const to = new Date(`${range.to}T23:59:59.999Z`);

    const filter: Record<string, unknown> = {
      startedAt: { $gte: from, $lte: to },
    };
    if (q.companyId) filter["context.companyId"] = q.companyId;
    if (q.propertyId) filter["context.propertyId"] = q.propertyId;

    // "Sólo con valoración" tiene que entrar en la QUERY, no filtrar la página
    // ya traída: si no, `total` cuenta todas las sesiones y la paginación
    // devuelve páginas de tamaño irregular (o vacías) según dónde caigan las
    // votadas. El voto vive en los mensajes, así que primero se resuelve qué
    // sesiones tienen alguno.
    if (q.onlyWithFeedback) {
      const rated = await ConversationMessage.distinct("sessionId", {
        "feedback.rating": { $exists: true },
      });
      filter.sessionId = { $in: rated };
    }

    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const page = Math.max(q.page ?? 1, 1);

    const [sessions, total] = await Promise.all([
      ConversationSession.find(filter)
        .sort({ lastActivityAt: -1, startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ConversationSession.countDocuments(filter),
    ]);

    const sessionIds = sessions.map((s) => s.sessionId).filter(Boolean) as string[];

    // Un solo barrido de mensajes para todas las sesiones de la página: los
    // votos y las herramientas viven embebidos en `agentMeta`, así que no hay
    // forma de contarlos sin abrir los mensajes.
    const perSession = new Map<
      string,
      { toolCalls: number; toolErrors: number; up: number; down: number }
    >();
    if (sessionIds.length) {
      const rows = await ConversationMessage.aggregate<{
        _id: string;
        toolCalls: number;
        toolErrors: number;
        up: number;
        down: number;
      }>([
        { $match: { sessionId: { $in: sessionIds }, role: "assistant" } },
        {
          $project: {
            sessionId: 1,
            tools: { $ifNull: ["$agentMeta.toolsExecuted", []] },
            rating: "$feedback.rating",
          },
        },
        {
          $group: {
            _id: "$sessionId",
            toolCalls: { $sum: { $size: "$tools" } },
            toolErrors: {
              $sum: {
                $size: {
                  $filter: {
                    input: "$tools",
                    as: "t",
                    cond: { $eq: ["$$t.outcome", "error"] },
                  },
                },
              },
            },
            up: { $sum: { $cond: [{ $eq: ["$rating", "up"] }, 1, 0] } },
            down: { $sum: { $cond: [{ $eq: ["$rating", "down"] }, 1, 0] } },
          },
        },
      ]);
      for (const r of rows) perSession.set(r._id, r);
    }

    // Costo: se reusa el ledger de consumo, no se recalcula desde tokens.
    const costBySession = new Map<string, number>();
    if (sessionIds.length) {
      const rows = await UsageRecord.aggregate<{ _id: string; cost: number }>([
        { $match: { sessionId: { $in: sessionIds } } },
        { $group: { _id: "$sessionId", cost: { $sum: "$costUsd" } } },
      ]);
      for (const r of rows) costBySession.set(r._id, r.cost ?? 0);
    }

    // El contexto de la sesión guarda los nombres sólo si el PMS los mandó al
    // crearla, y en la práctica suele venir sólo el id. Se resuelven contra la
    // base del PMS para que la tabla sea legible ("quién y de qué hotel"), que
    // es la pregunta que esta vista tiene que responder.
    const [nameByUser, nameByCompany] = await Promise.all([
      resolveUserNames(
        sessions.map((s) => s.context?.userId).filter((x): x is string => Boolean(x)),
      ),
      resolveCompanyNames(
        sessions
          .map((s) => s.context?.companyId)
          .filter((x): x is string => Boolean(x)),
      ),
    ]);

    const data = sessions.map((s) => {
      const agg = perSession.get(s.sessionId) ?? {
        toolCalls: 0,
        toolErrors: 0,
        up: 0,
        down: 0,
      };
      const started = s.startedAt ? new Date(s.startedAt).getTime() : null;
      const last = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : null;
      return {
        sessionId: s.sessionId,
        title: s.title ?? null,
        status: s.status,
        channel: s.context?.channel ?? null,
        userId: s.context?.userId ?? null,
        userName:
          s.context?.userName ??
          (s.context?.userId ? nameByUser.get(s.context.userId) ?? null : null),
        userRole: s.context?.userRole ?? null,
        companyId: s.context?.companyId ?? null,
        companyName:
          s.context?.companyName ??
          (s.context?.companyId
            ? nameByCompany.get(s.context.companyId) ?? null
            : null),
        propertyName: s.context?.propertyName ?? null,
        spaceName: s.context?.operativeSpaceName ?? null,
        turnCount: s.turnCount ?? 0,
        startedAt: s.startedAt ?? null,
        lastActivityAt: s.lastActivityAt ?? null,
        durationMin:
          started && last ? Math.max(0, Math.round((last - started) / 60000)) : null,
        toolCalls: agg.toolCalls,
        toolErrors: agg.toolErrors,
        feedbackUp: agg.up,
        feedbackDown: agg.down,
        feedbackRequestIds: s.feedbackRequestIds ?? [],
        costUsd: Math.round((costBySession.get(s.sessionId) ?? 0) * 1e6) / 1e6,
      };
    });

    // El filtro ya se aplicó en la query, así que `total` y `data` hablan del
    // mismo universo y la paginación es consistente.
    return { range, page, limit, total, data };
  },

  /** Transcripción de una sesión, con el voto de cada respuesta. */
  async iaSessionDetail(sessionId: string) {
    const session = await ConversationSession.findOne({ sessionId }).lean();
    if (!session) return null;

    const messages = await ConversationMessage.find({ sessionId })
      .sort({ createdAt: 1 })
      .lean();

    // Mismo enriquecimiento que el listado: sin esto, abrir una sesión por
    // deep-link mostraba ids crudos donde la tabla mostraba nombres.
    const [nameByUser, nameByCompany] = await Promise.all([
      resolveUserNames(session.context?.userId ? [session.context.userId] : []),
      resolveCompanyNames(
        session.context?.companyId ? [session.context.companyId] : [],
      ),
    ]);

    return {
      session: {
        sessionId: session.sessionId,
        title: session.title ?? null,
        status: session.status,
        channel: session.context?.channel ?? null,
        userId: session.context?.userId ?? null,
        userName:
          session.context?.userName ??
          (session.context?.userId
            ? nameByUser.get(session.context.userId) ?? null
            : null),
        userRole: session.context?.userRole ?? null,
        companyId: session.context?.companyId ?? null,
        companyName:
          session.context?.companyName ??
          (session.context?.companyId
            ? nameByCompany.get(session.context.companyId) ?? null
            : null),
        propertyName: session.context?.propertyName ?? null,
        spaceName: session.context?.operativeSpaceName ?? null,
        turnCount: session.turnCount ?? 0,
        startedAt: session.startedAt ?? null,
        lastActivityAt: session.lastActivityAt ?? null,
      },
      messages: messages.map((m) => {
        const tools = (m.agentMeta?.toolsExecuted ?? []) as Array<{
          toolName?: string;
          outcome?: string;
          durationMs?: number;
        }>;
        return {
          messageId: m.messageId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt ?? null,
          // El voto es el dato que el piloto quiere leer: se expone en la
          // transcripción para poder ver QUÉ respuesta se votó mal, no sólo
          // cuántas.
          feedback: m.feedback?.rating ?? null,
          feedbackComment: m.feedback?.comment || null,
          feedbackAt: m.feedback?.at ?? null,
          model: m.agentMeta?.modelUsed ?? null,
          latencyMs: m.agentMeta?.latencyMs ?? null,
          tools: tools.map((t) => ({
            toolName: t.toolName ?? "",
            outcome: t.outcome ?? "",
            durationMs: t.durationMs ?? null,
          })),
        };
      }),
    };
  },

  /**
   * Cuentas de la plataforma: quién se dio de alta y qué armó.
   *
   * Responde "cuántas cuentas nuevas hay" con el detalle por compañía: sus
   * propiedades, espacios operativos y usuarios. Las **altas** son históricas
   * (salen de `createdAt`); los **stocks** son la foto de hoy.
   */
  async accounts(q: MetricsQuery) {
    const { rows, range } = await seriesFor(q);
    const totals = foldRange(rows);

    // Detalle por compañía: se lee el último día de cada una dentro del rango,
    // que es su foto vigente, más las altas acumuladas del período.
    const companyRows = (await MetricsDaily.find({
      scope: "company",
      day: { $gte: range.from, $lte: range.to },
      ...(q.companyId ? { companyId: q.companyId } : {}),
    })
      .sort({ day: 1 })
      .lean()) as Row[];

    const byCompany = new Map<string, Row[]>();
    for (const r of companyRows) {
      const key = String(r.companyId);
      byCompany.set(key, [...(byCompany.get(key) ?? []), r]);
    }

    const names = await resolveCompanyNames([...byCompany.keys()]);
    const Company = await getCompanyModel();
    const meta = await Company.find({ companyId: { $in: [...byCompany.keys()] } })
      .select({ companyId: 1, plan: 1, planStatus: 1, status: 1, createdAt: 1 })
      .lean();
    const metaById = new Map(meta.map((m) => [m.companyId, m]));

    const companies = [...byCompany.entries()].map(([companyId, series]) => {
      const f = foldRange(series);
      const m = metaById.get(companyId);
      return {
        companyId,
        name: names.get(companyId) ?? null,
        plan: m?.plan ?? null,
        planStatus: m?.planStatus ?? null,
        status: m?.status ?? null,
        createdAt: m?.createdAt ?? null,
        properties: f.stock_properties_by_company ?? 0,
        spaces: f.stock_spaces ?? 0,
        users: f.stock_users_staff ?? 0,
        units: f.stock_units ?? 0,
        appsEnabled: f.stock_apps_enabled ?? 0,
        // Altas dentro del rango consultado.
        propertiesNew: f.properties_new ?? 0,
        spacesNew: f.spaces_new ?? 0,
        usersNew: f.users_new ?? 0,
        unitsNew: f.units_new ?? 0,
        isNew: Number(f.company_created ?? 0) > 0,
        // Estado del alta guiada, que es lo que dice si la cuenta arrancó.
        onboardingCompleted: Number(f.ob_state_completed ?? 0) > 0,
        onboardingStep: f.ob_state_step ?? null,
        dormantDays: f.ob_state_dormant_days ?? null,
      };
    });

    // Las cuentas nuevas primero: son las que hay que mirar en un piloto.
    companies.sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      // Los campos vienen del rollup como `unknown`: se normalizan a número
      // para ordenar, en vez de castear a ciegas.
      const ua = typeof a.users === "number" ? a.users : 0;
      const ub = typeof b.users === "number" ? b.users : 0;
      return ub - ua;
    });

    return {
      range,
      totals: {
        companies: totals.stock_companies ?? 0,
        companiesNew: totals.companies_new ?? 0,
        properties: totals.stock_properties ?? 0,
        propertiesNew: totals.properties_new ?? 0,
        spaces: totals.stock_spaces ?? 0,
        spacesNew: totals.spaces_new ?? 0,
        users: totals.stock_users_staff ?? 0,
        usersNew: totals.users_new ?? 0,
        units: totals.stock_units ?? 0,
        unitsNew: totals.units_new ?? 0,
        onboardingCompleted: totals.ob_state_completed ?? 0,
        onboardingIncomplete: totals.ob_state_incomplete ?? 0,
      },
      /** Serie de altas por día: esto SÍ es histórico real. */
      series: rows.map((r) => ({
        day: r.day,
        companiesNew: r.companies_new ?? 0,
        propertiesNew: r.properties_new ?? 0,
        spacesNew: r.spaces_new ?? 0,
        usersNew: r.users_new ?? 0,
      })),
      companies,
    };
  },

  /** Salud: frescura del rollup + descartes de la ingesta. */
  async health() {
    const [job, latest, ingest] = await Promise.all([
      MetricsJobState.findOne({ jobId: "metrics_daily" }).lean(),
      MetricsDaily.findOne({ scope: "global" }).sort({ day: -1 }).lean(),
      Promise.resolve(analyticsService.ingestHealth()),
    ]);

    const lastDay = latest?.day ?? null;
    const staleDays = lastDay
      ? Math.floor(
          (Date.now() - new Date(`${lastDay}T00:00:00Z`).getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : null;

    return {
      rollup: {
        lastRunAt: job?.lastRunAt ?? null,
        lastSuccessAt: job?.lastSuccessAt ?? null,
        lastError: job?.lastError ?? null,
        lastDurationMs: job?.lastDurationMs ?? null,
        lastDayComputed: lastDay,
        staleDays,
      },
      ingest,
    };
  },
};
