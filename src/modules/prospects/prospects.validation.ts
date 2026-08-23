import Joi from "joi";
import {
  ACTIVITY_OUTCOMES,
  ACTIVITY_TYPES,
  CONTACTABILITY,
  LODGING_TYPES,
  LOST_REASONS,
  PROSPECT_OUTCOMES,
  PROSPECT_PRIORITIES,
  PROSPECT_SOURCES,
  PROSPECT_STATUSES,
} from "./prospects.model";

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

const bool = Joi.alternatives().try(
  Joi.boolean(),
  Joi.string().valid("1", "0", "true", "false"),
);

const text = (max: number) => Joi.string().allow("", null).max(max);

export const listProspectsSchema = Joi.object({
  status: Joi.string().valid(...PROSPECT_STATUSES).optional(),
  outcome: Joi.string().valid(...PROSPECT_OUTCOMES).optional(),
  priority: Joi.string().valid(...PROSPECT_PRIORITIES).optional(),
  lodgingType: Joi.string().valid(...LODGING_TYPES).optional(),
  source: Joi.string().valid(...PROSPECT_SOURCES).optional(),
  contactability: Joi.string().valid(...CONTACTABILITY).optional(),
  country: Joi.string().trim().uppercase().length(2).optional(),
  region: Joi.string().trim().max(80).optional(),
  tag: Joi.string().trim().max(60).optional(),
  ownerUserId: Joi.string().trim().max(80).optional(),
  unassigned: bool.optional(),
  due: bool.optional(),
  untouched: bool.optional(),
  includeDoNotCall: bool.optional(),
  search: Joi.string().trim().allow("").max(120).optional(),
  sort: Joi.string().valid("score", "recent", "name", "attempts", "next").default("score"),
  ...pagination,
});

const contactFields = {
  phone: text(60),
  email: Joi.string().trim().allow("", null).max(160),
  website: text(400),
};

export const createProspectSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  handle: text(80),
  handleUrl: text(400),
  lodgingType: Joi.string().valid(...LODGING_TYPES).optional(),
  location: text(300),
  country: Joi.string().trim().uppercase().length(2).allow("", null).optional(),
  region: text(80),
  ...contactFields,
  source: Joi.string().valid(...PROSPECT_SOURCES).optional(),
  sourceBatch: text(80),
  priority: Joi.string().valid(...PROSPECT_PRIORITIES).optional(),
  ownerUserId: text(80),
  tags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20).optional(),
  notes: text(10_000),
  postUrl: text(400),
  postedAt: Joi.date().iso().optional(),
});

export const updateProspectSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  handle: text(80),
  lodgingType: Joi.string().valid(...LODGING_TYPES),
  location: text(300),
  country: Joi.string().trim().uppercase().length(2).allow("", null),
  region: text(80),
  ...contactFields,
  status: Joi.string().valid(...PROSPECT_STATUSES),
  lostReason: Joi.string().valid(...LOST_REASONS).allow("", null),
  lostNote: text(2_000),
  priority: Joi.string().valid(...PROSPECT_PRIORITIES),
  ownerUserId: text(80),
  nextActionAt: Joi.date().iso().allow(null),
  nextActionNote: text(500),
  doNotCall: Joi.boolean(),
  tags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20),
  notes: text(10_000),
})
  .min(1)
  .messages({ "object.min": "No se envio ningun campo para actualizar" });

export const logActivitySchema = Joi.object({
  type: Joi.string().valid(...ACTIVITY_TYPES).required(),
  outcome: Joi.string().valid(...ACTIVITY_OUTCOMES).default("none"),
  notes: text(5_000),
  durationSec: Joi.number().integer().min(0).max(60 * 60 * 8).optional(),
  status: Joi.string().valid(...PROSPECT_STATUSES).optional(),
  nextActionAt: Joi.date().iso().allow(null).optional(),
  nextActionNote: text(500),
  lostReason: Joi.string().valid(...LOST_REASONS).allow("", null).optional(),
  lostNote: text(2_000),
  doNotCall: Joi.boolean().optional(),
  occurredAt: Joi.date().iso().optional(),
});

export const listActivitiesSchema = Joi.object({
  prospectId: Joi.string().trim().max(80).optional(),
  type: Joi.string().valid(...ACTIVITY_TYPES).optional(),
  userId: Joi.string().trim().max(80).optional(),
  days: Joi.number().integer().min(1).max(365).optional(),
  ...pagination,
});

export const queueSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  onlyMine: bool.default(false),
});

export const dashboardSchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(30),
});

export const importSchema = Joi.object({
  rows: Joi.array().items(createProspectSchema).min(1).max(2_000).required(),
  source: Joi.string().valid(...PROSPECT_SOURCES).optional(),
  sourceBatch: Joi.string().trim().max(80).optional(),
});

export const bulkSchema = Joi.object({
  prospectIds: Joi.array().items(Joi.string().trim().max(80)).min(1).max(1_000).required(),
  ownerUserId: text(80),
  status: Joi.string().valid(...PROSPECT_STATUSES),
  priority: Joi.string().valid(...PROSPECT_PRIORITIES),
  addTags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20),
  removeTags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20),
  doNotCall: Joi.boolean(),
  nextActionAt: Joi.date().iso().allow(null),
})
  .min(2)
  .messages({ "object.min": "No se envio ninguna accion para aplicar" });

export const convertSchema = Joi.object({
  lifecycle: Joi.string().valid("lead", "mql", "demo", "trial", "customer").default("customer"),
});
