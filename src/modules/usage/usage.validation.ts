import Joi from "joi";
import { USAGE_SOURCES } from "./usage.model";

export const recordUsageSchema = Joi.object({
  source: Joi.string()
    .valid(...USAGE_SOURCES)
    .required(),
  agentId: Joi.string().allow(null, ""),
  agentSlug: Joi.string().allow(null, ""),
  model: Joi.string().min(1).max(120).required(),

  companyId: Joi.string().min(1).required(),
  propertyId: Joi.string().allow(null, ""),
  userId: Joi.string().allow(null, ""),
  userRole: Joi.string().allow(null, ""),

  conversationId: Joi.string().allow(null, ""),
  sessionId: Joi.string().allow(null, ""),
  turnIndex: Joi.number().integer().min(0).allow(null),

  inputTokens: Joi.number().integer().min(0).default(0),
  outputTokens: Joi.number().integer().min(0).default(0),
  cacheCreationTokens: Joi.number().integer().min(0).default(0),
  cacheReadTokens: Joi.number().integer().min(0).default(0),
  latencyMs: Joi.number().integer().min(0).default(0),
  toolCallCount: Joi.number().integer().min(0).default(0),

  occurredAt: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
}).unknown(true);

export const usageRangeQuerySchema = Joi.object({
  dateFrom: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  dateTo: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  companyId: Joi.string(),
  propertyId: Joi.string(),
  userId: Joi.string(),
  source: Joi.string().valid(...USAGE_SOURCES),
  agentId: Joi.string(),
  model: Joi.string(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
});
