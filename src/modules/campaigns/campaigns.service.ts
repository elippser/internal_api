import { makeId } from "../../shared/utils/ids";
import { MktAccount, MktContact, MktEvent, sanitizeDoc } from "../crm/crm.model";
import { segmentsService } from "../crm/segments.service";
import {
  MktCampaign,
  MktConversation,
  MktMessage,
  MktTemplate,
  sanitize,
  type Channel,
} from "./campaigns.model";
import { getProvider } from "./providers";

interface HttpError extends Error {
  status: number;
  code?: string;
}
function httpError(status: number, message: string, code?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

const MAX_SEND_ATTEMPTS = 3;

/**
 * Interpolacion de `{{campo}}` con los datos del destinatario. Deliberadamente
 * tonta: sin condicionales ni loops. Un lenguaje de plantillas completo en un
 * campo de texto editable desde el panel es una superficie de ejecucion que no
 * hace falta para mandar un mail de bienvenida.
 */
export function renderTemplate(
  text: string,
  vars: Record<string, unknown>,
): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const val = key
      .split(".")
      .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], vars);
    return val === undefined || val === null ? "" : String(val);
  });
}

export const campaignsService = {
  // ---------- Templates ----------

  async listTemplates(channel?: Channel) {
    const q = channel ? { channel } : {};
    const rows = await MktTemplate.find(q).sort({ createdAt: -1 }).lean();
    return rows.map(sanitize);
  },

  async createTemplate(input: Record<string, any>) {
    const doc = await MktTemplate.create({ ...input, templateId: makeId("tpl") });
    return sanitize(doc.toObject());
  },

  async updateTemplate(templateId: string, patch: Record<string, any>) {
    const doc = await MktTemplate.findOneAndUpdate(
      { templateId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Template no encontrado", "not_found");
    return sanitize(doc);
  },

  async deleteTemplate(templateId: string) {
    const used = await MktCampaign.countDocuments({
      templateId,
      status: { $in: ["scheduled", "sending"] },
    });
    if (used > 0) {
      throw httpError(400, "Hay campañas en curso usando este template", "in_use");
    }
    const res = await MktTemplate.deleteOne({ templateId });
    if (res.deletedCount === 0) {
      throw httpError(404, "Template no encontrado", "not_found");
    }
    return { deleted: true };
  },

  // ---------- Campañas ----------

  async listCampaigns() {
    const rows = await MktCampaign.find().sort({ createdAt: -1 }).lean();
    return rows.map(sanitize);
  },

  async getCampaign(campaignId: string) {
    const c = await MktCampaign.findOne({ campaignId }).lean();
    if (!c) throw httpError(404, "Campaña no encontrada", "not_found");
    const messages = await MktMessage.find({ campaignId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return { ...sanitize(c), messages: messages.map(sanitize) };
  },

  async createCampaign(input: Record<string, any>, userId: string) {
    const doc = await MktCampaign.create({
      ...input,
      campaignId: makeId("cmp"),
      createdByUserId: userId,
    });
    return sanitize(doc.toObject());
  },

  async updateCampaign(campaignId: string, patch: Record<string, any>) {
    const doc = await MktCampaign.findOneAndUpdate(
      { campaignId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Campaña no encontrada", "not_found");
    return sanitize(doc);
  },

  /**
   * Encola la campaña: un mensaje por contacto del segmento que tenga optIn del
   * canal. No manda nada — de eso se ocupa el worker de la cola.
   */
  async sendCampaign(campaignId: string) {
    const campaign = await MktCampaign.findOne({ campaignId });
    if (!campaign) throw httpError(404, "Campaña no encontrada", "not_found");
    if (campaign.status === "sending" || campaign.status === "sent") {
      throw httpError(400, "La campaña ya se envio", "already_sent");
    }

    const template = await MktTemplate.findOne({
      templateId: campaign.templateId,
    }).lean();
    if (!template) throw httpError(400, "El template ya no existe", "no_template");

    const recipients = await segmentsService.resolveRecipients(
      campaign.segmentId,
      template.channel as Channel,
    );

    const accountIds = [...new Set(recipients.map((c: any) => c.accountId))];
    const accounts = await MktAccount.find({ accountId: { $in: accountIds } }).lean();
    const accountsById = new Map(accounts.map((a) => [a.accountId, a]));

    const sendAfter = new Date(
      Date.now() + (template.delayHours ?? 0) * 3_600_000,
    );

    let queued = 0;
    for (const contact of recipients as any[]) {
      const account = accountsById.get(contact.accountId);
      const vars = {
        contact,
        account,
        firstName: contact.firstName ?? "",
        accountName: account?.name ?? "",
      };

      try {
        await MktMessage.create({
          messageId: makeId("msg"),
          channel: template.channel,
          contactId: contact.contactId,
          accountId: contact.accountId,
          campaignId,
          templateId: template.templateId,
          // Una campaña le manda a cada contacto UNA vez, aunque se dispare dos.
          idempotencyKey: `${campaignId}:${contact.contactId}`,
          to: template.channel === "email" ? contact.email : contact.phone,
          subject: renderTemplate(template.subject ?? "", vars),
          body: renderTemplate(template.bodyHtml ?? "", vars),
          sendAfter,
        });
        queued++;
      } catch (err: any) {
        // 11000 = clave duplicada: ya estaba encolado. No es un error.
        if (err?.code !== 11000) throw err;
      }
    }

    campaign.set("status", "sending");
    campaign.set("stats.queued", queued);
    await campaign.save();

    return { campaignId, recipients: recipients.length, queued };
  },

  // ---------- Cola ----------

  /**
   * Manda lo que este vencido. Cada mensaje se resuelve solo: uno que falla no
   * frena a los demas y se reintenta hasta `MAX_SEND_ATTEMPTS`.
   */
  async processQueue(limit = 100) {
    const due = await MktMessage.find({
      status: "queued",
      sendAfter: { $lte: new Date() },
    })
      .sort({ sendAfter: 1 })
      .limit(limit);

    let sent = 0;
    let failed = 0;

    for (const msg of due) {
      const provider = getProvider(msg.channel as Channel);
      try {
        const template = msg.templateId
          ? await MktTemplate.findOne({ templateId: msg.templateId }).lean()
          : null;

        const result = await provider.send({
          to: msg.to,
          subject: msg.subject,
          body: msg.body,
          templateName: template?.waTemplateName ?? undefined,
        });

        msg.set("status", "sent");
        msg.set("sentAt", new Date());
        msg.set("providerMessageId", result.providerMessageId);
        msg.set("provider", result.provider);
        msg.set("error", undefined);
        await msg.save();
        sent++;

        if (msg.campaignId) {
          await MktCampaign.updateOne(
            { campaignId: msg.campaignId },
            { $inc: { "stats.sent": 1 } },
          );
        }
      } catch (err: any) {
        const attempts = (msg.attempts ?? 0) + 1;
        msg.set("attempts", attempts);
        msg.set("error", String(err?.message ?? err).slice(0, 500));
        if (attempts >= MAX_SEND_ATTEMPTS) {
          msg.set("status", "failed");
          if (msg.campaignId) {
            await MktCampaign.updateOne(
              { campaignId: msg.campaignId },
              { $inc: { "stats.failed": 1 } },
            );
          }
        } else {
          // Reintento con backoff lineal: 5min, 10min.
          msg.set("sendAfter", new Date(Date.now() + attempts * 5 * 60_000));
        }
        await msg.save();
        failed++;
      }
    }

    // Una campaña sin nada pendiente pasa a "sent".
    const sending = await MktCampaign.find({ status: "sending" });
    for (const c of sending) {
      const pending = await MktMessage.countDocuments({
        campaignId: c.campaignId,
        status: "queued",
      });
      if (pending === 0) {
        c.set("status", "sent");
        await c.save();
      }
    }

    return { processed: due.length, sent, failed };
  },

  /**
   * Encola los mensajes de los templates que reaccionan a un evento. Lo llama
   * el drenado del outbox del CRM.
   */
  async enqueueForEvent(event: {
    eventId: string;
    type: string;
    accountId?: string | null;
    correlationId: string;
  }) {
    if (!event.accountId) return { queued: 0 };

    const templates = await MktTemplate.find({
      trigger: event.type,
      active: true,
    }).lean();
    if (templates.length === 0) return { queued: 0 };

    const account = await MktAccount.findOne({ accountId: event.accountId }).lean();
    if (!account) return { queued: 0 };

    let queued = 0;
    for (const template of templates) {
      const channel = template.channel as Channel;
      const contacts = await MktContact.find({
        accountId: event.accountId,
        unsubscribedAt: { $exists: false },
        [`optIn.${channel}`]: true,
        ...(channel === "whatsapp" ? { phone: { $exists: true, $ne: "" } } : {}),
      }).lean();

      for (const contact of contacts) {
        const vars = {
          contact,
          account,
          firstName: contact.firstName ?? "",
          accountName: account.name ?? "",
        };
        try {
          await MktMessage.create({
            messageId: makeId("msg"),
            channel,
            contactId: contact.contactId,
            accountId: event.accountId,
            templateId: template.templateId,
            triggerEventId: event.eventId,
            // El correlationId del evento + el template: si el outbox reprocesa
            // el mismo evento, no se manda de nuevo.
            idempotencyKey: `${event.correlationId}:${template.templateId}:${contact.contactId}`,
            to: channel === "email" ? contact.email : contact.phone,
            subject: renderTemplate(template.subject ?? "", vars),
            body: renderTemplate(template.bodyHtml ?? "", vars),
            sendAfter: new Date(Date.now() + (template.delayHours ?? 0) * 3_600_000),
          });
          queued++;
        } catch (err: any) {
          if (err?.code !== 11000) throw err;
        }
      }
    }

    return { queued };
  },

  async listMessages(input: {
    status?: string;
    channel?: Channel;
    campaignId?: string;
    page: number;
    limit: number;
    skip: number;
  }) {
    const q: Record<string, unknown> = {};
    if (input.status) q.status = input.status;
    if (input.channel) q.channel = input.channel;
    if (input.campaignId) q.campaignId = input.campaignId;

    const [rows, total] = await Promise.all([
      MktMessage.find(q).sort({ createdAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      MktMessage.countDocuments(q),
    ]);
    return { data: rows.map(sanitize), total, page: input.page, limit: input.limit };
  },

  // ---------- Inbox de WhatsApp ----------

  async listConversations(status?: string) {
    const q = status ? { status } : {};
    const rows = await MktConversation.find(q).sort({ lastMessageAt: -1 }).limit(200).lean();
    return rows.map(sanitize);
  },

  async getConversation(conversationId: string) {
    const c = await MktConversation.findOne({ conversationId }).lean();
    if (!c) throw httpError(404, "Conversacion no encontrada", "not_found");
    return sanitize(c);
  },

  /** Mensaje entrante del webhook de Meta. Crea la conversacion si no existia. */
  async receiveInbound(input: {
    phone: string;
    content: string;
    providerMessageId?: string;
  }) {
    const contact = await MktContact.findOne({ phone: input.phone }).lean();
    let conv = await MktConversation.findOne({ phone: input.phone });

    if (!conv) {
      conv = new MktConversation({
        conversationId: makeId("conv"),
        phone: input.phone,
        contactId: contact?.contactId,
        accountId: contact?.accountId,
      });
    }

    conv.messages.push({
      direction: "inbound",
      content: input.content,
      status: "received",
      providerMessageId: input.providerMessageId,
      at: new Date(),
    } as never);

    conv.set("lastMessageAt", new Date());
    // Se reabre la ventana de 24hs de Meta y se pide atencion humana: no hay
    // bot todavia, asi que todo entrante necesita a alguien.
    conv.set("windowExpiresAt", new Date(Date.now() + 24 * 3_600_000));
    conv.set("status", "needs_human");
    await conv.save();

    return sanitize(conv.toObject());
  },

  /** Respuesta manual desde el inbox. */
  async replyConversation(conversationId: string, content: string) {
    const conv = await MktConversation.findOne({ conversationId });
    if (!conv) throw httpError(404, "Conversacion no encontrada", "not_found");

    const provider = getProvider("whatsapp");
    const outsideWindow =
      !conv.windowExpiresAt || conv.windowExpiresAt.getTime() < Date.now();

    const result = await provider.send({
      to: conv.phone,
      body: content,
      // Fuera de la ventana de 24hs Meta exige un template aprobado.
      templateName: outsideWindow ? process.env.MKT_WA_FALLBACK_TEMPLATE : undefined,
    });

    conv.messages.push({
      direction: "outbound",
      content,
      status: "sent",
      providerMessageId: result.providerMessageId,
      at: new Date(),
    } as never);
    conv.set("lastMessageAt", new Date());
    conv.set("status", "open");
    await conv.save();

    return sanitize(conv.toObject());
  },

  async setConversationStatus(conversationId: string, status: string) {
    const doc = await MktConversation.findOneAndUpdate(
      { conversationId },
      { $set: { status } },
      { new: true },
    ).lean();
    if (!doc) throw httpError(404, "Conversacion no encontrada", "not_found");
    return sanitize(doc);
  },

  /** Resumen para el tablero. */
  async stats() {
    const [byStatus, campaigns, conversations] = await Promise.all([
      MktMessage.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      MktCampaign.countDocuments(),
      MktConversation.countDocuments({ status: "needs_human" }),
    ]);
    return {
      messages: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
      campaigns,
      conversationsNeedingHuman: conversations,
    };
  },
};

/** Reexport para el consumer del outbox del CRM. */
export { MktEvent, sanitizeDoc };
