import Joi from "joi";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const metricsQuerySchema = Joi.object({
  /** Día civil UTC "YYYY-MM-DD" (misma convención que el rollup). */
  dateFrom: Joi.string().pattern(DAY),
  dateTo: Joi.string().pattern(DAY),
  companyId: Joi.string().max(120),
  propertyId: Joi.string().max(120),
});

/** Listado de sesiones del agente: el de arriba + paginación y filtro de voto. */
export const iaSessionsQuerySchema = metricsQuerySchema.keys({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  onlyWithFeedback: Joi.boolean().truthy("true").falsy("false"),
});

/** Métricas por app/hub: el rango común + los cortes por hub y app. */
export const appMetricsQuerySchema = Joi.object({
  dateFrom: Joi.string().pattern(DAY),
  dateTo: Joi.string().pattern(DAY),
  companyId: Joi.string().max(120),
  hubKey: Joi.string().max(60),
  appId: Joi.string().max(60),
});

export const recomputeSchema = Joi.object({
  /** Un día puntual, o una ventana de los últimos N días. */
  day: Joi.string().pattern(DAY),
  days: Joi.number().integer().min(0).max(120),
}).oxor("day", "days");
