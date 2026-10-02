import { Schema, model } from "mongoose";

/**
 * Etiquetas de cada pregunta que un usuario le hizo a Roombir IA
 * (USABILIDAD-SPEC.md §6). Una por mensaje de usuario.
 *
 * NO copia el texto original: guarda la pregunta REESCRITA por el modelo,
 * generica y sin nombres, numeros de reserva ni montos (y ademas pasada por un
 * filtro de datos de contacto). El original sigue viviendo solo en
 * conversation_messages.
 */

export const IA_TOPICS = [
  "reservas",
  "tarifas",
  "disponibilidad",
  "habitaciones",
  "huespedes",
  "sitio-web",
  "marketing",
  "reportes",
  "configuracion",
  "pagos",
  "la-ia",
  "otro",
] as const;

export const IA_INTENTS = ["consultar", "accion", "aprender", "problema", "charla"] as const;
export const IA_RESOLVED = ["si", "parcial", "no", "no-se-sabe"] as const;

/** Version del prompt/taxonomia: cambiarla re-etiqueta lo viejo (a pedido). */
export const IA_LABEL_VERSION = 1;

const RETENTION_MS = 548 * 86_400_000;

const iaLabelSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true, index: true },
    companyId: { type: String, default: null, index: true },
    userId: { type: String, default: null },
    channel: { type: String, default: null },
    /** Dia civil UTC y hora/dia de semana UTC del mensaje. */
    day: { type: String, required: true, index: true },
    hourUtc: { type: Number, required: true },
    dowUtc: { type: Number, required: true },

    // ── Señales sin modelo ──────────────────────────────────────────────────
    lang: { type: String, default: null },
    length: { type: Number, default: 0 },
    /** Repregunto lo mismo en ≤ 2 min: la respuesta anterior no sirvio. */
    rephrase: { type: Boolean, default: false },
    vote: { type: String, enum: ["up", "down", null], default: null },
    toolCount: { type: Number, default: 0 },
    toolErrors: { type: Number, default: 0 },

    // ── Etiquetas del modelo ────────────────────────────────────────────────
    llm: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    topic: { type: String, enum: [...IA_TOPICS, null], default: null },
    intent: { type: String, enum: [...IA_INTENTS, null], default: null },
    resolved: { type: String, enum: [...IA_RESOLVED, null], default: null },
    frustration: { type: Number, min: 0, max: 2, default: null },
    question: { type: String, default: null },
    missingCapability: { type: String, default: null },
    labelVersion: { type: Number, default: IA_LABEL_VERSION },
    model: { type: String, default: null },
    labeledAt: { type: Date, default: () => new Date() },

    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { collection: "ia_message_labels", versionKey: false },
);
iaLabelSchema.index({ day: 1, companyId: 1 });
iaLabelSchema.index({ llm: 1, attempts: 1 });
iaLabelSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IaMessageLabel = model("IaMessageLabel", iaLabelSchema);
