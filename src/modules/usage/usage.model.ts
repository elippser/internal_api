import { Schema, model, type InferSchemaType } from "mongoose";

// De donde viene el consumo. Cada nueva superficie que reporte tokens agrega
// un valor aca (ej. en el futuro "public_widget").
export const USAGE_SOURCES = [
  "editor_builder", // chatbot del editor (pms-core/api · socket /ai)
  "conversation_agent", // agentes de conversacion del internal (runTurn)
  "social_hub", // generación IA del Social Hub (pms-core/api · REST)
  // pms-core ya reportaba con este source desde templateAutofillService, pero
  // faltaba en el enum: el Joi lo rechazaba con 400 y, como el cliente es
  // fire-and-forget, ese consumo se perdía sin dejar rastro.
  "template_autofill", // autocompletado de plantillas de sitio (pms-core/api)
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

// Sentinela para dimensiones nulas en el rollup. Mongo permite documentos con
// campos faltantes en indices unique, pero para que el upsert sea determinista
// necesitamos un valor concreto y estable por dimension ausente.
export const DIM_NONE = "__none__";

/**
 * UsageRecord: una fila por turno facturable (un POST a /usage/records). Es el
 * ledger crudo, inmutable, para auditoria y drill-down. No tiene TTL: es dato
 * de consumo/costo y se conserva.
 */
const usageRecordSchema = new Schema(
  {
    usageId: { type: String, required: true, unique: true, index: true },
    source: { type: String, enum: USAGE_SOURCES, required: true, index: true },

    agentId: { type: String, default: null, index: true },
    agentSlug: { type: String, default: null },
    model: { type: String, required: true, index: true },

    // --- Jerarquia de atribucion: company > property > usuario ---
    companyId: { type: String, required: true, index: true },
    propertyId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    userRole: { type: String, default: null },

    // --- Correlacion con la conversacion de origen ---
    conversationId: { type: String, default: null },
    sessionId: { type: String, default: null },
    turnIndex: { type: Number, default: null },

    // --- Metricas del turno ---
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    toolCallCount: { type: Number, default: 0 },

    occurredAt: { type: Date, required: true, index: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "usage_records", versionKey: false },
);

usageRecordSchema.index({ companyId: 1, occurredAt: -1 });
usageRecordSchema.index({ companyId: 1, propertyId: 1, userId: 1, occurredAt: -1 });
usageRecordSchema.index({ companyId: 1, source: 1, occurredAt: -1 });

export type UsageRecordDoc = InferSchemaType<typeof usageRecordSchema>;
export const UsageRecord = model("UsageRecord", usageRecordSchema);

/**
 * UsageDailyRollup: agregado pre-calculado por dia + cada dimension de la
 * jerarquia. Lo upserteamos con $inc en cada record para que los dashboards
 * (que filtran por rango de dias y agrupan por company/property/usuario) no
 * tengan que escanear el ledger crudo. `day` es "YYYY-MM-DD" en UTC.
 */
const usageDailyRollupSchema = new Schema(
  {
    day: { type: String, required: true },
    companyId: { type: String, required: true },
    propertyId: { type: String, default: DIM_NONE },
    userId: { type: String, default: DIM_NONE },
    agentId: { type: String, default: DIM_NONE },
    source: { type: String, default: DIM_NONE },
    model: { type: String, default: DIM_NONE },

    turns: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMsSum: { type: Number, default: 0 },
    toolCallCount: { type: Number, default: 0 },

    updatedAt: { type: Date, default: () => new Date() },
  },
  { collection: "usage_daily_rollups", versionKey: false },
);

// Granularidad maxima del rollup: cada combinacion unica es una fila.
usageDailyRollupSchema.index(
  {
    day: 1,
    companyId: 1,
    propertyId: 1,
    userId: 1,
    agentId: 1,
    source: 1,
    model: 1,
  },
  { unique: true },
);
usageDailyRollupSchema.index({ companyId: 1, day: 1 });

export type UsageDailyRollupDoc = InferSchemaType<typeof usageDailyRollupSchema>;
export const UsageDailyRollup = model(
  "UsageDailyRollup",
  usageDailyRollupSchema,
);

export function sanitize(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}
