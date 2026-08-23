import Joi from "joi";
import { ACCESS_EVENT_TYPES, ACCESS_OUTCOMES } from "./pmsAccessModels";

/**
 * Validación de las queries del módulo `access`.
 *
 * A diferencia de `metrics`, acá las fechas son instantes ISO y no días civiles
 * "YYYY-MM-DD": el feed de accesos se mira al minuto ("qué pasó entre las 3 y
 * las 4"), no por día. `Joi.date().iso()` acepta igual "2026-08-20" y lo
 * convierte a Date, así que la UI puede mandar cualquiera de las dos formas.
 */

const dateFrom = Joi.date().iso();
const dateTo = Joi.date().iso();
const id = Joi.string().max(120);

/**
 * `.single()` hace que `?type=login_failed` y `?type=a&type=b` lleguen los dos
 * como array: el servicio siempre arma un `$in` sin ramificar.
 */
const typeList = Joi.array()
  .items(Joi.string().valid(...ACCESS_EVENT_TYPES))
  .single();

const flagList = Joi.array().items(Joi.string().max(60)).single();

export const listEventsSchema = Joi.object({
  dateFrom,
  dateTo,
  companyId: id,
  userId: id,
  type: typeList,
  outcome: Joi.string().valid(...ACCESS_OUTCOMES),
  method: Joi.string().max(40),
  country: Joi.string().max(10),
  city: Joi.string().max(120),
  deviceType: Joi.string().max(40),
  browser: Joi.string().max(60),
  os: Joi.string().max(60),
  flag: flagList,
  q: Joi.string().max(200).allow(""),
  /**
   * Los accesos marcados como `automation` (bots, webdriver, escáneres) son
   * mayoría en el feed crudo y tapan la actividad real, así que quedan fuera
   * salvo que se pidan explícitamente.
   */
  includeAutomation: Joi.boolean().truthy("true").falsy("false").default(false),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

export const listUsersSchema = Joi.object({
  q: Joi.string().max(200).allow(""),
  companyId: id,
  role: Joi.string().max(40),
  status: Joi.string().max(40),
  hasFlags: Joi.boolean().truthy("true").falsy("false").default(false),
  lastAccessFrom: Joi.date().iso(),
  lastAccessTo: Joi.date().iso(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
  sort: Joi.string()
    .valid("lastAccessAt", "createdAt", "accesses30d")
    .default("lastAccessAt"),
});

export const userActionsSchema = Joi.object({
  dateFrom,
  dateTo,
  category: Joi.string().max(60),
  limit: Joi.number().integer().min(1).max(200).default(100),
});

export const summarySchema = Joi.object({
  dateFrom,
  dateTo,
  companyId: id,
});

export const geoPointsSchema = Joi.object({
  dateFrom,
  dateTo,
  companyId: id,
  userId: id,
  limit: Joi.number().integer().min(1).max(2000).default(500),
});
