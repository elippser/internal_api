import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Rollup diario **por app**. Un doc por
 * `{day, scope, companyId, propertyId, hubKey, appId}`.
 *
 * Va en una colección aparte de `metrics_daily` y no como campos anidados
 * porque la app es una dimensión, no un puñado de contadores: meterla en mapas
 * `Mixed` obligaría a leer el doc entero para graficar una sola app y haría
 * imposible ordenar o filtrar por ella en la base.
 *
 * El modelo de usabilidad sigue **ISO 9241-11** (efectividad, eficiencia,
 * satisfacción) cruzado con **HEART** de Google:
 *
 * | Dimensión           | Campos                                        |
 * |---------------------|-----------------------------------------------|
 * | Adoption            | `enabled`, `opened`, `users`                  |
 * | Engagement          | `opens`, `sessions`, `sessionSeconds`, `screenViews` |
 * | Efectividad (Task success) | `tasksStarted`, `tasksCompleted`, `tasksAbandoned` |
 * | Eficiencia          | `taskSecondsSum`, `taskSteps`, `screensPerSession` |
 * | Errores             | `taskErrors`                                  |
 * | Satisfacción        | `satisfactionUp`, `satisfactionDown` (donde haya señal) |
 *
 * `detail` guarda lo específico de cada app (sitios activos, popups, páginas,
 * reglas del RMS, pasos del motor…), que no tiene sentido normalizar en
 * columnas comunes.
 */

const num = { type: Number, default: 0 };

const metricsAppDailySchema = new Schema(
  {
    day: { type: String, required: true, index: true },
    scope: {
      type: String,
      enum: ["global", "company", "property"],
      required: true,
    },
    companyId: { type: String, default: null },
    propertyId: { type: String, default: null },
    hubKey: { type: String, required: true },
    appId: { type: String, required: true },

    // ── Adopción ─────────────────────────────────────────────────────────
    /** Espacios operativos que tienen la app habilitada. */
    enabled: num,
    /** 1 si la app se abrió al menos una vez ese día en este scope. */
    opened: num,
    users: num,

    // ── Engagement ───────────────────────────────────────────────────────
    opens: num,
    sessions: num,
    sessionSeconds: num,
    screenViews: num,

    // ── Efectividad / eficiencia (tareas) ────────────────────────────────
    tasksStarted: num,
    tasksCompleted: num,
    tasksAbandoned: num,
    taskErrors: num,
    taskSecondsSum: num,
    taskSteps: num,
    /** Mediana de segundos por tarea; null si no hubo ninguna. */
    taskSecondsP50: { type: Number, default: null },
    /** Dónde se cae la gente: {atStep: n}. */
    abandonedAtStep: { type: Schema.Types.Mixed, default: {} },
    /** Errores por código estable: {code: n}. */
    errorsByCode: { type: Schema.Types.Mixed, default: {} },

    // ── Satisfacción (sólo donde exista señal explícita) ─────────────────
    satisfactionUp: num,
    satisfactionDown: num,

    /** Métricas propias de la app (ver `metricsAppRollup.service.ts`). */
    detail: { type: Schema.Types.Mixed, default: {} },

    computedAt: { type: Date, default: () => new Date() },
  },
  { collection: "metrics_app_daily", versionKey: false },
);

metricsAppDailySchema.index(
  { day: 1, scope: 1, companyId: 1, propertyId: 1, appId: 1 },
  { unique: true },
);
metricsAppDailySchema.index({ scope: 1, hubKey: 1, day: -1 });
metricsAppDailySchema.index({ scope: 1, appId: 1, day: -1 });

export type MetricsAppDailyDoc = InferSchemaType<typeof metricsAppDailySchema>;
export const MetricsAppDaily = model("MetricsAppDaily", metricsAppDailySchema);
