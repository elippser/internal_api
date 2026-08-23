import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { conversationsService } from "./conversations.service";
import {
  actionSchema,
  createSessionSchema,
  listConversationsSchema,
  postMessageSchema,
  rateMessageSchema,
} from "./conversations.validation";

interface HttpError extends Error {
  status?: number;
  code?: string;
}

function handleError(res: Response, err: unknown) {
  const e = err as HttpError;
  console.error("[conversations] error:", e);
  // El code viaja al cliente: las acciones de las cards distinguen un 403 de
  // permisos (insufficient_app_access, missing_capability…) de otros errores.
  return fail(res, e.status ?? 500, e.message ?? "Error interno", e.code);
}

export const conversationsController = {
  // ---------- runtime ----------

  async createSession(req: Request, res: Response) {
    const { error, value } = createSessionSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await conversationsService.createSession(value);
      return ok(res, result, 201);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async getSession(req: Request, res: Response) {
    try {
      const result = await conversationsService.getSession(req.params.id);
      if (!result) return fail(res, 404, "Sesion no encontrada", "not_found");
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async endSession(req: Request, res: Response) {
    try {
      const result = await conversationsService.endSession(req.params.id);
      if (!result) return fail(res, 404, "Sesion no encontrada", "not_found");
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async postMessage(req: Request, res: Response) {
    const { error, value } = postMessageSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await conversationsService.postMessage(
        req.params.id,
        value.content,
        value.attachments,
      );
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  // Variante streaming (SSE): emite eventos `step` con el status del turno
  // (qué está haciendo la IA), `delta` con el texto de la respuesta a medida
  // que el modelo lo escribe, `text_end` cuando ese texto queda cerrado como
  // segmento intermedio (el modelo pasa a ejecutar una herramienta; el cliente
  // lo deja fijo y sigue con un borrador nuevo) y al final un `message` con la
  // respuesta completa (content + agentMeta.trace) y un `done`. Mismo pipeline
  // que postMessage; solo cambia el transporte.
  async postMessageStream(req: Request, res: Response) {
    const { error, value } = postMessageSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // Heartbeat para que proxies no corten la conexión en turnos largos.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

    try {
      const result = await conversationsService.postMessage(
        req.params.id,
        value.content,
        value.attachments,
        {
          onStep: (step) => send("step", step),
          onDelta: (text) => send("delta", { text }),
          onTextEnd: () => send("text_end", {}),
        },
      );
      send("message", result);
      send("done", { ok: true });
    } catch (err) {
      const e = err as HttpError;
      console.error("[conversations] stream error:", e);
      send("error", { message: e.message ?? "Error interno", status: e.status ?? 500 });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  },

  async getCredits(req: Request, res: Response) {
    try {
      const companyId = (req.query.companyId as string) || undefined;
      const result = await conversationsService.getCredits(companyId);
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async downloadFile(req: Request, res: Response) {
    try {
      const { buffer, filename, contentType } =
        await conversationsService.fetchGeneratedFile(req.params.fileId);
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, "")}"`,
      );
      return res.send(buffer);
    } catch (err) {
      return handleError(res, err);
    }
  },

  // ---------- audit ----------

  async list(req: Request, res: Response) {
    const { error, value } = listConversationsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const result = await conversationsService.list(value);
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async listMessages(req: Request, res: Response) {
    try {
      const result = await conversationsService.listMessages(req.params.id);
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async executeAction(req: Request, res: Response) {
    const { error, value } = actionSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await conversationsService.executeAction(
        req.params.id,
        value.toolName,
        value.args,
      );
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },

  async rateMessage(req: Request, res: Response) {
    const { error, value } = rateMessageSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await conversationsService.rateMessage(
        req.params.id,
        req.params.messageId,
        value.rating,
        value.comment,
        value.userId,
      );
      return ok(res, result);
    } catch (err) {
      return handleError(res, err);
    }
  },
};
