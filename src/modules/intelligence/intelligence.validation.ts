import Joi from "joi";
import { SIGNAL_TYPES } from "./intelligence.model";
import { CONNECTOR_NAMES } from "./intelligence.service";

export const listSignalsSchema = Joi.object({
  type: Joi.string().valid(...SIGNAL_TYPES),
  source: Joi.string().max(64),
  country: Joi.string().length(2).uppercase(),
  airport: Joi.string().length(3).uppercase(),
  from: Joi.string().isoDate(),
  to: Joi.string().isoDate(),
  // Caja geográfica (los tres juntos). Ver listSignals.
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
  radiusKm: Joi.number().min(0.5).max(500),
  limit: Joi.number().integer().min(1).max(2000).default(500),
})
  .and("lat", "lng", "radiusKm");

// Derivado del registro real de connectors: agregar uno nuevo al service lo
// habilita acá solo (la lista hardcodeada dejaba los nuevos sin ingesta manual).
export const ingestParamsSchema = Joi.object({
  connector: Joi.string()
    .valid(...CONNECTOR_NAMES, "all")
    .required(),
});

// Barrido dirigido a puntos concretos: ?pointIds=a,b (CSV).
export const ingestQuerySchema = Joi.object({
  pointIds: Joi.string().max(2000).optional(),
}).unknown(true);

export const watchpointParamsSchema = Joi.object({
  pointId: Joi.string().trim().min(1).max(120).required(),
});

export const watchpointBodySchema = Joi.object({
  label: Joi.string().trim().min(1).max(120).required(),
  countryCode: Joi.string().length(2).uppercase().required(),
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  radiusKm: Joi.number().min(5).max(100).optional(),
  source: Joi.string().trim().max(40).optional(),
});
