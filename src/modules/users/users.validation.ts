import Joi from "joi";
import { AREA_KEYS, AREA_LEVELS } from "../../shared/access/areas";
import { INTERNAL_ROLES } from "./users.model";

/** { metrics: "read", crm: "none", ... } — solo claves y niveles conocidos. */
const areaAccessSchema = Joi.object(
  Object.fromEntries(AREA_KEYS.map((k) => [k, Joi.string().valid(...AREA_LEVELS)])),
);

/** Vencimiento del acceso: fecha futura, o null para quitarlo. */
const expiresSchema = Joi.date().iso().allow(null);

export const createUserSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().min(8).max(128).required(),
  firstName: Joi.string().min(1).max(80).required(),
  lastName: Joi.string().min(1).max(80).required(),
  role: Joi.string()
    .valid(...INTERNAL_ROLES)
    .required(),
  areaAccess: areaAccessSchema,
  accessExpiresAt: expiresSchema.greater("now"),
});

export const updateUserSchema = Joi.object({
  firstName: Joi.string().min(1).max(80),
  lastName: Joi.string().min(1).max(80),
  role: Joi.string().valid(...INTERNAL_ROLES),
  status: Joi.string().valid("active", "inactive"),
  password: Joi.string().min(8).max(128),
  areaAccess: areaAccessSchema,
  accessExpiresAt: expiresSchema,
}).min(1);

export const listUsersSchema = Joi.object({
  role: Joi.string().valid(...INTERNAL_ROLES),
  status: Joi.string().valid("active", "inactive"),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});
