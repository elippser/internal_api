import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { feedbackService } from "./feedback.service";
import {
  createFeedbackSchema,
  listFeedbackSchema,
  updateFeedbackSchema,
} from "./feedback.validation";

export const feedbackController = {
  async list(req: Request, res: Response) {
    const { error, value } = listFeedbackSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { page, limit, skip } = parsePagination(value);
    const result = await feedbackService.list({
      status: value.status,
      category: value.category,
      agentId: value.agentId,
      companyId: value.companyId,
      userConfirmed: value.userConfirmed,
      dateFrom: value.dateFrom ? new Date(value.dateFrom) : undefined,
      dateTo: value.dateTo ? new Date(value.dateTo) : undefined,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await feedbackService.getById(req.params.id);
    if (!doc) return fail(res, 404, "Feedback no encontrado", "not_found");
    return ok(res, doc);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createFeedbackSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await feedbackService.create(value);
    return ok(res, doc, 201);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateFeedbackSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await feedbackService.updateStatus(req.params.id, value);
    if (!doc) return fail(res, 404, "Feedback no encontrado", "not_found");
    return ok(res, doc);
  },
};
