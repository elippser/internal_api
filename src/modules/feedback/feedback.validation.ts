import Joi from "joi";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONFIDENCES,
  FEEDBACK_STATUSES,
} from "./feedback.model";

export const listFeedbackSchema = Joi.object({
  status: Joi.string().valid(...FEEDBACK_STATUSES),
  category: Joi.string().valid(...FEEDBACK_CATEGORIES),
  agentId: Joi.string(),
  companyId: Joi.string(),
  userConfirmed: Joi.boolean(),
  dateFrom: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  dateTo: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});

export const updateFeedbackSchema = Joi.object({
  status: Joi.string()
    .valid("reviewed", "discarded", "linked_to_ticket")
    .required(),
  linkedTicketId: Joi.string().allow(null, ""),
});

export const createFeedbackSchema = Joi.object({
  agentId: Joi.string().required(),
  sessionId: Joi.string().required(),
  companyId: Joi.string().allow(null, ""),
  propertyId: Joi.string().allow(null, ""),
  rawUserMessage: Joi.string().allow("").required(),
  agentResponse: Joi.string().allow(""),
  classification: Joi.object({
    intent: Joi.string().allow(""),
    category: Joi.string().valid(...FEEDBACK_CATEGORIES),
    confidence: Joi.string().valid(...FEEDBACK_CONFIDENCES),
    summary: Joi.string().allow(""),
  }),
  userConfirmed: Joi.boolean(),
  capturedAt: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
});
