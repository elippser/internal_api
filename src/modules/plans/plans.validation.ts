import Joi from "joi";
import {
  BILLING_PERIODS,
  PLAN_STATUSES,
  PRODUCT_STATUSES,
} from "./plans.model";
import { PRODUCT_CATEGORIES } from "./productCatalog";
import {
  PLAN_PAGE_FIELD_KEYS,
  PLAN_PAGE_LOCALES,
} from "./planPageFields";

/* ────────────────────────── Productos ────────────────────────── */

const KEY = Joi.string()
  .trim()
  .min(2)
  .max(48)
  .pattern(/^[a-z0-9][a-z0-9-]*$/)
  .messages({
    "string.pattern.base":
      "La clave solo admite minusculas, numeros y guiones medios",
  });

export const createProductSchema = Joi.object({
  key: KEY.required(),
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().allow("").max(2000),
  category: Joi.string().valid(...PRODUCT_CATEGORIES),
  appIds: Joi.array().items(Joi.string().trim().min(1).max(64)),
  routes: Joi.array().items(Joi.string().trim().min(1).max(120)),
  icon: Joi.string().allow("").max(64),
  core: Joi.boolean(),
  status: Joi.string().valid(...PRODUCT_STATUSES),
  order: Joi.number().integer().min(0).max(100000),
});

// `key` no se puede editar: viaja en el snapshot del plan guardado en cada
// company, y cambiarla les sacaria el producto sin tocar el plan.
export const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  description: Joi.string().allow("").max(2000),
  category: Joi.string().valid(...PRODUCT_CATEGORIES),
  appIds: Joi.array().items(Joi.string().trim().min(1).max(64)),
  routes: Joi.array().items(Joi.string().trim().min(1).max(120)),
  icon: Joi.string().allow("").max(64),
  core: Joi.boolean(),
  status: Joi.string().valid(...PRODUCT_STATUSES),
  order: Joi.number().integer().min(0).max(100000),
}).min(1);

export const listProductsSchema = Joi.object({
  status: Joi.string().valid(...PRODUCT_STATUSES),
  category: Joi.string().valid(...PRODUCT_CATEGORIES),
  search: Joi.string().allow(""),
});

/* ──────────────────────────── Planes ─────────────────────────── */

const priceSchema = Joi.object({
  amount: Joi.number().min(0).max(1_000_000),
  currency: Joi.string().trim().uppercase().length(3),
  period: Joi.string().valid(...BILLING_PERIODS),
});

const limitsSchema = Joi.object({
  maxProperties: Joi.number().integer().min(1).max(10000).allow(null),
  maxUsers: Joi.number().integer().min(1).max(100000).allow(null),
  iaMonthlyCredits: Joi.number().integer().min(0).max(1_000_000_000).allow(null),
  // Dia de renovacion del cupo de IA. Topeado en 28: un plan con reset el 30
  // no tendria periodo en febrero.
  iaResetDayUTC: Joi.number().integer().min(1).max(28),
});

const planBody = {
  name: Joi.string().trim().min(1).max(120),
  slug: KEY,
  tagline: Joi.string().allow("").max(200),
  description: Joi.string().allow("").max(4000),
  productKeys: Joi.array().items(Joi.string().trim().min(1).max(48)),
  price: priceSchema,
  free: Joi.boolean(),
  freeDurationDays: Joi.number().integer().min(1).max(3650).allow(null),
  trialDays: Joi.number().integer().min(0).max(365),
  limits: limitsSchema,
  status: Joi.string().valid(...PLAN_STATUSES),
  public: Joi.boolean(),
  order: Joi.number().integer().min(0).max(100000),
  highlighted: Joi.boolean(),
};

export const createPlanSchema = Joi.object({
  ...planBody,
  name: planBody.name.required(),
});

export const updatePlanSchema = Joi.object(planBody).min(1);

export const listPlansSchema = Joi.object({
  status: Joi.string().valid(...PLAN_STATUSES),
  public: Joi.boolean(),
  search: Joi.string().allow(""),
});

/* ──────────────────── Server-to-server (PMS) ─────────────────── */

export const selectPlanSchema = Joi.object({
  companyId: Joi.string().trim().min(1).required(),
  planId: Joi.string().trim().min(1).required(),
});

/* ─────────── Contenido de la pantalla /planes del PMS ─────────── */

// Un bloque por idioma con los campos del catalogo. Se admite cualquier clave
// conocida y se permite la cadena vacia: vacio significa "usa el default", que
// es la unica forma de deshacer una edicion.
const localeBlockSchema = Joi.object(
  Object.fromEntries(
    PLAN_PAGE_FIELD_KEYS.map((key) => [key, Joi.string().allow("").max(1200)]),
  ),
);

export const replacePlanPageContentSchema = Joi.object({
  locales: Joi.object(
    Object.fromEntries(
      PLAN_PAGE_LOCALES.map((locale) => [locale, localeBlockSchema]),
    ),
  ).required(),
});
