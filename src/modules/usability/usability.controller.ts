import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import * as svc from "./usability.service";
import { dayKey, runUsabilityRollup } from "./usabilityRollup.service";
import { iaOverview, iaQuestions } from "./ia.service";
import { runIaLabeling } from "./iaLabeler.service";
import { detailSchema, flowsSchema, iaLabelSchema, iaQuestionsSchema, rangeSchema, recomputeSchema } from "./usability.validation";

function range(v: { from?: string; to?: string; companyId?: string }): svc.RangeQuery {
  const to = v.to ?? dayKey(new Date());
  const from = v.from ?? dayKey(new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86_400_000));
  return { from, to, companyId: v.companyId || undefined };
}

export const usabilityController = {
  async overview(req: Request, res: Response) {
    const { error, value } = rangeSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await svc.overview(range(value)));
  },

  async screens(req: Request, res: Response) {
    const { error, value } = rangeSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await svc.screens(range(value), value.appId));
  },

  async screenDetail(req: Request, res: Response) {
    const { error, value } = detailSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const out = await svc.screenDetail(range(value), value.screenKey, value.vw);
    if (!out) return fail(res, 404, "Sin datos de esa pantalla en el rango", "not_found");
    return ok(res, out);
  },

  async flows(req: Request, res: Response) {
    const { error, value } = flowsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await svc.flows(range(value), value.layer));
  },

  async frictions(req: Request, res: Response) {
    const { error, value } = rangeSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await svc.frictions(range(value)));
  },

  async recompute(req: Request, res: Response) {
    const { error, value } = recomputeSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await runUsabilityRollup({ from: value.from, to: value.to }));
    } catch (err) {
      return fail(res, 500, err instanceof Error ? err.message : "Rollup fallo", "rollup_failed");
    }
  },

  async iaOverview(req: Request, res: Response) {
    const { error, value } = rangeSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await iaOverview(range(value)));
  },

  async iaQuestions(req: Request, res: Response) {
    const { error, value } = iaQuestionsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    return ok(res, await iaQuestions(range(value), { topic: value.topic, resolved: value.resolved, search: value.q }));
  },

  /** Corrida manual con tope chico (admin): para no esperar a la noche. */
  async iaLabel(req: Request, res: Response) {
    const { error, value } = iaLabelSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await runIaLabeling({ budgetUsd: value.budgetUsd, maxMessages: value.maxMessages }));
    } catch (err) {
      return fail(res, 500, err instanceof Error ? err.message : "Etiquetado fallo", "label_failed");
    }
  },
};
