/**
 * `engine_sessions` + `engine_session_messages` — conversación (§6.4).
 *
 * Las sesiones se crean IMPLÍCITAMENTE durante la ejecución: no hay endpoint de
 * creación. Quien quiere una conversación manda una ejecución con un
 * `sessionId`; si no existe, se acuña. Es lo que permite que un canal externo
 * (un webhook de WhatsApp, un hilo de correo) mantenga continuidad sin tener
 * que orquestar dos llamadas y manejar la carrera entre ellas.
 *
 * `origin` existe para poder OCULTAR las conversaciones no humanas. Una consola
 * que mezcla los chats de los usuarios con las corridas de consolidación de
 * memoria y las de un cron es inusable a los tres días.
 */
import { Schema, model, type Model } from "mongoose";

export const SESSION_ORIGINS = [
  "api",
  "console",
  "webhook",
  "channel",
  "sub_agent",
  "consolidation",
  "cron",
] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

export interface EngineSessionDoc {
  sessionId: string;
  agentId: string;
  tenantId: string | null;
  userId?: string | null;
  /**
   * Clave del sistema externo (id de hilo de correo, teléfono, ticket). Única
   * por agente: es lo que hace que dos eventos del mismo hilo caigan en la
   * misma conversación en vez de abrir una nueva cada vez.
   */
  externalKey?: string | null;
  origin: SessionOrigin;
  title?: string | null;
  status: "active" | "ended";
  messageCount: number;
  /** Corrida en curso, para que la UI no encole dos turnos a la vez. */
  activeExecutionId?: string | null;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCostUsd: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<EngineSessionDoc>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    externalKey: { type: String, default: null },
    origin: { type: String, enum: SESSION_ORIGINS, default: "api", index: true },
    title: { type: String, default: null },
    status: { type: String, enum: ["active", "ended"], default: "active" },
    messageCount: { type: Number, default: 0 },
    activeExecutionId: { type: String, default: null },
    totalTokensInput: { type: Number, default: 0 },
    totalTokensOutput: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },
    lastActivityAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: "engine_sessions" },
);

sessionSchema.index(
  { agentId: 1, externalKey: 1 },
  { unique: true, partialFilterExpression: { externalKey: { $type: "string" } } },
);
sessionSchema.index({ tenantId: 1, lastActivityAt: -1 });

export const EngineSession: Model<EngineSessionDoc> = model<EngineSessionDoc>(
  "EngineSession",
  sessionSchema,
);

export interface EngineSessionMessageDoc {
  messageId: string;
  sessionId: string;
  agentId: string;
  tenantId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /**
   * Bloques crudos del proveedor. Se guardan para poder RECONSTRUIR el
   * transcripto de herramientas entre turnos: sin los pares tool_use /
   * tool_result, un turno siguiente que reenvíe el historial rompe el
   * emparejamiento que el proveedor exige.
   */
  blocks?: unknown;
  executionId?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt: Date;
}

const messageSchema = new Schema<EngineSessionMessageDoc>(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    agentId: { type: String, required: true },
    tenantId: { type: String, default: null },
    role: { type: String, enum: ["user", "assistant", "system", "tool"], required: true },
    content: { type: String, default: "" },
    blocks: { type: Schema.Types.Mixed, default: null },
    executionId: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "engine_session_messages" },
);

messageSchema.index({ sessionId: 1, createdAt: 1 });

export const EngineSessionMessage: Model<EngineSessionMessageDoc> =
  model<EngineSessionMessageDoc>("EngineSessionMessage", messageSchema);

export function sanitizeSession(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
