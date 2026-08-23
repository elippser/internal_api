import Joi from "joi";
import { INTERNAL_ROLES } from "./users.model";

export const createUserSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().min(8).max(128).required(),
  firstName: Joi.string().min(1).max(80).required(),
  lastName: Joi.string().min(1).max(80).required(),
  role: Joi.string()
    .valid(...INTERNAL_ROLES)
    .required(),
});

export const updateUserSchema = Joi.object({
  firstName: Joi.string().min(1).max(80),
  lastName: Joi.string().min(1).max(80),
  role: Joi.string().valid(...INTERNAL_ROLES),
  status: Joi.string().valid("active", "inactive"),
  password: Joi.string().min(8).max(128),
}).min(1);

export const listUsersSchema = Joi.object({
  role: Joi.string().valid(...INTERNAL_ROLES),
  status: Joi.string().valid("active", "inactive"),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});
