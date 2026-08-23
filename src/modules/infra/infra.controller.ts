import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { INFRA_SERVICES } from "./infra.inventory";
import { infraService } from "./infra.service";
import {
  activitySchema,
  detailSchema,
  overviewSchema,
  reposSchema,
} from "./infra.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[infra]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

export const infraController = {
  /** Nunca falla: "sin configurar" es una respuesta valida del estado. */
  async status(_req: Request, res: Response) {
    try {
      return ok(res, await infraService.status());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  /**
   * El inventario pelado, sin salir a la red. Sirve para ver la lista de
   * servicios aunque el token no este puesto todavia.
   */
  async inventory(_req: Request, res: Response) {
    return ok(res, { data: INFRA_SERVICES, total: INFRA_SERVICES.length });
  },

  async overview(req: Request, res: Response) {
    const { error, value } = overviewSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await infraService.overview(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async detail(req: Request, res: Response) {
    const { error, value } = detailSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await infraService.detail(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async repos(req: Request, res: Response) {
    const { error, value } = reposSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await infraService.repos(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async activity(req: Request, res: Response) {
    const { error, value } = activitySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await infraService.activity(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
