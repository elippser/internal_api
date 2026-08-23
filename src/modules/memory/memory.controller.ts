import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { memoryService } from "./memory.service";

export const memoryController = {
  async list(req: Request, res: Response) {
    const operativeSpaceId = String(req.query.operativeSpaceId ?? "");
    if (!operativeSpaceId) {
      return fail(res, 400, "operativeSpaceId requerido", "invalid_query");
    }
    const data = await memoryService.list(operativeSpaceId);
    return ok(res, { data });
  },

  async clear(req: Request, res: Response) {
    const operativeSpaceId = String(req.query.operativeSpaceId ?? "");
    if (!operativeSpaceId) {
      return fail(res, 400, "operativeSpaceId requerido", "invalid_query");
    }
    const deleted = await memoryService.clear(operativeSpaceId);
    return ok(res, { deleted });
  },

  async remove(req: Request, res: Response) {
    await memoryService.remove(req.params.memoryId);
    return ok(res, { ok: true });
  },
};
