import Joi from "joi";
import {
  AGENT_CHANNELS,
  AGENT_LANGUAGES,
  AGENT_STATUSES,
  AGENT_TONES,
} from "./agents.model";

const exampleTurnSchema = Joi.object({
  role: Joi.string().valid("user", "assistant").required(),
  content: Joi.string().allow("").required(),
});

const exampleSchema = Joi.object({
  exampleId: Joi.string().required(),
  label: Joi.string().min(1).required(),
  type: Joi.string().valid("good", "bad").required(),
  turns: Joi.array().items(exampleTurnSchema).default([]),
  notes: Joi.string().allow(""),
});

const personaSchema = Joi.object({
  displayName: Joi.string().min(1).max(120).required(),
  tone: Joi.string().valid(...AGENT_TONES),
  language: Joi.string().valid(...AGENT_LANGUAGES),
  personality: Joi.string().allow(""),
});

const instructionsSchema = Joi.object({
  systemPrompt: Joi.string().allow(""),
  constraints: Joi.array().items(Joi.string().allow("")),
  examples: Joi.array().items(exampleSchema),
});

const deploymentSchema = Joi.object({
  channel: Joi.string().valid(...AGENT_CHANNELS),
  allowedCompanyIds: Joi.array().items(Joi.string()),
  requiresAuth: Joi.boolean(),
});

const feedbackCaptureSchema = Joi.object({
  enabled: Joi.boolean(),
  autoClassify: Joi.boolean(),
  confirmWithUser: Joi.boolean(),
});

const limitsSchema = Joi.object({
  maxTurnsPerSession: Joi.number().integer().min(1).max(500),
  maxTokensPerTurn: Joi.number().integer().min(64).max(32000),
  sessionTtlMinutes: Joi.number().integer().min(1).max(1440),
});

export const createAgentSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  slug: Joi.string().min(1).max(60),
  description: Joi.string().allow(""),
  avatarUrl: Joi.string().uri().allow(""),
  status: Joi.string().valid(...AGENT_STATUSES),
  persona: personaSchema,
  instructions: instructionsSchema,
  knowledgeBaseIds: Joi.array().items(Joi.string()),
  enabledToolIds: Joi.array().items(Joi.string()),
  // Modelo por agente. null/"" = heredar DEFAULT_AGENT_MODEL del runtime.
  modelOverride: Joi.string().allow(null, "").max(120),
  deployment: deploymentSchema,
  feedbackCapture: feedbackCaptureSchema,
  limits: limitsSchema,
});

export const updateAgentSchema = Joi.object({
  name: Joi.string().min(1).max(120),
  slug: Joi.string().min(1).max(60),
  description: Joi.string().allow(""),
  avatarUrl: Joi.string().uri().allow(""),
  persona: personaSchema,
  instructions: instructionsSchema,
  knowledgeBaseIds: Joi.array().items(Joi.string()),
  enabledToolIds: Joi.array().items(Joi.string()),
  // null/"" = heredar DEFAULT_AGENT_MODEL del runtime.
  modelOverride: Joi.string().allow(null, "").max(120),
  deployment: deploymentSchema,
  feedbackCapture: feedbackCaptureSchema,
  limits: limitsSchema,
}).min(1);

export const updateStatusSchema = Joi.object({
  status: Joi.string()
    .valid(...AGENT_STATUSES)
    .required(),
});

export const listAgentsSchema = Joi.object({
  status: Joi.string().valid(...AGENT_STATUSES),
  channel: Joi.string().valid(...AGENT_CHANNELS),
  search: Joi.string().allow(""),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
});
