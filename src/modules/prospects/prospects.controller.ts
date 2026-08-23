import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { prospectsService } from "./prospects.service";
import {
  bulkSchema,
  convertSchema,
  createProspectSchema,
  dashboardSchema,
  importSchema,
  listActivitiesSchema,
  listProspectsSchema,
  logActivitySchema,
  queueSchema,
  updateProspectSchema,
} from "./prospects.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[prospects]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

/** Joi devuelve el "1"/"true" del querystring tal cual; aca se vuelve boolean. */
function truthy(v: unknown): boolean {
  return v === true || v === "1" || v === "true";
}

export const prospectsController = {
  async list(req: Request, res: Response) {
    const { error, value } = listProspectsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const { page, limit, skip } = parsePagination(value);
      const r = await prospectsService.list({
        ...value,
        unassigned: truthy(value.unassigned),
        due: truthy(value.due),
        untouched: truthy(value.untouched),
        includeDoNotCall: truthy(value.includeDoNotCall),
        page,
        limit,
        skip,
      });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async get(req: Request, res: Response) {
    try {
      return ok(res, await prospectsService.get(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async create(req: Request, res: Response) {
    const { error, value } = createProspectSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await prospectsService.create(value), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateProspectSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await prospectsService.update(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async remove(req: Request, res: Response) {
    try {
      return ok(res, await prospectsService.remove(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // --- Actividad -----------------------------------------------------------

  async logActivity(req: Request, res: Response) {
    const { error, value } = logActivitySchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const user = req.internalUser
        ? { userId: req.internalUser.userId, email: req.internalUser.email }
        : undefined;
      return ok(res, await prospectsService.logActivity(req.params.id, value, user), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async listActivities(req: Request, res: Response) {
    const { error, value } = listActivitiesSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const { page, limit, skip } = parsePagination(value);
      const since = value.days
        ? new Date(Date.now() - value.days * 24 * 60 * 60 * 1000)
        : undefined;
      const r = await prospectsService.listActivities({ ...value, since, page, limit, skip });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // --- Cola y tablero ------------------------------------------------------

  async queue(req: Request, res: Response) {
    const { error, value } = queueSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(
        res,
        await prospectsService.queue({
          limit: value.limit,
          onlyMine: truthy(value.onlyMine),
          ownerUserId: req.internalUser?.userId,
        }),
      );
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async dashboard(req: Request, res: Response) {
    const { error, value } = dashboardSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await prospectsService.dashboard({ days: value.days }));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async facets(_req: Request, res: Response) {
    try {
      return ok(res, await prospectsService.facets());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // --- Masivo y conversion -------------------------------------------------

  async importRows(req: Request, res: Response) {
    const { error, value } = importSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(
        res,
        await prospectsService.importRows(value.rows, {
          source: value.source,
          sourceBatch: value.sourceBatch,
        }),
      );
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async bulk(req: Request, res: Response) {
    const { error, value } = bulkSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await prospectsService.bulk(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async convert(req: Request, res: Response) {
    const { error, value } = convertSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await prospectsService.convert(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async recompute(_req: Request, res: Response) {
    try {
      return ok(res, await prospectsService.recomputeAll());
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
