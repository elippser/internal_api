import Joi from "joi";
import { EVENT_SOURCES } from "./analytics.registry";

/**
 * Forma general del sobre. El contrato fino de cada evento (qué campos lleva
 * su `payload`) lo valida el registry al ingerir, no este schema.
 *
 * `companyId` dejó de ser requerido acá: los emisores públicos (motor, sitios)
 * conocen la property pero no la compañía, así que la ingesta la resuelve
 * contra la base del PMS. Si no llega ninguno de los dos, el evento se descarta.
 */
export const ingestEventSchema = Joi.object({
  eventName: Joi.string().min(1).max(120).required(),
  category: Joi.string().min(1).max(80),
  source: Joi.string()
    .valid(...EVENT_SOURCES)
    .required(),
  companyId: Joi.string().allow(null, ""),
  propertyId: Joi.string().allow(null, ""),
  userId: Joi.string().allow(null, ""),
  sessionId: Joi.string().max(64).allow("", null),
  userRole: Joi.string().allow(null, ""),
  payload: Joi.object().default({}),
  clientTimestamp: Joi.alternatives()
    .try(Joi.date(), Joi.string().isoDate())
    .required(),
  correlationId: Joi.string().max(160).allow(null, ""),
}).unknown(true);

/**
 * Lote. Los SDKs bufferizan (cada 5s / 10 eventos / `pagehide`), así que el
 * caso normal en producción es un array, no un evento suelto. Se aceptan las
 * dos formas para no romper emisores server-side de un solo evento.
 */
export const ingestBatchSchema = Joi.object({
  events: Joi.array().items(ingestEventSchema).min(1).max(50).required(),
});

export const rangeQuerySchema = Joi.object({
  dateFrom: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  dateTo: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  companyId: Joi.string(),
  propertySlug: Joi.string(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
  eventName: Joi.string(),
});
