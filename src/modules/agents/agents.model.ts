import { Schema, model, type InferSchemaType } from "mongoose";

export const AGENT_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export const AGENT_TONES = [
  "formal",
  "friendly",
  "neutral",
  "professional",
] as const;
export const AGENT_LANGUAGES = ["es", "en", "pt"] as const;
export const AGENT_CHANNELS = [
  "pms_app",
  "public_web",
  "widget",
  "internal",
  // Editor/builder del PMS. El runtime de este agente NO vive en internal:
  // corre en pms-core/api (socket /ai, streaming). El internal solo guarda su
  // definicion canonica y mide su consumo via /usage/records.
  "builder",
] as const;

// Modelos seleccionables por agente (referencia para la UI). El runtime acepta
// cualquier string; esta lista es la curada que ofrecemos, y son los tres tiers
// de shared/llm/provider.ts. La tabla de precios (usage.pricing.ts) tiene una
// fila por cada uno, asi que el costo se calcula bien para cualquiera.
export const SELECTABLE_AGENT_MODELS = [
  {
    value: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    hint: "Rapido y economico · USD 0,065/0,18 por 1M · sin vision",
  },
  {
    value: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    hint: "Balanceado · USD 0,075/0,25 por 1M · con vision",
  },
  {
    value: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    hint: "Maxima capacidad · USD 0,75/3,75 por 1M · con vision",
  },
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentTone = (typeof AGENT_TONES)[number];
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

const exampleTurnSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
  },
  { _id: false },
);

const exampleSchema = new Schema(
  {
    exampleId: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: ["good", "bad"], required: true },
    turns: { type: [exampleTurnSchema], default: [] },
    notes: { type: String },
  },
  { _id: false },
);

const personaSchema = new Schema(
  {
    displayName: { type: String, required: true },
    tone: { type: String, enum: AGENT_TONES, default: "neutral" },
    language: { type: String, enum: AGENT_LANGUAGES, default: "es" },
    personality: { type: String, default: "" },
  },
  { _id: false },
);

const instructionsSchema = new Schema(
  {
    systemPrompt: { type: String, default: "" },
    constraints: { type: [String], default: [] },
    examples: { type: [exampleSchema], default: [] },
  },
  { _id: false },
);

const deploymentSchema = new Schema(
  {
    channel: { type: String, enum: AGENT_CHANNELS, default: "internal" },
    allowedCompanyIds: { type: [String], default: [] },
    requiresAuth: { type: Boolean, default: true },
  },
  { _id: false },
);

const feedbackCaptureSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    autoClassify: { type: Boolean, default: true },
    confirmWithUser: { type: Boolean, default: true },
  },
  { _id: false },
);

const limitsSchema = new Schema(
  {
    maxTurnsPerSession: { type: Number, default: 50 },
    maxTokensPerTurn: { type: Number, default: 4096 },
    sessionTtlMinutes: { type: Number, default: 60 },
  },
  { _id: false },
);

const agentSchema = new Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: "" },
    avatarUrl: { type: String },
    status: {
      type: String,
      enum: AGENT_STATUSES,
      default: "draft",
      index: true,
    },

    persona: { type: personaSchema, default: () => ({ displayName: "Agente" }) },
    instructions: { type: instructionsSchema, default: () => ({}) },

    knowledgeBaseIds: { type: [String], default: [] },
    enabledToolIds: { type: [String], default: [] },

    // Override opcional del modelo por agente (ej. agentes Q&A
    // solo-KB pueden bajar a haiku para abaratar). Si null se usa
    // process.env.DEFAULT_AGENT_MODEL.
    modelOverride: { type: String, default: null },

    deployment: { type: deploymentSchema, default: () => ({}) },
    feedbackCapture: { type: feedbackCaptureSchema, default: () => ({}) },
    limits: { type: limitsSchema, default: () => ({}) },

    createdByUserId: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "agents" },
);

agentSchema.index({ "deployment.channel": 1 });

export type AgentDefinitionDoc = InferSchemaType<typeof agentSchema>;
export const AgentDefinition = model("AgentDefinition", agentSchema);

export function sanitizeAgent(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
