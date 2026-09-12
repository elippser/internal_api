/**
 * Endpoints del plan de crecimiento.
 *
 * Son tres y hacen poco a propósito: el plan se CREA desde el turno del agente
 * (la tool interna) y sus pasos se EJECUTAN por el camino normal de tools, con
 * su confirmación. Acá sólo queda lo que no necesita al modelo: leer un plan y
 * descartar un paso.
 *
 * Descartar merece endpoint propio por una razón concreta: mandarlo como
 * mensaje ("descartá el paso 3") gastaría un turno entero del modelo, con sus
 * tokens y sus tres segundos, para cambiar un campo que el front ya conoce.
 */

import { Router, type Request, type Response } from "express";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { getPlan, markStep } from "./plan/plan.service";
import { sanitizePlan } from "./plan/growthPlan.model";

export const growthRouter = Router();

// Mismo portón que el runtime del chat: el PMS se autentica como servicio con
// X-Internal-Secret. No hay ruta pública acá.
growthRouter.use(requireInternalSecret);

function fail(res: Response, status: number, message: string, code?: string) {
  return res.status(status).json({ ok: false, error: { message, code } });
}

growthRouter.get("/plans/:planId", async (req: Request, res: Response) => {
  const plan = await getPlan(req.params.planId);
  if (!plan) return fail(res, 404, "Plan no encontrado", "plan_not_found");
  return res.json({ ok: true, data: sanitizePlan(plan) });
});

/**
 * Descarta un paso.
 *
 * Sólo se pueden descartar pasos que todavía no se resolvieron: marcar como
 * "rechazado" algo que YA se ejecutó reescribiría la historia, y el plan sirve
 * justamente porque es un registro de lo que pasó.
 */
growthRouter.post(
  "/plans/:planId/steps/:stepId/reject",
  async (req: Request, res: Response) => {
    const plan = await getPlan(req.params.planId);
    if (!plan) return fail(res, 404, "Plan no encontrado", "plan_not_found");

    const step = plan.steps.find((s) => s.stepId === req.params.stepId);
    if (!step) return fail(res, 404, "Paso no encontrado", "step_not_found");
    if (step.status !== "sugerido" && step.status !== "aceptado") {
      return fail(
        res,
        409,
        `El paso ya está "${step.status}" y no se puede descartar.`,
        "step_already_resolved",
      );
    }

    const updated = await markStep({
      planId: plan.planId,
      stepId: step.stepId,
      status: "rechazado",
    });
    return res.json({ ok: true, data: updated ? sanitizePlan(updated) : null });
  },
);

/** El plan activo de un espacio operativo (o de una propiedad). */
growthRouter.get("/plans", async (req: Request, res: Response) => {
  const { getActivePlan } = await import("./plan/plan.service");
  const plan = await getActivePlan({
    operativeSpaceId: (req.query.operativeSpaceId as string) || undefined,
    propertyId: (req.query.propertyId as string) || undefined,
  });
  return res.json({ ok: true, data: plan ? sanitizePlan(plan) : null });
});
