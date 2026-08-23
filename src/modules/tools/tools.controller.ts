import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { toolsService } from "./tools.service";
import {
  createToolSchema,
  listToolsSchema,
  updateStatusSchema,
  updateToolSchema,
} from "./tools.validation";

export const toolsController = {
  async list(req: Request, res: Response) {
    const { error, value } = listToolsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { page, limit, skip } = parsePagination(value);
    const result = await toolsService.list({
      category: value.category,
      status: value.status,
      search: value.search,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createToolSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await toolsService.create(value);
      return ok(res, doc, 201);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return fail(res, status, (err as Error).message);
    }
  },

  async getOne(req: Request, res: Response) {
    const doc = await toolsService.getById(req.params.id);
    if (!doc) return fail(res, 404, "Tool no encontrada", "not_found");
    return ok(res, doc);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateToolSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await toolsService.update(req.params.id, value);
      if (!doc) return fail(res, 404, "Tool no encontrada", "not_found");
      return ok(res, doc);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return fail(res, status, (err as Error).message);
    }
  },

  async updateStatus(req: Request, res: Response) {
    const { error, value } = updateStatusSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await toolsService.updateStatus(req.params.id, value.status);
    if (!doc) return fail(res, 404, "Tool no encontrada", "not_found");
    return ok(res, doc);
  },
};
