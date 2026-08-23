import Joi from "joi";
import {
  ACCOUNT_LIFECYCLES,
  ACCOUNT_SIZES,
  ACCOUNT_SOURCES,
  DELIVERY_STATUSES,
  MKT_EVENT_TYPES,
} from "./crm.model";
import { SEGMENT_FIELDS, SEGMENT_OPERATORS } from "./segments.model";

const optIn = Joi.object({
  email: Joi.boolean(),
  whatsapp: Joi.boolean(),
});

export const listAccountsSchema = Joi.object({
  lifecycle: Joi.string().valid(...ACCOUNT_LIFECYCLES),
  source: Joi.string().valid(...ACCOUNT_SOURCES),
  tag: Joi.string().max(60),
  ownerUserId: Joi.string().max(120),
  search: Joi.string().max(120).allow(""),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});

export const createAccountSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  website: Joi.string().max(300).allow(""),
  country: Joi.string().max(80).allow(""),
  city: Joi.string().max(120).allow(""),
  size: Joi.string().valid(...ACCOUNT_SIZES),
  lifecycle: Joi.string().valid(...ACCOUNT_LIFECYCLES),
  source: Joi.string().valid(...ACCOUNT_SOURCES),
  ownerUserId: Joi.string().max(120).allow(""),
  companyId: Joi.string().max(120).allow(""),
  tags: Joi.array().items(Joi.string().max(60)),
  optIn,
  notes: Joi.string().max(5000).allow(""),
});

export const updateAccountSchema = createAccountSchema
  .fork(["name"], (s) => s.optional())
  .min(1);

export const createContactSchema = Joi.object({
  accountId: Joi.string().required(),
  // `tlds: false` en todo el hub: la lista de TLDs que trae Joi se queda vieja
  // y rechazar el mail de un prospecto real por eso es peor que aceptar uno raro.
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .required(),
  phone: Joi.string().max(40).allow(""),
  firstName: Joi.string().max(120).allow(""),
  lastName: Joi.string().max(120).allow(""),
  role: Joi.string().max(120).allow(""),
  isPrimary: Joi.boolean(),
  optIn,
});

export const updateContactSchema = createContactSchema
  .fork(["accountId", "email"], (s) => s.optional())
  .min(1);

/** Ingesta server-to-server desde pms-core / booking-app. */
export const ingestEventSchema = Joi.object({
  type: Joi.string()
    .valid(...MKT_EVENT_TYPES)
    .required(),
  correlationId: Joi.string().max(200).required(),
  accountId: Joi.string().max(120),
  companyId: Joi.string().max(120),
  payload: Joi.object().unknown(true),
  source: Joi.string().max(60),
  occurredAt: Joi.date(),
}).or("accountId", "companyId");

export const listEventsSchema = Joi.object({
  type: Joi.string().valid(...MKT_EVENT_TYPES),
  accountId: Joi.string().max(120),
  status: Joi.string().valid(...DELIVERY_STATUSES),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});

export const segmentSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(1000).allow(""),
  match: Joi.string().valid("all", "any"),
  rules: Joi.array()
    .items(
      Joi.object({
        field: Joi.string()
          .valid(...SEGMENT_FIELDS)
          .required(),
        operator: Joi.string()
          .valid(...SEGMENT_OPERATORS)
          .required(),
        value: Joi.any(),
      }),
    )
    .max(20),
});

/** Import CSV: se manda ya parseado desde el front. */
export const importAccountsSchema = Joi.object({
  rows: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().min(1).max(200).required(),
        website: Joi.string().max(300).allow(""),
        country: Joi.string().max(80).allow(""),
        city: Joi.string().max(120).allow(""),
        email: Joi.string()
          .email({ tlds: { allow: false } })
          .allow(""),
        firstName: Joi.string().max(120).allow(""),
        lastName: Joi.string().max(120).allow(""),
        phone: Joi.string().max(40).allow(""),
        lifecycle: Joi.string().valid(...ACCOUNT_LIFECYCLES),
        tags: Joi.array().items(Joi.string().max(60)),
      }),
    )
    .min(1)
    .max(2000)
    .required(),
});
