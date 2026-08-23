import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { hotelsService } from "./hotels.service";
import { listActivitySchema, listHotelsSchema } from "./hotels.validation";

export const hotelsController = {
  async list(req: Request, res: Response) {
    const { error, value } = listHotelsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const result = await hotelsService.list(value);
      return ok(res, result);
    } catch (err) {
      return handle(res, err);
    }
  },

  async getOne(req: Request, res: Response) {
    try {
      const doc = await hotelsService.getById(req.params.id);
      if (!doc) return fail(res, 404, "Hotel no encontrado", "not_found");
      return ok(res, doc);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listProperties(req: Request, res: Response) {
    try {
      const docs = await hotelsService.listProperties(req.params.id);
      return ok(res, docs);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listActivity(req: Request, res: Response) {
    const { error, value } = listActivitySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const docs = await hotelsService.listActivity({
        companyId: req.params.id,
        limit: value.limit,
      });
      return ok(res, docs);
    } catch (err) {
      return handle(res, err);
    }
  },
};

function handle(res: Response, err: unknown) {
  console.error("[hotels] error:", err);
  const msg = err instanceof Error ? err.message : "Error interno";
  return fail(res, 502, `Fallo lectura del PMS: ${msg}`);
}
