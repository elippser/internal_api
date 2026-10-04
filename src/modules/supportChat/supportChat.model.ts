import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Asistencia 24/7: chat en vivo entre un usuario del PMS y el equipo interno.
 *
 * Un documento de conversación = un caso. Nace `waiting` con el primer mensaje
 * del usuario, pasa a `active` cuando alguien del internal la toma y termina
 * `closed`. Un usuario tiene a lo sumo un caso abierto por compañía: si escribe
 * con uno abierto, el mensaje va a ese caso.
 *
 * Los mensajes llevan `seq`, un contador por conversación que se incrementa
 * atómico al insertar. Los dos lados sincronizan pidiendo `afterSeq`: con fechas
 * dos mensajes del mismo milisegundo podían perderse entre polls.
 */

export const SUPPORT_STATUSES = ["waiting", "active", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_SENDERS = ["user", "agent", "system"] as const;
export type SupportSender = (typeof SUPPORT_SENDERS)[number];

export const ATTACHMENT_KINDS = ["image", "video", "audio", "voice", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Eventos que se pintan como burbuja centrada ("Ana se unió a la conversación"). */
export const SYSTEM_EVENTS = ["joined", "closed", "reopened", "transferred"] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

const conversationSchema = new Schema(
  {
    conversationId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: SUPPORT_STATUSES, default: "waiting", index: true },

    // Quién escribe desde el PMS. Nombre/email/compañía se copian al crear el
    // caso para que la bandeja no tenga que ir a la base del PMS en cada poll.
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: "" },
    userEmail: { type: String, default: "" },
    userAvatar: { type: String, default: "" },
    companyId: { type: String, required: true, index: true },
    companyName: { type: String, default: "" },
    propertyId: { type: String, default: "" },
    propertyName: { type: String, default: "" },
    locale: { type: String, default: "es" },

    // Quién atiende desde el internal.
    agentId: { type: String, default: null, index: true },
    agentName: { type: String, default: "" },
    assignedAt: { type: Date, default: null },

    closedAt: { type: Date, default: null },
    closedBy: { type: String, enum: ["user", "agent", null], default: null },

    seq: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: () => new Date(), index: true },
    lastMessagePreview: { type: String, default: "" },
    lastMessageFrom: { type: String, enum: SUPPORT_SENDERS, default: "user" },
    // Mensajes del otro lado que todavía no se leyeron.
    unreadForAgent: { type: Number, default: 0 },
    unreadForUser: { type: Number, default: 0 },
    // Hasta qué seq leyó cada lado (para las tildes azules).
    userReadSeq: { type: Number, default: 0 },
    agentReadSeq: { type: Number, default: 0 },
    userTypingAt: { type: Date, default: null },
    agentTypingAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "support_conversations" },
);

conversationSchema.index({ status: 1, lastMessageAt: -1 });
conversationSchema.index({ userId: 1, companyId: 1, createdAt: -1 });

const attachmentSchema = new Schema(
  {
    kind: { type: String, enum: ATTACHMENT_KINDS, required: true },
    url: { type: String, required: true },
    name: { type: String, default: "" },
    mime: { type: String, default: "" },
    size: { type: Number, default: 0 },
    width: { type: Number },
    height: { type: Number },
    duration: { type: Number },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true },
    conversationId: { type: String, required: true },
    seq: { type: Number, required: true },
    from: { type: String, enum: SUPPORT_SENDERS, required: true },
    authorId: { type: String, default: "" },
    authorName: { type: String, default: "" },
    text: { type: String, default: "" },
    attachments: { type: [attachmentSchema], default: [] },
    replyTo: {
      type: new Schema(
        {
          messageId: String,
          from: String,
          authorName: String,
          text: String,
          kind: String,
        },
        { _id: false },
      ),
      default: null,
    },
    event: { type: String, enum: [...SYSTEM_EVENTS, null], default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "support_messages" },
);

messageSchema.index({ conversationId: 1, seq: 1 }, { unique: true });
// La campana del internal pregunta "¿qué escribieron los usuarios desde X?".
messageSchema.index({ from: 1, createdAt: -1 });

export type SupportConversationDoc = InferSchemaType<typeof conversationSchema>;
export type SupportMessageDoc = InferSchemaType<typeof messageSchema>;

export const SupportConversation = model("SupportConversation", conversationSchema);
export const SupportMessage = model("SupportMessage", messageSchema);

export function sanitize<T>(doc: T): T {
  if (!doc) return doc;
  const obj = (doc as any).toObject ? (doc as any).toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest as T;
}
