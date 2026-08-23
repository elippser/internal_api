import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { usageService } from "./usage.service";
import { recordUsageSchema, usageRangeQuerySchema } from "./usage.validation";

function parseRange(query: Record<string, unknown>) {
  return {
    dateFrom: query.dateFrom ? new Date(String(query.dateFrom)) : undefined,
    dateTo: query.dateTo ? new Date(String(query.dateTo)) : undefined,
  };
}

function parseDims(query: Record<string, unknown>) {
  return {
    companyId: query.companyId ? String(query.companyId) : undefined,
    propertyId: query.propertyId ? String(query.propertyId) : undefined,
    userId: query.userId ? String(query.userId) : undefined,
    source: query.source ? String(query.source) : undefined,
    agentId: query.agentId ? String(query.agentId) : undefined,
    model: query.model ? String(query.model) : undefined,
  };
}

export const usageController = {
  // --- Ingestion (server-to-server, X-Internal-Secret) ---
  async record(req: Request, res: Response) {
    const { error, value } = recordUsageSchema.validate(req.body);
    if (error) {
      return fail(res, 400, error.message, "invalid_payload");
    }
    try {
      const doc = await usageService.record(value);
      return res.status(201).json({ usageId: doc.usageId, costUsd: doc.costUsd });
    } catch (err) {
      console.error("[usage] record fallo:", err);
      return fail(res, 500, "No se pudo registrar el consumo", "record_failed");
    }
  },

  // --- Reportes (auth interna: analyst+) ---
  async summary(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await usageService.summary(parseRange(value), parseDims(value));
    return ok(res, result);
  },

  async companies(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await usageService.byCompany(parseRange(value), parseDims(value));
    return ok(res, { data: result });
  },

  async companyDetail(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const companyId = req.params.companyId;
    const [summary, properties] = await Promise.all([
      usageService.summary(parseRange(value), { ...parseDims(value), companyId }),
      usageService.byProperty(companyId, parseRange(value), parseDims(value)),
    ]);
    return ok(res, { companyId, summary, properties });
  },

  async propertyDetail(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { companyId, propertyId } = req.params;
    const users = await usageService.byUser(
      companyId,
      propertyId,
      parseRange(value),
      parseDims(value),
    );
    return ok(res, { companyId, propertyId, users });
  },

  async userDetail(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { companyId, propertyId, userId } = req.params;
    const result = await usageService.userDetail(
      companyId,
      propertyId,
      userId,
      parseRange(value),
    );
    return ok(res, { companyId, propertyId, userId, ...result });
  },

  async models(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await usageService.byModel(parseRange(value), parseDims(value));
    return ok(res, { data: result });
  },

  async timeseries(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await usageService.timeseries(parseRange(value), parseDims(value));
    return ok(res, { data: result });
  },

  async records(req: Request, res: Response) {
    const { error, value } = usageRangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { page, limit, skip } = parsePagination(value);
    const result = await usageService.listRecords({
      ...parseRange(value),
      ...parseDims(value),
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },
};
