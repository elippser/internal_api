import type { Request, Response } from "express";
import { ok, paginated, parsePagination } from "../../shared/utils/http";
import { subscribe } from "../../engine/events/bus";
import { PROTOCOL_VERSION, TERMINAL_EVENT } from "../../engine/events/protocol";
import { engineExecutionsService } from "./executions.service";
import {
  createExecutionSchema,
  listExecutionsSchema,
  resumeExecutionSchema,
  validate,
} from "./engine.validation";

/** Tope del modo síncrono. Por encima, un proxy corta la conexión igual. */
const SYNC_TIMEOUT_MS = 120_000;

export const engineExecutionsController = {
  /**
   * Encola. En modo síncrono retiene la petición hasta que la corrida deja de
   * esperar (no hasta que termina: ver `waitFor`).
   */
  async create(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(createExecutionSchema, req.body);
    const execution = await engineExecutionsService.create(payload);

    if (payload.responseMode !== "sync") {
      return ok(res, execution, 202);
    }

    const executionId = String((execution as Record<string, unknown>).executionId);
    const settled = await engineExecutionsService.waitFor(executionId, SYNC_TIMEOUT_MS);
    if (!settled) {
      // 202 y no 504: la corrida SIGUE VIVA y el cliente puede seguirla por
      // stream o sondeo. Un 504 sugeriría que se perdió.
      return ok(res, { ...execution, note: "La corrida sigue en curso; seguila por /stream" }, 202);
    }
    return ok(res, settled);
  },

  async list(req: Request, res: Response) {
    await validate(listExecutionsSchema, req.query);
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const result = await engineExecutionsService.list({
      agentId: req.query.agentId as string | undefined,
      status: req.query.status as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      userId: req.query.userId as string | undefined,
      parentExecutionId: req.query.parentExecutionId as string | undefined,
      trigger: req.query.trigger as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async getOne(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.getById(req.params.id));
  },

  async steps(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.steps(req.params.id));
  },

  async stepPayload(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.stepPayload(req.params.id, req.params.stepId));
  },

  async events(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.events(req.params.id));
  },

  async usage(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.usage(req.params.id));
  },

  async cancel(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.cancel(req.params.id));
  },

  async pause(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.pause(req.params.id));
  },

  async resume(req: Request, res: Response) {
    const payload = await validate<{ payload?: unknown }>(resumeExecutionSchema, req.body ?? {});
    return ok(res, await engineExecutionsService.resume(req.params.id, payload.payload));
  },

  async retry(req: Request, res: Response) {
    return ok(res, await engineExecutionsService.retry(req.params.id), 202);
  },

  async replay(req: Request, res: Response) {
    const useLatest = req.query.version === "latest";
    return ok(res, await engineExecutionsService.replayRun(req.params.id, useLatest), 202);
  },

  /**
   * Streaming por eventos servidos (SSE).
   *
   * SSE y no WebSocket para esta superficie por una razón práctica: el flujo es
   * unidireccional (servidor -> cliente), atraviesa proxies HTTP sin
   * configuración extra y se reconecta solo en el navegador. El contrato de
   * eventos es el mismo de §22, así que un transporte WebSocket se agrega sin
   * tocar productores ni consumidores.
   *
   * Se REENGANCHA sin reproducir: primero se manda el diario persistido (para
   * cubrir lo que pasó antes de conectarse) y después se suscribe al vivo. El
   * cliente deduplica por `seq`.
   */
  async stream(req: Request, res: Response) {
    const executionId = req.params.id;
    // Se valida el ámbito ANTES de abrir el stream: una vez enviados los
    // encabezados ya no se puede devolver un 404.
    const execution = await engineExecutionsService.getById(executionId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Sin esto, nginx bufferea la respuesta entera y el streaming no existe.
      "X-Accel-Buffering": "no",
    });

    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({ v: PROTOCOL_VERSION, type: "status", executionId, seq: 0, ts: new Date().toISOString(), data: { phase: "attached", status: (execution as Record<string, unknown>).status } });

    // Historial primero, en vivo después.
    try {
      for (const event of await engineExecutionsService.events(executionId)) send(event);
    } catch {
      /* el diario es mejor esfuerzo: sin él se sigue con el vivo */
    }

    const unsubscribe = subscribe(executionId, (event) => {
      send(event);
      if (event.type === TERMINAL_EVENT) {
        res.end();
      }
    });

    // Latido del transporte: sin tráfico, los balanceadores cortan la conexión
    // a los ~60s y el cliente cree que la corrida murió.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    keepAlive.unref();

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  },
};
