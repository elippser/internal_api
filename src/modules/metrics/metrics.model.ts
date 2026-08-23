import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Rollup diario de métricas de comportamiento. Un doc por
 * `{day, scope, companyId?, propertyId?}`.
 *
 * Existe por tres razones, y ninguna es performance:
 *
 * 1. **Los crudos expiran.** El sink de eventos de reserva tiene TTL de 90
 *    días, las notificaciones 30, los eventos de analítica 365 y los de
 *    LinkHub/sitios 400. Sin consolidar a diario, la serie histórica del
 *    piloto se borra sola.
 * 2. **Los stocks no están fechados.** Cuántos sitios publicados o cuántos
 *    huéspedes registrados había *en una fecha* no se puede reconstruir desde
 *    los modelos (varios no tienen timestamps). La foto diaria ES el dato.
 * 3. **Las fuentes viven en tres bases distintas** y no se pueden cruzar con
 *    `$lookup`; el cruce se hace acá una vez por día, no en cada request.
 *
 * Los campos ausentes valen 0. Ver METRICAS-COMPORTAMIENTO-SPEC.md §10.
 */

const num = { type: Number, default: 0 };

const metricsDailySchema = new Schema(
  {
    /** Día civil UTC "YYYY-MM-DD" (convención de toda la plataforma). */
    day: { type: String, required: true, index: true },
    scope: {
      type: String,
      enum: ["global", "company", "property"],
      required: true,
    },
    companyId: { type: String, default: null },
    propertyId: { type: String, default: null },

    // ── Reservas · la métrica principal del piloto ───────────────────────
    res_engine_created: num,
    res_staff_created: num,
    res_agent_created: num,
    /** engine / (engine + staff). El agente se reporta aparte a propósito. */
    res_engine_share_pct: { type: Number, default: null },
    res_confirmed: num,
    res_cancelled: num,
    res_noshow: num,
    res_nights: num,
    res_amount_base: num,
    /** Mediana de minutos entre creación y confirmación. */
    res_time_to_confirm_p50_min: { type: Number, default: null },
    /** Reservas por `sourceChannelId` (incluye la clave "__none__"). */
    res_by_source: { type: Schema.Types.Mixed, default: {} },

    // ── Embudo del motor (sesiones distintas por paso) ───────────────────
    funnel_search: num,
    funnel_results: num,
    funnel_category: num,
    funnel_checkout: num,
    funnel_auth: num,
    funnel_created: num,
    funnel_conversion_pct: { type: Number, default: null },

    searches_total: num,
    searches_no_avail: num,
    searches_agent: num,

    // ── Webs y LinkHub ───────────────────────────────────────────────────
    web_sites_total: num,
    web_sites_published: num,
    web_views: num,
    web_visitors: num,
    /** Clics al botón flotante de WhatsApp: el hábito que el piloto contrasta. */
    web_wa_clicks: num,
    lh_views: num,
    lh_visitors: num,
    lh_clicks: num,
    lh_booking_clicks: num,
    lh_src_qr: num,
    lh_src_share: num,

    // ── StayPass ─────────────────────────────────────────────────────────
    sp_guests_stock: num,
    sp_guests_new: num,
    sp_registered_auth0: num,

    // ── Uso del PMS ──────────────────────────────────────────────────────
    pms_dau: num,
    pms_app_opens: { type: Schema.Types.Mixed, default: {} },
    pms_guides_completed: num,
    ob_started: num,
    ob_completed: num,
    /** Histograma {stepIndex: n} de dónde se cae la gente (por eventos). */
    ob_step_hist: { type: Schema.Types.Mixed, default: {} },

    // ── Estado del alta leído del modelo (histórico, no depende de eventos) ─
    // Los eventos de onboarding sólo existen desde que se instrumentó; esto
    // viene guardado desde siempre en `companies.onboarding`.
    ob_state_completed: num,
    ob_state_incomplete: num,
    /** Companies sin el subdocumento: anteriores al alta guiada, no abandonos. */
    ob_state_unknown: num,
    /** Paso actual y etapa (foto). */
    ob_state_step: { type: Number, default: null },
    ob_state_stage: { type: Number, default: null },
    /** Dónde quedaron los que NO terminaron: {step: n}. */
    ob_state_stuck_hist: { type: Schema.Types.Mixed, default: {} },
    ob_state_setup_done: num,
    ob_state_data_done: num,
    /** Gatillo crítico: "completo" sin disponibilidad no puede recibir reservas. */
    ob_state_availability_ok: num,
    ob_state_availability_err: num,
    /** Días sin avanzar: separa "en curso" de "abandonado". */
    ob_state_dormant_days: { type: Number, default: null },

    // ── Bookfer IA ───────────────────────────────────────────────────────
    ia_sessions: num,
    ia_turns: num,
    ia_users: num,
    ia_tool_calls: num,
    ia_tool_error_pct: { type: Number, default: null },
    ia_feedback_up: num,
    ia_feedback_down: num,
    ia_cost_usd: { type: Number, default: 0 },

    agentic_hits: num,

    // ── Cuentas de la plataforma ─────────────────────────────────────────
    // Las ALTAS son históricas (las colecciones tienen createdAt); los STOCK
    // son foto del momento del cómputo.
    stock_companies: num,
    companies_new: num,
    /** 1 si esta company se creó ese día (sólo en scope company). */
    company_created: num,
    stock_spaces: num,
    spaces_new: num,
    users_new: num,
    units_new: num,
    properties_new: num,
    stock_properties_by_company: num,

    // ── Stocks (foto del momento del cómputo) ────────────────────────────
    stock_properties: num,
    stock_units: num,
    stock_users_staff: num,
    stock_apps_enabled: num,
    stock_reviews: num,
    stock_review_score: { type: Number, default: null },

    // ── RMS ──────────────────────────────────────────────────────────────
    rms_configured: num,
    rms_rules_active: num,
    rms_reco_applied: num,
    rms_reco_rejected: num,
    rms_revenue_usd: { type: Number, default: 0 },
    rms_occupancy_pct: { type: Number, default: null },
    rms_adr_usd: { type: Number, default: null },
    rms_revpar_usd: { type: Number, default: null },

    /** Score de uso real 0–100, sólo en scope company (ver §13 del spec). */
    activity_score: { type: Number, default: null },

    computedAt: { type: Date, default: () => new Date() },
  },
  { collection: "metrics_daily", versionKey: false },
);

// Un doc por combinación. `bulkWrite` con upsert depende de este índice.
metricsDailySchema.index(
  { day: 1, scope: 1, companyId: 1, propertyId: 1 },
  { unique: true },
);
metricsDailySchema.index({ scope: 1, companyId: 1, day: -1 });

export type MetricsDailyDoc = InferSchemaType<typeof metricsDailySchema>;
export const MetricsDaily = model("MetricsDaily", metricsDailySchema);

/**
 * Estado del job, espejo de `rms_ingest_state`. Es la métrica de frescura:
 * si el rollup se cayó hace días, los tableros muestran datos viejos sin
 * avisar, y eso es peor que no mostrarlos.
 */
const metricsJobStateSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true },
    lastRunAt: Date,
    lastSuccessAt: Date,
    lastError: { type: String, default: null },
    lastDurationMs: { type: Number, default: null },
    daysComputed: { type: Number, default: 0 },
  },
  { collection: "metrics_job_state", versionKey: false },
);

export const MetricsJobState = model("MetricsJobState", metricsJobStateSchema);
