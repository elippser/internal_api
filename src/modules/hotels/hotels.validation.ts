import Joi from "joi";

export const listHotelsSchema = Joi.object({
  search: Joi.string().allow("").optional(),
  plan: Joi.string()
    .valid("free", "starter", "pro", "enterprise")
    .optional(),
  status: Joi.string()
    .valid("active", "suspended", "deleted")
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

export const listActivitySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(20),
});
