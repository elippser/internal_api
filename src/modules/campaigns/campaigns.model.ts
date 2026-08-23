import { Schema, model, type InferSchemaType } from "mongoose";
import { MKT_EVENT_TYPES } from "../crm/crm.model";

export const CHANNELS = ["email", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export const TEMPLATE_TRIGGERS = [...MKT_EVENT_TYPES, "manual"] as const;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const templateSchema = new Schema(
  {
    templateId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true, index: true },
    /** `manual` = solo para campañas; el resto dispara solo con ese evento. */
    trigger: { type: String, enum: TEMPLATE_TRIGGERS, default: "manual", index: true },
    subject: { type: String, default: "" },
    bodyHtml: { type: String, default: "" },
    /** Espera antes de mandar. Un pedido de review a los 0hs del alta molesta. */
    delayHours: { type: Number, default: 0, min: 0 },
    /** Nombre del template aprobado en Meta. Solo aplica a whatsapp. */
    waTemplateName: { type: String, required: false },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: "mkt_templates" },
);

export type MktTemplateDoc = InferSchemaType<typeof templateSchema>;
export const MktTemplate = model("MktTemplate", templateSchema);

// ---------------------------------------------------------------------------
// Campañas
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

const campaignSchema = new Schema(
  {
    campaignId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    segmentId: { type: String, required: true, index: true },
    templateId: { type: String, required: true, index: true },
    scheduledAt: { type: Date, required: false },
    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: "draft",
      index: true,
    },
    stats: {
      _id: false,
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
    },
    createdByUserId: { type: String, default: "system" },
  },
  { timestamps: true, collection: "mkt_campaigns" },
);

export type MktCampaignDoc = InferSchemaType<typeof campaignSchema>;
export const MktCampaign = model("MktCampaign", campaignSchema);

// ---------------------------------------------------------------------------
// Mensajes — es tambien la cola de envio
// ---------------------------------------------------------------------------

export const MESSAGE_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const messageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true, index: true },
    channel: { type: String, enum: CHANNELS, required: true, index: true },
    contactId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    campaignId: { type: String, required: false, index: true },
    templateId: { type: String, required: false },
    triggerEventId: { type: String, required: false },

    /**
     * Idempotencia del envio. Un trigger que se reprocesa (porque el outbox
     * reintenta) no puede mandar el mismo mail dos veces a la misma persona.
     */
    idempotencyKey: { type: String, required: true, unique: true },

    to: { type: String, required: true },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },

    sendAfter: { type: Date, default: () => new Date(), index: true },
    status: { type: String, enum: MESSAGE_STATUSES, default: "queued", index: true },
    attempts: { type: Number, default: 0 },
    providerMessageId: { type: String, required: false },
    provider: { type: String, required: false },
    error: { type: String, required: false },
    sentAt: { type: Date, required: false },
    openedAt: { type: Date, required: false },
    clickedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_messages" },
);

// El barrido de la cola.
messageSchema.index({ status: 1, sendAfter: 1 });

export type MktMessageDoc = InferSchemaType<typeof messageSchema>;
export const MktMessage = model("MktMessage", messageSchema);

// ---------------------------------------------------------------------------
// Conversaciones de WhatsApp (inbox)
// ---------------------------------------------------------------------------

const waMessageSchema = new Schema(
  {
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    content: { type: String, default: "" },
    templateName: { type: String, required: false },
    status: { type: String, default: "sent" },
    providerMessageId: { type: String, required: false },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

export const CONVERSATION_STATUSES = ["open", "closed", "needs_human"] as const;

const conversationSchema = new Schema(
  {
    conversationId: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: false, index: true },
    contactId: { type: String, required: false, index: true },
    phone: { type: String, required: true, index: true },
    messages: { type: [waMessageSchema], default: [] },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "open",
      index: true,
    },
    lastMessageAt: { type: Date, default: () => new Date(), index: true },
    /**
     * Meta solo deja mandar texto libre dentro de las 24hs del ultimo mensaje
     * del contacto. Fuera de esa ventana hay que usar un template aprobado.
     */
    windowExpiresAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_conversations" },
);

export type MktConversationDoc = InferSchemaType<typeof conversationSchema>;
export const MktConversation = model("MktConversation", conversationSchema);

export function sanitize<T>(doc: T): T {
  if (!doc) return doc;
  const obj =
    doc && typeof doc === "object" && "toObject" in (doc as object)
      ? (doc as unknown as { toObject: () => Record<string, unknown> }).toObject()
      : (doc as unknown as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}
