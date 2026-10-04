import Joi from "joi";
import { ATTACHMENT_KINDS } from "./supportChat.model";

const attachment = Joi.object({
  kind: Joi.string().valid(...ATTACHMENT_KINDS).required(),
  url: Joi.string().uri({ scheme: ["https"] }).max(1000).required(),
  name: Joi.string().allow("").max(255),
  mime: Joi.string().allow("").max(150),
  size: Joi.number().min(0),
  width: Joi.number().min(0),
  height: Joi.number().min(0),
  duration: Joi.number().min(0),
});

export const messageSchema = Joi.object({
  text: Joi.string().allow("").max(4000),
  attachments: Joi.array().items(attachment).max(10).default([]),
  replyToMessageId: Joi.string().max(80).allow("", null),
  // Solo los usa el lado del PMS (scope del usuario).
  companyId: Joi.string().allow("").max(80),
  propertyId: Joi.string().allow("").max(80),
  locale: Joi.string().allow("").max(10),
  // PMS: "Nuevo chat" — cierra el caso abierto y arranca otro.
  newConversation: Joi.boolean().default(false),
});

export const syncSchema = Joi.object({
  afterSeq: Joi.number().integer().min(0).default(0),
  // El internal puede mirar un caso sin marcarlo leído (vista previa).
  read: Joi.boolean().default(true),
});

export const listSchema = Joi.object({
  filter: Joi.string().valid("open", "waiting", "mine", "closed", "all").default("open"),
  q: Joi.string().allow("").max(120),
  limit: Joi.number().integer().min(1).max(200).default(100),
});

export const pulseSchema = Joi.object({
  since: Joi.date().iso(),
});

export const signSchema = Joi.object({
  kind: Joi.string().valid(...ATTACHMENT_KINDS).required(),
  // El proxy del PMS agrega companyId y propertyId a todo POST.
  companyId: Joi.string().allow("").max(80),
  propertyId: Joi.string().allow("").max(80),
});

export const fileSchema = Joi.object({
  url: Joi.string().uri({ scheme: ["https"] }).max(1000).required(),
}).unknown(true);
