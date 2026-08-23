import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { analyticsService } from "./analytics.service";
import {
  ingestBatchSchema,
  ingestEventSchema,
  rangeQuerySchema,
} from "./analytics.validation";

function parseRange(query: Record<string, unknown>) {
  return {
    dateFrom: query.dateFrom ? new Date(String(query.dateFrom)) : undefined,
    dateTo: query.dateTo ? new Date(String(query.dateTo)) : undefined,
  };
}

export const analyticsController = {
  /**
   * Ingesta. Acepta `{events:[...]}` (lo que manda el SDK bufferizado) o un
   * evento suelto (emisores server-side). Siempre 202: es telemetría, y un
   * error acá no puede romper el flujo de quien lo emitió.
   */
  async ingest(req: Request, res: Response) {
    const body = req.body as Record<string, unknown>;
    const isBatch = Array.isArray(body?.events);

    const { error, value } = isBatch
      ? ingestBatchSchema.validate(body)
      : ingestEventSchema.validate(body);

    if (error) {
      console.warn("[analytics] sobre invalido:", error.message);
      return res.status(202).json({ ok: true, accepted: 0 });
    }

    try {
      const events = isBatch ? value.events : [value];
      const result = await analyticsService.ingestBatch(events);
      return res.status(202).json({ ok: true, ...result });
    } catch (err) {
      console.error("[analytics] ingesta fallo:", err);
      return res.status(202).json({ ok: true, accepted: 0 });
    }
  },

  /** Salud de la ingesta: descartes por motivo y nombres desconocidos. */
  async health(_req: Request, res: Response) {
    return ok(res, analyticsService.ingestHealth());
  },

  async summary(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await analyticsService.summary({
      ...parseRange(value),
      companyId: value.companyId,
    });
    return ok(res, result);
  },

  async adoption(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await analyticsService.adoption(parseRange(value));
    return ok(res, result);
  },

  async funnel(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await analyticsService.funnel({
      ...parseRange(value),
      propertySlug: value.propertySlug,
    });
    return ok(res, result);
  },

  async engagement(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await analyticsService.engagement(parseRange(value));
    return ok(res, result);
  },

  async builder(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await analyticsService.builder(parseRange(value));
    return ok(res, result);
  },

  async events(req: Request, res: Response) {
    const { error, value } = rangeQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { page, limit, skip } = parsePagination(value);
    const result = await analyticsService.listEvents({
      ...parseRange(value),
      companyId: value.companyId,
      eventName: value.eventName,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },
};
