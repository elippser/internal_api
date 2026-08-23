import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { metricsService } from "./metrics.service";
import { metricsAppService } from "./metricsApp.service";
import { runRollup } from "./metricsRollup.service";
import {
  appMetricsQuerySchema,
  iaSessionsQuerySchema,
  metricsQuerySchema,
  recomputeSchema,
} from "./metrics.validation";

function parseQuery(req: Request, res: Response) {
  const { error, value } = metricsQuerySchema.validate(req.query);
  if (error) {
    fail(res, 400, error.message, "invalid_query");
    return null;
  }
  return value as {
    dateFrom?: string;
    dateTo?: string;
    companyId?: string;
    propertyId?: string;
  };
}

export const metricsController = {
  async overview(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.overview(q));
  },

  async pilot(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.pilot(q));
  },

  async onboarding(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.section("onboarding", q));
  },

  async adoption(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.section("adoption", q));
  },

  async ia(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.section("ia", q));
  },

  async engine(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.section("engine", q));
  },

  async web(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.section("web", q));
  },

  async company(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(
      res,
      await metricsService.overview({ ...q, companyId: req.params.companyId }),
    );
  },

  async iaSessions(req: Request, res: Response) {
    const { error, value } = iaSessionsQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await metricsService.iaSessions(value));
  },

  async iaSessionDetail(req: Request, res: Response) {
    const result = await metricsService.iaSessionDetail(req.params.sessionId);
    if (!result) return fail(res, 404, "Sesión no encontrada", "not_found");
    return ok(res, result);
  },

  /** Cuentas de la plataforma: companies, propiedades, espacios y usuarios. */
  async accounts(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.accounts(q));
  },

  /** Todas las apps agrupadas por hub, con su usabilidad comparable. */
  async appsByHub(req: Request, res: Response) {
    const { error, value } = appMetricsQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await metricsAppService.byHub(value));
  },

  /** Una app concreta: usabilidad, detalle propio y serie diaria. */
  async appDetail(req: Request, res: Response) {
    const { error, value } = appMetricsQuerySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await metricsAppService.app(req.params.appId, value));
  },

  async featureDemand(req: Request, res: Response) {
    const q = parseQuery(req, res);
    if (!q) return;
    return ok(res, await metricsService.featureDemand(q));
  },

  async health(_req: Request, res: Response) {
    return ok(res, await metricsService.health());
  },

  /**
   * Recómputo manual. Útil para rellenar un día puntual sin esperar al cron
   * (p. ej. después de un backfill o de arreglar un emisor).
   */
  async recompute(req: Request, res: Response) {
    const { error, value } = recomputeSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await runRollup(value);
      return ok(res, result);
    } catch (err) {
      return fail(
        res,
        500,
        err instanceof Error ? err.message : "rollup failed",
        "rollup_failed",
      );
    }
  },
};
