import type { Request, Response } from "express";
import { ok, paginated, parsePagination } from "../../shared/utils/http";
import { engineAgentsService } from "./agents.service";
import {
  agentVersionSchema,
  createAgentSchema,
  updateAgentSchema,
  validate,
} from "./engine.validation";

export const engineAgentsController = {
  async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const result = await engineAgentsService.list({
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async getOne(req: Request, res: Response) {
    return ok(res, await engineAgentsService.getById(req.params.id));
  },

  async create(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(createAgentSchema, req.body);
    const agent = await engineAgentsService.create(payload, req.internalUser!.userId);
    return ok(res, agent, 201);
  },

  async update(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(updateAgentSchema, req.body);
    return ok(res, await engineAgentsService.update(req.params.id, payload));
  },

  async archive(req: Request, res: Response) {
    return ok(res, await engineAgentsService.archive(req.params.id));
  },

  // --- Versiones: el corazón del versionado inmutable ---------------------

  async createVersion(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(agentVersionSchema, req.body);
    const version = await engineAgentsService.createVersion(
      req.params.id,
      payload,
      req.internalUser!.userId,
      { activate: req.query.activate !== "false" },
    );
    return ok(res, version, 201);
  },

  async listVersions(req: Request, res: Response) {
    return ok(res, await engineAgentsService.listVersions(req.params.id));
  },

  async getVersion(req: Request, res: Response) {
    return ok(res, await engineAgentsService.getVersion(req.params.id, req.params.versionId));
  },

  /** Reversión: mover el puntero. No copia ni muta la versión destino. */
  async activateVersion(req: Request, res: Response) {
    return ok(res, await engineAgentsService.activateVersion(req.params.id, req.params.versionId));
  },

  async clone(req: Request, res: Response) {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      return res.status(422).json({ error: 'Falta "name" para el clon', code: "validation" });
    }
    return ok(res, await engineAgentsService.clone(req.params.id, name, req.internalUser!.userId), 201);
  },

  async exportOne(req: Request, res: Response) {
    return ok(res, await engineAgentsService.exportAgent(req.params.id));
  },
};
