import { Router, type Request, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { CHANNELS, TEMPLATE_TRIGGERS } from "./campaigns.model";
import { campaignsService } from "./campaigns.service";

export const campaignsRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[campaigns]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

const templateSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  channel: Joi.string()
    .valid(...CHANNELS)
    .required(),
  trigger: Joi.string().valid(...TEMPLATE_TRIGGERS),
  subject: Joi.string().max(300).allow(""),
  bodyHtml: Joi.string().max(100_000).allow(""),
  delayHours: Joi.number().min(0).max(24 * 90),
  waTemplateName: Joi.string().max(120).allow(""),
  active: Joi.boolean(),
});

const campaignSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  segmentId: Joi.string().required(),
  templateId: Joi.string().required(),
  scheduledAt: Joi.date(),
});

// ---------------------------------------------------------------------------
// Webhook de WhatsApp — publico (lo llama Meta), va ANTES del authenticate.
// ---------------------------------------------------------------------------

/** Handshake de verificacion de Meta. */
campaignsRouter.get("/webhooks/whatsapp", (req: Request, res: Response) => {
  const verifyToken = process.env.MKT_WA_VERIFY_TOKEN;
  if (
    req.query["hub.mode"] === "subscribe" &&
    verifyToken &&
    req.query["hub.verify_token"] === verifyToken
  ) {
    return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  }
  return res.sendStatus(403);
});

/**
 * Entrantes. Siempre 200: Meta reintenta y termina desactivando el webhook si
 * ve errores, y un mensaje que no pudimos procesar no justifica eso.
 */
campaignsRouter.post("/webhooks/whatsapp", async (req: Request, res: Response) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          await campaignsService.receiveInbound({
            phone: msg.from,
            content: msg.text?.body ?? `[${msg.type}]`,
            providerMessageId: msg.id,
          });
        }
      }
    }
  } catch (err: any) {
    console.error("[campaigns] webhook whatsapp:", err?.message ?? err);
  }
});

// ---------------------------------------------------------------------------
// Operador interno
// ---------------------------------------------------------------------------

campaignsRouter.use(authenticate);

// ---------- Templates ----------

campaignsRouter.get(
  "/templates",
  authorize("analyst"),
  async (req: Request, res: Response) => {
    try {
      const channel = req.query.channel as any;
      return ok(res, { data: await campaignsService.listTemplates(channel) });
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.post(
  "/templates",
  authorize("developer"),
  async (req: Request, res: Response) => {
    const { error, value } = templateSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await campaignsService.createTemplate(value), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.patch(
  "/templates/:id",
  authorize("developer"),
  async (req: Request, res: Response) => {
    const { error, value } = templateSchema
      .fork(["name", "channel"], (s) => s.optional())
      .min(1)
      .validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await campaignsService.updateTemplate(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.delete(
  "/templates/:id",
  authorize("developer"),
  async (req: Request, res: Response) => {
    try {
      return ok(res, await campaignsService.deleteTemplate(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

// ---------- Mensajes / cola ----------

campaignsRouter.get(
  "/messages",
  authorize("analyst"),
  async (req: Request, res: Response) => {
    try {
      const { page, limit, skip } = parsePagination(req.query);
      const r = await campaignsService.listMessages({
        status: req.query.status as string,
        channel: req.query.channel as any,
        campaignId: req.query.campaignId as string,
        page,
        limit,
        skip,
      });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.post(
  "/queue/process",
  authorize("admin"),
  async (_req: Request, res: Response) => {
    try {
      return ok(res, await campaignsService.processQueue());
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.get(
  "/stats",
  authorize("analyst"),
  async (_req: Request, res: Response) => {
    try {
      return ok(res, await campaignsService.stats());
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

// ---------- Inbox ----------

campaignsRouter.get(
  "/conversations",
  authorize("support"),
  async (req: Request, res: Response) => {
    try {
      const data = await campaignsService.listConversations(
        req.query.status as string,
      );
      return ok(res, { data });
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.get(
  "/conversations/:id",
  authorize("support"),
  async (req: Request, res: Response) => {
    try {
      return ok(res, await campaignsService.getConversation(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.post(
  "/conversations/:id/reply",
  authorize("support"),
  async (req: Request, res: Response) => {
    const { error, value } = Joi.object({
      content: Joi.string().min(1).max(4000).required(),
    }).validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await campaignsService.replyConversation(req.params.id, value.content));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

campaignsRouter.patch(
  "/conversations/:id/status",
  authorize("support"),
  async (req: Request, res: Response) => {
    const { error, value } = Joi.object({
      status: Joi.string().valid("open", "closed", "needs_human").required(),
    }).validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(
        res,
        await campaignsService.setConversationStatus(req.params.id, value.status),
      );
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

// ---------- Campañas ----------

campaignsRouter.get("/", authorize("analyst"), async (_req: Request, res: Response) => {
  try {
    return ok(res, { data: await campaignsService.listCampaigns() });
  } catch (err) {
    return handleErr(res, err);
  }
});

campaignsRouter.post("/", authorize("developer"), async (req: Request, res: Response) => {
  const { error, value } = campaignSchema.validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    const userId = req.internalUser?.userId ?? "unknown";
    return ok(res, await campaignsService.createCampaign(value, userId), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

campaignsRouter.get("/:id", authorize("analyst"), async (req: Request, res: Response) => {
  try {
    return ok(res, await campaignsService.getCampaign(req.params.id));
  } catch (err) {
    return handleErr(res, err);
  }
});

campaignsRouter.patch(
  "/:id",
  authorize("developer"),
  async (req: Request, res: Response) => {
    const { error, value } = campaignSchema
      .fork(["name", "segmentId", "templateId"], (s) => s.optional())
      .min(1)
      .validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await campaignsService.updateCampaign(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);

// Enviar dispara envios reales: admin+.
campaignsRouter.post(
  "/:id/send",
  authorize("admin"),
  async (req: Request, res: Response) => {
    try {
      return ok(res, await campaignsService.sendCampaign(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },
);
