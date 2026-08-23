import Joi from "joi";
import { CONTRACT_STATUSES } from "./contracts.model";

const iaSchema = Joi.object({
  enabled: Joi.boolean(),
  monthlyCredits: Joi.number().integer().min(0).max(1_000_000_000),
  resetDayUTC: Joi.number().integer().min(1).max(28),
});

const appItemSchema = Joi.object({
  key: Joi.string().required(),
  enabled: Joi.boolean().required(),
});

export const createContractSchema = Joi.object({
  name: Joi.string().min(1).max(160).required(),
  description: Joi.string().allow("").max(2000),
  ia: iaSchema,
  apps: Joi.array().items(appItemSchema),
  // Contrato global: aplica a todas las companies sin contrato propio.
  appliesToAll: Joi.boolean(),
});

export const updateContractSchema = Joi.object({
  name: Joi.string().min(1).max(160),
  description: Joi.string().allow("").max(2000),
  ia: iaSchema,
  apps: Joi.array().items(appItemSchema),
  appliesToAll: Joi.boolean(),
}).min(1);

export const updateStatusSchema = Joi.object({
  status: Joi.string()
    .valid(...CONTRACT_STATUSES)
    .required(),
});

export const associateSchema = Joi.object({
  // Set completo de companies del contrato (reemplaza el actual). Vacio = sin
  // asociar. Cada company tiene su propia bolsa de creditos.
  companyIds: Joi.array().items(Joi.string().min(1)).default([]),
});

export const listContractsSchema = Joi.object({
  status: Joi.string().valid(...CONTRACT_STATUSES),
  companyId: Joi.string(),
  search: Joi.string().allow(""),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});

export const checkCreditsSchema = Joi.object({
  companyId: Joi.string().min(1).required(),
});
