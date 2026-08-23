import Joi from "joi";
import { DOC_SOURCE_TYPES, KB_LANGUAGES } from "./knowledge.model";

export const createKbSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  description: Joi.string().allow(""),
  language: Joi.string().valid(...KB_LANGUAGES),
});

export const updateKbSchema = Joi.object({
  name: Joi.string().min(1).max(120),
  description: Joi.string().allow(""),
  language: Joi.string().valid(...KB_LANGUAGES),
}).min(1);

export const createTextDocSchema = Joi.object({
  sourceType: Joi.string()
    .valid("text", "markdown", "url", "manual")
    .required(),
  originalName: Joi.string().min(1).max(200).required(),
  rawText: Joi.string().allow(""),
  storageUrl: Joi.string().allow(""),
  metadata: Joi.object({
    title: Joi.string().allow(""),
    description: Joi.string().allow(""),
    tags: Joi.array().items(Joi.string()),
    language: Joi.string(),
  }),
});

export const listDocsSchema = Joi.object({
  status: Joi.string(),
  sourceType: Joi.string().valid(...DOC_SOURCE_TYPES),
});
