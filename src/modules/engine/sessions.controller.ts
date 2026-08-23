/**
 * Sesiones del motor (§9.2, familia "Sesiones").
 *
 * No hay POST de creación a propósito: las sesiones se acuñan implícitamente al
 * encolar una ejecución con `sessionId` o `externalKey` (§2). Lo que se expone
 * acá es lectura y borrado.
 *
 * El filtro por `origin` es el que hace usable la lista: sin él, los chats de
 * los usuarios quedan mezclados con las corridas de sub-agentes, de cron y de
 * consolidación, y la consola se vuelve ilegible a los tres días.
 */
import type { Request, Response } from "express";
import { NotFoundError } from "../../engine/core/errors";
import {
  EngineSession,
  EngineSessionMessage,
  sanitizeSession,
} from "../../engine/models/session.model";
import { scopedFilter } from "../../engine/repositories/base.repository";
import { ok, paginated, parsePagination } from "../../shared/utils/http";

export const engineSessionsController = {
  async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = {};
    if (req.query.agentId) filter.agentId = req.query.agentId;
    if (req.query.origin) filter.origin = req.query.origin;
    if (req.query.userId) filter.userId = req.query.userId;
    if (req.query.status) filter.status = req.query.status;

    const scoped = scopedFilter(filter);
    const [docs, total] = await Promise.all([
      EngineSession.find(scoped).sort({ lastActivityAt: -1 }).skip(skip).limit(limit).lean(),
      EngineSession.countDocuments(scoped),
    ]);

    return paginated(res, docs.map((d) => sanitizeSession(d)), total, page, limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await EngineSession.findOne(scopedFilter({ sessionId: req.params.id })).lean();
    if (!doc) throw new NotFoundError(`Sesión no encontrada: ${req.params.id}`);
    return ok(res, sanitizeSession(doc));
  },

  async messages(req: Request, res: Response) {
    const session = await EngineSession.findOne(
      scopedFilter({ sessionId: req.params.id }),
    ).lean();
    if (!session) throw new NotFoundError(`Sesión no encontrada: ${req.params.id}`);

    const docs = await EngineSessionMessage.find({ sessionId: req.params.id })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();

    return ok(
      res,
      docs.map((m) => ({
        messageId: m.messageId,
        role: m.role,
        content: m.content,
        executionId: m.executionId,
        createdAt: m.createdAt,
      })),
    );
  },

  async remove(req: Request, res: Response) {
    const session = await EngineSession.findOne(
      scopedFilter({ sessionId: req.params.id }),
    ).lean();
    if (!session) throw new NotFoundError(`Sesión no encontrada: ${req.params.id}`);

    // Los mensajes se borran con la sesión: sin ella son huérfanos que nadie
    // puede leer ni asociar a nada. Las EJECUCIONES no se tocan — son registro
    // histórico y su costo ya está contabilizado.
    await Promise.all([
      EngineSessionMessage.deleteMany({ sessionId: req.params.id }),
      EngineSession.deleteOne({ sessionId: req.params.id }),
    ]);

    return ok(res, { sessionId: req.params.id, deleted: true });
  },
};
