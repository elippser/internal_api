import { Schema, model, type InferSchemaType } from "mongoose";

export const SESSION_STATUSES = ["active", "ended", "expired"] as const;
export const MESSAGE_ROLES = ["user", "assistant", "tool_result"] as const;
export const TOOL_OUTCOMES = [
  "success",
  "error",
  "cancelled_by_user",
  "pending_confirmation",
] as const;
export const SESSION_CHANNELS = [
  "pms_app",
  "public_web",
  "widget",
  "internal",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];
export type SessionChannel = (typeof SESSION_CHANNELS)[number];

const contextSchema = new Schema(
  {
    userId: { type: String },
    companyId: { type: String, index: true },
    propertyId: { type: String, index: true },
    // Espacio operativo activo. Las conversaciones se comparten/agrupan por
    // este scope (todos los usuarios del mismo espacio ven y continuan).
    operativeSpaceId: { type: String, default: null, index: true },
    operativeSpaceName: { type: String },
    userRole: { type: String },
    channel: {
      type: String,
      enum: SESSION_CHANNELS,
      default: "internal",
      index: true,
    },
    // Campos enriquecidos del PMS, cacheados al crear sesion
    userName: { type: String },
    propertyName: { type: String },
    propertyType: { type: String },
    companyName: { type: String },
  },
  { _id: false },
);

const pendingConfirmationSchema = new Schema(
  {
    toolId: { type: String, required: true },
    toolName: { type: String, required: true },
    inputArgs: { type: Schema.Types.Mixed, default: {} },
    requestedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    context: { type: contextSchema, required: true },
    // Titulo legible para el sidebar (se autogenera del primer mensaje).
    title: { type: String, default: "" },
    status: {
      type: String,
      enum: SESSION_STATUSES,
      default: "active",
      index: true,
    },
    turnCount: { type: Number, default: 0 },
    pendingConfirmation: { type: pendingConfirmationSchema, default: null },
    feedbackRequestIds: { type: [String], default: [] },
    totalInputTokens: { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    startedAt: { type: Date, default: () => new Date() },
    lastActivityAt: { type: Date, default: () => new Date(), index: true },
    endedAt: { type: Date },
  },
  { timestamps: false, collection: "conversation_sessions" },
);

sessionSchema.index({ agentId: 1, status: 1 });
sessionSchema.index({ "context.companyId": 1, startedAt: -1 });
// Sidebar: conversaciones de un espacio operativo, mas recientes primero.
sessionSchema.index({ "context.operativeSpaceId": 1, lastActivityAt: -1 });

const ragChunkUsedSchema = new Schema(
  {
    chunkId: { type: String, required: true },
    documentId: { type: String, required: true },
    knowledgeBaseId: { type: String, required: true },
    score: { type: Number, required: true },
  },
  { _id: false },
);

const toolExecMetaSchema = new Schema(
  {
    toolId: { type: String, required: true },
    toolName: { type: String, required: true },
    inputArgs: { type: Schema.Types.Mixed, default: {} },
    outcome: { type: String, enum: TOOL_OUTCOMES, required: true },
    result: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
    durationMs: { type: Number, default: 0 },
    retried: { type: Boolean, default: false },
  },
  { _id: false },
);

// Ítem de la transcripción del turno (ver TurnTraceItem en conversationRunner):
// texto intermedio ("voy a consultar…") o herramienta ejecutada, en orden.
const traceItemSchema = new Schema(
  {
    kind: { type: String, enum: ["text", "tool"], required: true },
    text: { type: String },
    toolName: { type: String },
    label: { type: String },
    outcome: { type: String },
  },
  { _id: false },
);

const agentMetaSchema = new Schema(
  {
    ragChunksUsed: { type: [ragChunkUsedSchema], default: [] },
    toolsExecuted: { type: [toolExecMetaSchema], default: [] },
    // Transcripción ordenada del turno: textos intermedios + herramientas. La
    // respuesta de cierre sigue siendo `content`.
    trace: { type: [traceItemSchema], default: [] },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    // Prompt caching: tokens leídos del cache (~0.1x) y escritos (~1.25x).
    cacheReadInputTokens: { type: Number, default: 0 },
    cacheCreationInputTokens: { type: Number, default: 0 },
    // Archivos generados por la IA este turno (descargables vía Files API).
    generatedFiles: {
      type: [
        new Schema(
          {
            fileId: { type: String, required: true },
            filename: { type: String, default: "" },
            mediaType: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    // Fuentes web (links) consultadas vía web_search este turno.
    webSources: {
      type: [
        new Schema(
          {
            title: { type: String, default: "" },
            url: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    latencyMs: { type: Number, default: 0 },
    modelUsed: { type: String, default: "" },
    stopReason: { type: String, default: "" },
    // Sub-agente al que el router delego este turno (ver taskRouter/subAgents).
    subAgent: { type: String, default: "" },
    subAgentLabel: { type: String, default: "" },
    routedTier: { type: String, default: "" },
  },
  { _id: false },
);

const feedbackSchema = new Schema(
  {
    rating: { type: String, enum: ["up", "down"], required: true },
    comment: { type: String, default: "" },
    byUserId: { type: String, default: null },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    agentId: { type: String, required: true },
    role: { type: String, enum: MESSAGE_ROLES, required: true },
    content: { type: String, default: "" },
    agentMeta: { type: agentMetaSchema, default: null },
    // Retroalimentacion explicita del usuario sobre la respuesta del agente.
    feedback: { type: feedbackSchema, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "conversation_messages" },
);

messageSchema.index({ sessionId: 1, createdAt: 1 });

export type ConversationSessionDoc = InferSchemaType<typeof sessionSchema>;
export type ConversationMessageDoc = InferSchemaType<typeof messageSchema>;

export const ConversationSession = model(
  "ConversationSession",
  sessionSchema,
);
export const ConversationMessage = model(
  "ConversationMessage",
  messageSchema,
);

export function sanitizeSession(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

export function sanitizeMessage(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}
