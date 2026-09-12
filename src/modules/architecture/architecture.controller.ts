import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { architectureService } from "./architecture.service";
import { stackSchema } from "./architecture.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[architecture]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

/**
 * Ninguno de estos handlers sale a la red ni toca Mongo: leen tablas del propio
 * bundle. Por eso no hay cache, no hay `refresh` y no hay estado "sin
 * configurar" — a diferencia del modulo de Infraestructura, aca no hay token
 * que pueda faltar.
 */
export const architectureController = {
  async overview(_req: Request, res: Response) {
    try {
      return ok(res, architectureService.overview());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async stack(req: Request, res: Response) {
    const { error, value } = stackSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, architectureService.stack(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async services(_req: Request, res: Response) {
    try {
      return ok(res, architectureService.services());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async detail(req: Request, res: Response) {
    try {
      return ok(res, architectureService.detail(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async flows(_req: Request, res: Response) {
    try {
      return ok(res, architectureService.flows());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async integrations(_req: Request, res: Response) {
    try {
      return ok(res, architectureService.integrations());
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
