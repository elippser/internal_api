import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { verifyUserToken } from "../conversations/services/pmsContextResolver";
import {
  SupportChatError,
  resolveAgent,
  resolvePmsIdentity,
  signUpload,
  signedFileUrl,
  supportChatAgentService,
  supportChatUserService,
  type PmsIdentity,
} from "./supportChat.service";
import { fileSchema, listSchema, messageSchema, pulseSchema, signSchema, syncSchema } from "./supportChat.validation";

function handleError(res: Response, err: unknown) {
  if (err instanceof SupportChatError) return fail(res, err.status, err.message, err.code);
  console.error("[supportChat]", err);
  return fail(res, 500, "Error interno del chat de soporte", "support_chat_error");
}

// ---------------------------------------------------------------------------
// Identidad del usuario del PMS
// ---------------------------------------------------------------------------

/**
 * El X-Internal-Secret prueba que el pedido viene del PMS; el usuario sale del
 * JWT reenviado en X-Pms-User-Token (firma verificada), nunca del body.
 */
function pmsUserId(req: Request): string | null {
  const raw = req.headers["x-pms-user-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  return verifyUserToken(token)?.userId ?? null;
}

// La identidad (nombre, compañía validada) cambia poco: se cachea un minuto
// para que el poll del chat no vaya a la base del PMS cada 3 segundos.
const identityCache = new Map<string, { at: number; value: PmsIdentity }>();
const IDENTITY_TTL_MS = 60_000;

async function identityFor(req: Request): Promise<PmsIdentity> {
  const userId = pmsUserId(req);
  if (!userId) throw new SupportChatError(401, "Usuario no identificado", "user_token_required");
  const companyId = String(req.body?.companyId || req.query.companyId || "");
  const propertyId = String(req.body?.propertyId || req.query.propertyId || "");
  const key = `${userId}|${companyId}|${propertyId}`;
  const hit = identityCache.get(key);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
  const value = await resolvePmsIdentity(userId, companyId, propertyId);
  identityCache.set(key, { at: Date.now(), value });
  if (identityCache.size > 2000) identityCache.clear();
  return value;
}

// ---------------------------------------------------------------------------
// Runtime: lo que llama el PMS
// ---------------------------------------------------------------------------

export const supportChatRuntimeController = {
  async list(req: Request, res: Response) {
    try {
      const identity = await identityFor(req);
      return ok(res, await supportChatUserService.list(identity.userId, identity.companyId));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async current(req: Request, res: Response) {
    try {
      const identity = await identityFor(req);
      const result = await supportChatUserService.current(identity.userId, identity.companyId);
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async sync(req: Request, res: Response) {
    const userId = pmsUserId(req);
    if (!userId) return fail(res, 401, "Usuario no identificado", "user_token_required");
    const { error, value } = syncSchema.validate(req.query, { allowUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await supportChatUserService.sync(userId, req.params.id, value.afterSeq));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async send(req: Request, res: Response) {
    const { error, value } = messageSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const identity = await identityFor(req);
      const result = await supportChatUserService.send(
        identity,
        { text: value.text, attachments: value.attachments, replyToMessageId: value.replyToMessageId || undefined },
        value.locale,
        value.newConversation,
      );
      return ok(res, result, 201);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async typing(req: Request, res: Response) {
    const userId = pmsUserId(req);
    if (!userId) return fail(res, 401, "Usuario no identificado", "user_token_required");
    try {
      await supportChatUserService.typing(userId, req.params.id);
      return ok(res, { ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async close(req: Request, res: Response) {
    try {
      const identity = await identityFor(req);
      return ok(res, await supportChatUserService.close(identity, req.params.id));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async sign(req: Request, res: Response) {
    const { error, value } = signSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const identity = await identityFor(req);
      return ok(res, signUpload(value.kind, identity.companyId));
    } catch (err) {
      return handleError(res, err);
    }
  },


  async file(req: Request, res: Response) {
    const userId = pmsUserId(req);
    if (!userId) return fail(res, 401, "Usuario no identificado", "user_token_required");
    const { error, value } = fileSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, { url: await signedFileUrl(value.url, userId) });
    } catch (err) {
      return handleError(res, err);
    }
  },
};

// ---------------------------------------------------------------------------
// Bandeja del equipo interno
// ---------------------------------------------------------------------------

export const supportChatAgentController = {
  async list(req: Request, res: Response) {
    const { error, value } = listSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const data = await supportChatAgentService.list(req.internalUser!.userId, value.filter, value.q, value.limit);
      return ok(res, { data });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async pulse(req: Request, res: Response) {
    const { error, value } = pulseSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await supportChatAgentService.pulse(req.internalUser!.userId, value.since));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async sync(req: Request, res: Response) {
    const { error, value } = syncSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await supportChatAgentService.sync(req.params.id, value.afterSeq, value.read));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async join(req: Request, res: Response) {
    try {
      const agent = await resolveAgent(req.internalUser!.userId);
      return ok(res, await supportChatAgentService.join(req.params.id, agent));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async send(req: Request, res: Response) {
    const { error, value } = messageSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const agent = await resolveAgent(req.internalUser!.userId);
      const result = await supportChatAgentService.send(req.params.id, agent, {
        text: value.text,
        attachments: value.attachments,
        replyToMessageId: value.replyToMessageId || undefined,
      });
      return ok(res, result, 201);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async typing(req: Request, res: Response) {
    try {
      await supportChatAgentService.typing(req.params.id, req.internalUser!.userId);
      return ok(res, { ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async close(req: Request, res: Response) {
    try {
      const agent = await resolveAgent(req.internalUser!.userId);
      return ok(res, await supportChatAgentService.close(req.params.id, agent));
    } catch (err) {
      return handleError(res, err);
    }
  },

  async sign(req: Request, res: Response) {
    const { error, value } = signSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, signUpload(value.kind, value.companyId || "internal"));
    } catch (err) {
      return handleError(res, err);
    }
  },


  async file(req: Request, res: Response) {
    const { error, value } = fileSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, { url: await signedFileUrl(value.url) });
    } catch (err) {
      return handleError(res, err);
    }
  },
};
