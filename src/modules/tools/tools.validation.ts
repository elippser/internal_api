import Joi from "joi";
import {
  AUTH_STRATEGIES,
  HTTP_METHODS,
  TARGET_SERVICES,
  TOOL_CATEGORIES,
} from "./tools.model";

const executionSchema = Joi.object({
  targetService: Joi.string()
    .valid(...TARGET_SERVICES)
    .required(),
  method: Joi.string()
    .valid(...HTTP_METHODS)
    .required(),
  pathTemplate: Joi.string().min(1).required(),
  authStrategy: Joi.string().valid(...AUTH_STRATEGIES),
  timeout: Joi.number().integer().min(100).max(120000),
});

const permissionsSchema = Joi.object({
  requiredRoles: Joi.array().items(Joi.string()),
  requiresConfirmation: Joi.boolean(),
  isDestructive: Joi.boolean(),
});

const inputSchemaSchema = Joi.object({
  type: Joi.string().valid("object"),
  properties: Joi.object().pattern(Joi.string(), Joi.any()),
  required: Joi.array().items(Joi.string()),
});

export const createToolSchema = Joi.object({
  name: Joi.string()
    .min(1)
    .max(80)
    .pattern(/^[a-z][a-z0-9_]*$/)
    .required(),
  displayName: Joi.string().min(1).max(120).required(),
  description: Joi.string().allow(""),
  category: Joi.string()
    .valid(...TOOL_CATEGORIES)
    .required(),
  inputSchema: inputSchemaSchema,
  execution: executionSchema.required(),
  permissions: permissionsSchema,
  status: Joi.string().valid("active", "inactive"),
});

export const updateToolSchema = Joi.object({
  name: Joi.string()
    .min(1)
    .max(80)
    .pattern(/^[a-z][a-z0-9_]*$/),
  displayName: Joi.string().min(1).max(120),
  description: Joi.string().allow(""),
  category: Joi.string().valid(...TOOL_CATEGORIES),
  inputSchema: inputSchemaSchema,
  execution: executionSchema,
  permissions: permissionsSchema,
}).min(1);

export const updateStatusSchema = Joi.object({
  status: Joi.string().valid("active", "inactive").required(),
});

export const listToolsSchema = Joi.object({
  category: Joi.string().valid(...TOOL_CATEGORIES),
  status: Joi.string().valid("active", "inactive"),
  search: Joi.string().allow(""),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(200),
});
