import Joi from "joi";

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

/** Rango por defecto: ultimos 30 dias (los crudos viven 30; los consolidados, 18 meses). */
export const rangeSchema = Joi.object({
  from: day,
  to: day,
  companyId: Joi.string().max(120).allow(""),
  appId: Joi.string().max(60).pattern(/^[a-z0-9][a-z0-9-]*$/),
});

export const detailSchema = rangeSchema.keys({
  screenKey: Joi.string().max(160).pattern(/^[a-z0-9_][a-z0-9:/_.-]*$/).required(),
  vw: Joi.string().valid("m", "t", "d").default("d"),
});

export const flowsSchema = rangeSchema.keys({
  layer: Joi.string().valid("pms", "booking", "rooms", "rms").default("pms"),
});

export const recomputeSchema = Joi.object({
  from: day.required(),
  to: day,
});

export const iaQuestionsSchema = rangeSchema.keys({
  topic: Joi.string().max(40).pattern(/^[a-z-]+$/),
  resolved: Joi.string().valid("si", "parcial", "no", "no-se-sabe"),
  q: Joi.string().max(80).allow(""),
});

export const iaLabelSchema = Joi.object({
  budgetUsd: Joi.number().min(0).max(5).default(0.2),
  maxMessages: Joi.number().integer().min(1).max(2000).default(200),
});
