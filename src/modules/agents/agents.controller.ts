/**
 * Controlador del módulo DEPRECADO `/agents`.
 *
 * Sólo quedan lecturas. Los manejadores de escritura se BORRARON en vez de
 * dejarse inertes: el router ya devuelve 410 en esas rutas, y un controlador
 * que todavía expone `create()` invita a que alguien lo vuelva a cablear "por
 * un ratito" y reabra la doble fuente de verdad que la deprecación cerró.
 */
import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { listAnthropicModels } from "../../shared/utils/anthropicModels";
import { agentsService } from "./agents.service";
import { listAgentsSchema } from "./agents.validation";

export const agentsController = {
  /**
   * Modelos que provee la API de Anthropic. Se mantiene por compatibilidad; el
   * sucesor con capacidades reales por modelo es `/engine/system/models`.
   */
  async availableModels(_req: Request, res: Response) {
    try {
      const data = await listAnthropicModels();
      return ok(res, { data });
    } catch (err) {
      console.error("[agents] no se pudieron listar modelos:", err);
      return fail(
        res,
        502,
        "No se pudieron obtener los modelos de Anthropic",
        "models_unavailable",
      );
    }
  },

  async list(req: Request, res: Response) {
    const { error, value } = listAgentsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");

    const { page, limit, skip } = parsePagination(value);
    const result = await agentsService.list({
      status: value.status,
      channel: value.channel,
      search: value.search,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await agentsService.getById(req.params.id);
    if (!doc) return fail(res, 404, "Agente no encontrado", "not_found");
    return ok(res, doc);
  },

  /** Runtime (X-Internal-Secret): resuelve un agente por slug para el PMS. */
  async resolveBySlug(req: Request, res: Response) {
    const doc = await agentsService.resolveBySlug(req.params.slug);
    if (!doc) return fail(res, 404, "Agente no encontrado", "not_found");
    return ok(res, doc);
  },
};
