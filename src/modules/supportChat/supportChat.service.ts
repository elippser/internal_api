import { createHash } from "crypto";
import { getPmsConnection } from "../../shared/pmsDb";
import { makeId } from "../../shared/utils/ids";
import { InternalUser } from "../users/users.model";
import {
  SupportConversation,
  SupportMessage,
  sanitize,
  type AttachmentKind,
  type SupportSender,
  type SystemEvent,
} from "./supportChat.model";

export class SupportChatError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export interface AttachmentInput {
  kind: AttachmentKind;
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface MessageInput {
  text?: string;
  attachments?: AttachmentInput[];
  replyToMessageId?: string;
}

export interface PmsIdentity {
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string;
  companyId: string;
  companyName: string;
  propertyId: string;
  propertyName: string;
}

export interface AgentIdentity {
  agentId: string;
  agentName: string;
}

/** Ventana en la que "escribiendo…" sigue visible sin otro aviso. */
const TYPING_WINDOW_MS = 6_000;
const MAX_MESSAGES_PER_SYNC = 300;
const OPEN = ["waiting", "active"];

// ---------------------------------------------------------------------------
// Identidades
// ---------------------------------------------------------------------------

/**
 * Quién es el usuario del PMS y en qué compañía escribe. La compañía viene de
 * la cookie del PMS (la elige el cliente), así que se valida contra las
 * memberships del usuario: si no es suya se cae a la compañía activa del
 * usuario. Nombre y compañía se leen de la base del PMS; si no responde, el
 * chat sigue andando con lo que haya.
 */
export async function resolvePmsIdentity(
  userId: string,
  companyHint?: string,
  propertyHint?: string,
): Promise<PmsIdentity> {
  const identity: PmsIdentity = {
    userId,
    userName: "",
    userEmail: "",
    userAvatar: "",
    companyId: companyHint || "",
    companyName: "",
    propertyId: propertyHint || "",
    propertyName: "",
  };

  let db;
  try {
    db = (await getPmsConnection()).db;
  } catch (err) {
    console.warn("[supportChat] PMS DB no disponible:", err);
  }
  if (!db) {
    if (!identity.companyId) {
      throw new SupportChatError(400, "Compañía no identificada", "company_required");
    }
    return identity;
  }

  const user = await db.collection("users").findOne(
    { userId },
    {
      projection: {
        name: 1,
        email: 1,
        avatar: 1,
        memberships: 1,
        companyId: 1,
        activeCompany: 1,
        activeCompanyId: 1,
      },
    },
  );
  if (!user) throw new SupportChatError(401, "Usuario no encontrado", "user_not_found");

  identity.userName = String(user.name ?? "");
  identity.userEmail = String(user.email ?? "");
  identity.userAvatar = String(user.avatar ?? "");

  const memberCompanies = new Set<string>(
    [
      ...((user.memberships as Array<{ companyId?: string; status?: string }>) ?? [])
        .filter((m) => m?.companyId && m.status !== "invited")
        .map((m) => String(m.companyId)),
      user.companyId,
      user.activeCompany,
    ].filter(Boolean) as string[],
  );
  if (!identity.companyId || !memberCompanies.has(identity.companyId)) {
    identity.companyId = String(
      user.activeCompanyId || user.activeCompany || user.companyId || [...memberCompanies][0] || "",
    );
    identity.propertyId = "";
  }
  if (!identity.companyId) {
    throw new SupportChatError(400, "Compañía no identificada", "company_required");
  }

  const [company, property] = await Promise.all([
    db.collection("companies").findOne({ companyId: identity.companyId }, { projection: { name: 1 } }),
    identity.propertyId
      ? db
          .collection("properties")
          .findOne(
            { propertyId: identity.propertyId, companyId: identity.companyId },
            { projection: { name: 1 } },
          )
      : null,
  ]);
  identity.companyName = String(company?.name ?? "");
  if (property) identity.propertyName = String(property.name ?? "");
  else identity.propertyId = "";

  return identity;
}

export async function resolveAgent(userId: string): Promise<AgentIdentity> {
  const u = await InternalUser.findOne({ userId }, { firstName: 1, lastName: 1, email: 1 }).lean();
  const name = u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "";
  return { agentId: userId, agentName: name || u?.email || "Equipo Roombir" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KIND_PREVIEW: Record<AttachmentKind, string> = {
  image: "📷 Foto",
  video: "🎥 Video",
  audio: "🎵 Audio",
  voice: "🎤 Nota de voz",
  file: "📄 Archivo",
};

function previewOf(text: string, attachments: AttachmentInput[]): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, 140);
  const first = attachments[0];
  if (!first) return "";
  if (first.kind === "file" && first.name) return `📄 ${first.name}`.slice(0, 140);
  return KIND_PREVIEW[first.kind];
}

/**
 * Solo se aceptan adjuntos servidos por NUESTRA cuenta de Cloudinary. Sin esto
 * cualquiera podría meter un `javascript:` o un link a un sitio ajeno con
 * apariencia de archivo dentro de la bandeja del equipo.
 */
function assertOwnAttachments(attachments: AttachmentInput[]) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  for (const a of attachments) {
    const okPrefix = cloud
      ? a.url.startsWith(`https://res.cloudinary.com/${cloud}/`)
      : a.url.startsWith("https://res.cloudinary.com/");
    if (!okPrefix) {
      throw new SupportChatError(400, "Adjunto con origen no permitido", "invalid_attachment");
    }
  }
}

async function getConversation(conversationId: string) {
  const conv = await SupportConversation.findOne({ conversationId });
  if (!conv) throw new SupportChatError(404, "Conversación no encontrada", "not_found");
  return conv;
}

/**
 * Inserta un mensaje con el siguiente `seq` de la conversación. El incremento y
 * el resumen de la bandeja (último mensaje, no leídos) van en la misma
 * operación atómica.
 */
async function appendMessage(
  conversationId: string,
  from: SupportSender,
  author: { id: string; name: string },
  body: { text?: string; attachments?: AttachmentInput[]; replyToMessageId?: string; event?: SystemEvent },
) {
  const text = (body.text ?? "").trim();
  const attachments = body.attachments ?? [];

  let replyTo = null;
  if (body.replyToMessageId) {
    const original = await SupportMessage.findOne(
      { conversationId, messageId: body.replyToMessageId },
      { messageId: 1, from: 1, authorName: 1, text: 1, attachments: 1 },
    ).lean();
    if (original) {
      replyTo = {
        messageId: original.messageId,
        from: original.from,
        authorName: original.authorName,
        text: (original.text ?? "").slice(0, 200),
        kind: original.attachments?.[0]?.kind ?? "",
      };
    }
  }

  const now = new Date();
  const inc: Record<string, number> = { seq: 1 };
  if (from === "user") inc.unreadForAgent = 1;
  if (from === "agent") inc.unreadForUser = 1;

  const set: Record<string, unknown> = { lastMessageAt: now };
  if (from !== "system") {
    set.lastMessagePreview = previewOf(text, attachments);
    set.lastMessageFrom = from;
  }
  if (from === "user") set.userTypingAt = null;
  if (from === "agent") set.agentTypingAt = null;

  const conv = await SupportConversation.findOneAndUpdate(
    { conversationId },
    { $inc: inc, $set: set },
    { new: true },
  );
  if (!conv) throw new SupportChatError(404, "Conversación no encontrada", "not_found");

  // Quien escribe ya leyó todo lo anterior.
  if (from === "user" && conv.userReadSeq < conv.seq) {
    await SupportConversation.updateOne(
      { conversationId },
      { $set: { userReadSeq: conv.seq, unreadForUser: 0 } },
    );
    conv.userReadSeq = conv.seq;
    conv.unreadForUser = 0;
  }
  if (from === "agent" && conv.agentReadSeq < conv.seq) {
    await SupportConversation.updateOne(
      { conversationId },
      { $set: { agentReadSeq: conv.seq, unreadForAgent: 0 } },
    );
    conv.agentReadSeq = conv.seq;
    conv.unreadForAgent = 0;
  }

  const msg = await SupportMessage.create({
    messageId: makeId("smsg"),
    conversationId,
    seq: conv.seq,
    from,
    authorId: author.id,
    authorName: author.name,
    text,
    attachments,
    replyTo,
    event: body.event ?? null,
  });

  return { conversation: conv, message: msg };
}

function publicConversation(conv: any) {
  const c = sanitize(conv) as any;
  const now = Date.now();
  return {
    ...c,
    userTyping: Boolean(c.userTypingAt && now - new Date(c.userTypingAt).getTime() < TYPING_WINDOW_MS),
    agentTyping: Boolean(c.agentTypingAt && now - new Date(c.agentTypingAt).getTime() < TYPING_WINDOW_MS),
  };
}

async function messagesAfter(conversationId: string, afterSeq: number) {
  const docs = await SupportMessage.find({ conversationId, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .limit(MAX_MESSAGES_PER_SYNC)
    .lean();
  return docs.map((d) => sanitize(d));
}

async function markRead(conv: any, side: "user" | "agent") {
  if (side === "user" && (conv.userReadSeq < conv.seq || conv.unreadForUser > 0)) {
    await SupportConversation.updateOne(
      { conversationId: conv.conversationId },
      { $set: { userReadSeq: conv.seq, unreadForUser: 0 } },
    );
    conv.userReadSeq = conv.seq;
    conv.unreadForUser = 0;
  }
  if (side === "agent" && (conv.agentReadSeq < conv.seq || conv.unreadForAgent > 0)) {
    await SupportConversation.updateOne(
      { conversationId: conv.conversationId },
      { $set: { agentReadSeq: conv.seq, unreadForAgent: 0 } },
    );
    conv.agentReadSeq = conv.seq;
    conv.unreadForAgent = 0;
  }
}

function assertContent(input: MessageInput) {
  const text = (input.text ?? "").trim();
  const attachments = input.attachments ?? [];
  if (!text && attachments.length === 0) {
    throw new SupportChatError(400, "El mensaje está vacío", "empty_message");
  }
  assertOwnAttachments(attachments);
}

// ---------------------------------------------------------------------------
// Lado del usuario del PMS
// ---------------------------------------------------------------------------

export const supportChatUserService = {
  /** El caso más reciente del usuario en la compañía (abierto o el último cerrado). */
  async current(userId: string, companyId: string) {
    const conv = await SupportConversation.findOne({ userId, companyId }).sort({ createdAt: -1 });
    if (!conv) return { conversation: null, messages: [] };
    await markRead(conv, "user");
    const messages = await messagesAfter(conv.conversationId, Math.max(0, conv.seq - MAX_MESSAGES_PER_SYNC));
    return { conversation: publicConversation(conv), messages };
  },

  async sync(userId: string, conversationId: string, afterSeq: number) {
    const conv = await getConversation(conversationId);
    if (conv.userId !== userId) throw new SupportChatError(404, "Conversación no encontrada", "not_found");
    await markRead(conv, "user");
    const messages = conv.seq > afterSeq ? await messagesAfter(conversationId, afterSeq) : [];
    return { conversation: publicConversation(conv), messages };
  },

  /** Los casos del usuario en la compañía, el más reciente primero (columna de chats del PMS). */
  async list(userId: string, companyId: string) {
    const docs = await SupportConversation.find({ userId, companyId }).sort({ lastMessageAt: -1 }).limit(50);
    return { conversations: docs.map((d) => publicConversation(d)) };
  },

  /**
   * Manda un mensaje. Sin caso abierto en la compañía, abre uno nuevo en
   * `waiting` (el "Contactando con alguien del equipo…"). Con
   * `newConversation` ("Nuevo chat" del PMS) el caso abierto se cierra y se
   * arranca otro: un usuario tiene un solo caso abierto por compañía.
   */
  async send(identity: PmsIdentity, input: MessageInput, locale?: string, newConversation = false) {
    assertContent(input);
    let conv = await SupportConversation.findOne({
      userId: identity.userId,
      companyId: identity.companyId,
      status: { $in: OPEN },
    }).sort({ createdAt: -1 });

    if (conv && newConversation) {
      await supportChatUserService.close(identity, conv.conversationId);
      conv = null;
    }

    if (!conv) {
      conv = await SupportConversation.create({
        conversationId: makeId("sup"),
        status: "waiting",
        userId: identity.userId,
        userName: identity.userName,
        userEmail: identity.userEmail,
        userAvatar: identity.userAvatar,
        companyId: identity.companyId,
        companyName: identity.companyName,
        propertyId: identity.propertyId,
        propertyName: identity.propertyName,
        locale: locale || "es",
      });
    }

    const { conversation, message } = await appendMessage(
      conv.conversationId,
      "user",
      { id: identity.userId, name: identity.userName },
      input,
    );
    return { conversation: publicConversation(conversation), message: sanitize(message) };
  },

  async typing(userId: string, conversationId: string) {
    await SupportConversation.updateOne(
      { conversationId, userId, status: { $in: OPEN } },
      { $set: { userTypingAt: new Date() } },
    );
  },

  async close(identity: PmsIdentity, conversationId: string) {
    const conv = await getConversation(conversationId);
    if (conv.userId !== identity.userId) throw new SupportChatError(404, "Conversación no encontrada", "not_found");
    if (conv.status === "closed") return { conversation: publicConversation(conv) };
    await SupportConversation.updateOne(
      { conversationId },
      { $set: { status: "closed", closedAt: new Date(), closedBy: "user", userTypingAt: null, agentTypingAt: null } },
    );
    const { conversation } = await appendMessage(
      conversationId,
      "system",
      { id: identity.userId, name: identity.userName },
      { event: "closed" },
    );
    return { conversation: publicConversation(conversation) };
  },
};

// ---------------------------------------------------------------------------
// Lado del equipo interno
// ---------------------------------------------------------------------------

export type InboxFilter = "open" | "waiting" | "mine" | "closed" | "all";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const supportChatAgentService = {
  async list(agentId: string, filter: InboxFilter, q?: string, limit = 100) {
    const query: Record<string, unknown> = {};
    if (filter === "open") query.status = { $in: OPEN };
    if (filter === "waiting") query.status = "waiting";
    if (filter === "closed") query.status = "closed";
    if (filter === "mine") {
      query.agentId = agentId;
      query.status = { $in: OPEN };
    }
    if (q?.trim()) {
      const rx = new RegExp(escapeRegex(q.trim()), "i");
      query.$or = [
        { userName: rx },
        { userEmail: rx },
        { companyName: rx },
        { propertyName: rx },
        { lastMessagePreview: rx },
      ];
    }
    const docs = await SupportConversation.find(query).sort({ lastMessageAt: -1 }).limit(limit).lean();
    return docs.map(publicConversation);
  },

  /**
   * Lo que mira la campana de todo el panel cada pocos segundos. Barato: dos
   * conteos y, si hay `since`, los mensajes de usuarios posteriores.
   */
  async pulse(agentId: string, since?: Date) {
    // La hora se toma ANTES de consultar: un mensaje que entra mientras corren
    // las consultas sale en el próximo pulso (el cliente deduplica por id).
    const serverTime = new Date().toISOString();
    const [waiting, unreadAgg, mine, attention] = await Promise.all([
      SupportConversation.countDocuments({ status: "waiting" }),
      SupportConversation.aggregate<{ total: number; conversations: number }>([
        { $match: { status: { $in: OPEN }, unreadForAgent: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$unreadForAgent" }, conversations: { $sum: 1 } } },
      ]),
      SupportConversation.countDocuments({ agentId, status: { $in: OPEN }, unreadForAgent: { $gt: 0 } }),
      // Casos que piden a alguien: sin tomar, o con mensajes sin leer.
      SupportConversation.countDocuments({
        $or: [{ status: "waiting" }, { status: "active", unreadForAgent: { $gt: 0 } }],
      }),
    ]);

    let fresh: Array<Record<string, unknown>> = [];
    if (since) {
      const msgs = await SupportMessage.find({ from: "user", createdAt: { $gt: since } })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
      if (msgs.length) {
        const convs = await SupportConversation.find(
          { conversationId: { $in: [...new Set(msgs.map((m) => m.conversationId))] } },
          { conversationId: 1, userName: 1, companyName: 1, agentId: 1, status: 1 },
        ).lean();
        const byId = new Map(convs.map((c) => [c.conversationId, c]));
        fresh = msgs.map((m) => {
          const c = byId.get(m.conversationId);
          return {
            messageId: m.messageId,
            conversationId: m.conversationId,
            createdAt: m.createdAt,
            preview: previewOf(m.text ?? "", (m.attachments ?? []) as AttachmentInput[]),
            userName: c?.userName ?? m.authorName,
            companyName: c?.companyName ?? "",
            agentId: c?.agentId ?? null,
            status: c?.status ?? "waiting",
          };
        });
      }
    }

    return {
      serverTime,
      waiting,
      attention,
      unreadTotal: unreadAgg[0]?.total ?? 0,
      unreadConversations: unreadAgg[0]?.conversations ?? 0,
      mineUnread: mine,
      fresh,
    };
  },

  async sync(conversationId: string, afterSeq: number, markAsRead: boolean) {
    const conv = await getConversation(conversationId);
    if (markAsRead) await markRead(conv, "agent");
    const messages = conv.seq > afterSeq ? await messagesAfter(conversationId, afterSeq) : [];
    return { conversation: publicConversation(conv), messages };
  },

  /** Tomar el caso. Si lo tenía otra persona, pasa a quien lo toma. */
  async join(conversationId: string, agent: AgentIdentity) {
    const conv = await getConversation(conversationId);
    if (conv.agentId === agent.agentId && conv.status === "active") {
      return { conversation: publicConversation(conv) };
    }
    const wasClosed = conv.status === "closed";
    const hadOther = Boolean(conv.agentId && conv.agentId !== agent.agentId);
    await SupportConversation.updateOne(
      { conversationId },
      {
        $set: {
          status: "active",
          agentId: agent.agentId,
          agentName: agent.agentName,
          assignedAt: new Date(),
          closedAt: null,
          closedBy: null,
        },
      },
    );
    if (wasClosed) {
      await appendMessage(conversationId, "system", { id: agent.agentId, name: agent.agentName }, { event: "reopened" });
    }
    const { conversation } = await appendMessage(
      conversationId,
      "system",
      { id: agent.agentId, name: agent.agentName },
      { event: hadOther && !wasClosed ? "transferred" : "joined" },
    );
    return { conversation: publicConversation(conversation) };
  },

  async send(conversationId: string, agent: AgentIdentity, input: MessageInput) {
    assertContent(input);
    const conv = await getConversation(conversationId);
    // Escribir en un caso sin dueño (o ajeno, o cerrado) es tomarlo.
    if (conv.status !== "active" || conv.agentId !== agent.agentId) {
      await this.join(conversationId, agent);
    }
    const { conversation, message } = await appendMessage(
      conversationId,
      "agent",
      { id: agent.agentId, name: agent.agentName },
      input,
    );
    return { conversation: publicConversation(conversation), message: sanitize(message) };
  },

  async typing(conversationId: string, agentId: string) {
    await SupportConversation.updateOne(
      { conversationId, agentId, status: "active" },
      { $set: { agentTypingAt: new Date() } },
    );
  },

  async close(conversationId: string, agent: AgentIdentity) {
    const conv = await getConversation(conversationId);
    if (conv.status === "closed") return { conversation: publicConversation(conv) };
    await SupportConversation.updateOne(
      { conversationId },
      { $set: { status: "closed", closedAt: new Date(), closedBy: "agent", userTypingAt: null, agentTypingAt: null } },
    );
    const { conversation } = await appendMessage(
      conversationId,
      "system",
      { id: agent.agentId, name: agent.agentName },
      { event: "closed" },
    );
    return { conversation: publicConversation(conversation) };
  },
};

// ---------------------------------------------------------------------------
// Descarga de documentos
// ---------------------------------------------------------------------------

/**
 * La cuenta de Cloudinary tiene apagada la entrega de PDF y ZIP: la URL
 * pública de un PDF devuelve 401 aunque se suba como `raw` (Cloudinary lo
 * reconoce por el contenido). La API de descarga firmada sí lo entrega, así
 * que los documentos se abren por acá: se valida que el archivo sea de un
 * mensaje que el que pide puede ver y se devuelve una URL que vence en 10 min.
 *
 * `userId` presente = lo pide un usuario del PMS (solo sus conversaciones);
 * ausente = lo pide el equipo interno.
 */
export async function signedFileUrl(url: string, userId?: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new SupportChatError(503, "Los adjuntos no están configurados (Cloudinary)", "uploads_unavailable");
  }
  const m = new RegExp(`^https://res\\.cloudinary\\.com/${cloudName}/raw/upload/(?:v\\d+/)?(.+)$`).exec(url);
  if (!m) throw new SupportChatError(400, "Archivo no válido", "invalid_file");

  const msg = await SupportMessage.findOne({ "attachments.url": url }, { conversationId: 1 }).lean();
  if (!msg) throw new SupportChatError(404, "Archivo no encontrado", "not_found");
  if (userId) {
    const conv = await SupportConversation.findOne({ conversationId: msg.conversationId }, { userId: 1 }).lean();
    if (!conv || conv.userId !== userId) throw new SupportChatError(404, "Archivo no encontrado", "not_found");
  }

  const now = Math.floor(Date.now() / 1000);
  const params: Record<string, string | number> = {
    expires_at: now + 600,
    public_id: decodeURIComponent(m[1]),
    timestamp: now,
    type: "upload",
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const signature = createHash("sha1").update(canonical + apiSecret).digest("hex");
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_key: apiKey,
    signature,
  });
  return `https://api.cloudinary.com/v1_1/${cloudName}/raw/download?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Subida de adjuntos: firma para que el navegador suba DIRECTO a Cloudinary
// ---------------------------------------------------------------------------

/**
 * El archivo nunca pasa por esta API (Vercel corta los cuerpos en 4,5 MB): el
 * navegador sube a Cloudinary con esta firma. Lo que se firma es exactamente lo
 * que se manda (`folder` + `timestamp`); ver pms-core/app/src/lib/server/cloudinary.ts.
 *
 * Tipo de recurso: imágenes → `image`; video, audio y notas de voz → `video`
 * (Cloudinary trata el audio como video); el resto → `raw`. Los PDF van como
 * `raw` a propósito: como `image` la cuenta bloquea su entrega por defecto.
 */
export function signUpload(kind: AttachmentKind, companyId: string) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new SupportChatError(503, "Los adjuntos no están configurados (Cloudinary)", "uploads_unavailable");
  }
  const resourceType = kind === "image" ? "image" : kind === "file" ? "raw" : "video";
  // `use_filename` deja el nombre original (con extensión) en el public_id:
  // sin eso un PDF `raw` se bajaba como un archivo sin extensión.
  const params = {
    folder: `roombir/support/${companyId.replace(/[^\w-]/g, "") || "internal"}`,
    timestamp: Math.floor(Date.now() / 1000),
    unique_filename: "true",
    use_filename: "true",
  };
  const canonical = Object.entries(params)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signature = createHash("sha1").update(canonical + apiSecret).digest("hex");
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    fields: { ...params, api_key: apiKey, signature },
  };
}
