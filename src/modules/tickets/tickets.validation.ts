import Joi from "joi";

const TYPES = ["feature", "integration", "bug", "improvement"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const STATUSES = ["open", "in_progress", "done", "wont_do", "duplicate"];
const EFFORTS = ["xs", "s", "m", "l", "xl"];

export const listTicketsSchema = Joi.object({
  status: Joi.string()
    .valid(...STATUSES)
    .optional(),
  priority: Joi.string()
    .valid(...PRIORITIES)
    .optional(),
  type: Joi.string()
    .valid(...TYPES)
    .optional(),
  assignedTo: Joi.string().optional(),
  dateFrom: Joi.string().isoDate().optional(),
  dateTo: Joi.string().isoDate().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

export const createTicketSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  description: Joi.string().allow("").max(50_000).optional(),
  type: Joi.string()
    .valid(...TYPES)
    .required(),
  priority: Joi.string()
    .valid(...PRIORITIES)
    .optional(),
  linkedFeedbackIds: Joi.array().items(Joi.string()).optional(),
  assignedTo: Joi.string().optional(),
  estimatedEffort: Joi.string()
    .valid(...EFFORTS)
    .optional(),
  internalNotes: Joi.string().allow("").optional(),
});

export const updateTicketSchema = Joi.object({
  title: Joi.string().min(3).max(200).optional(),
  description: Joi.string().allow("").max(50_000).optional(),
  status: Joi.string()
    .valid(...STATUSES)
    .optional(),
  priority: Joi.string()
    .valid(...PRIORITIES)
    .optional(),
  assignedTo: Joi.string().allow(null, "").optional(),
  estimatedEffort: Joi.string()
    .valid(...EFFORTS)
    .allow(null)
    .optional(),
  internalNotes: Joi.string().allow("").optional(),
  duplicateOfTicketId: Joi.string().allow(null, "").optional(),
}).min(1);
