import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { metricsController } from "./metrics.controller";

export const metricsRouter = Router();

const readGuard = [authenticate, authorize("analyst")];

metricsRouter.get("/overview", ...readGuard, metricsController.overview);
/** Tabla del checkpoint del piloto: una fila por propiedad. */
metricsRouter.get("/pilot", ...readGuard, metricsController.pilot);
metricsRouter.get("/onboarding", ...readGuard, metricsController.onboarding);
metricsRouter.get("/adoption", ...readGuard, metricsController.adoption);
metricsRouter.get("/ia", ...readGuard, metricsController.ia);
// Sesiones de usuarios con el agente + transcripción con el voto de cada
// respuesta. Antes de "/ia" no hace falta: son rutas distintas, pero el detalle
// va después del listado por claridad.
metricsRouter.get("/ia/sessions", ...readGuard, metricsController.iaSessions);
metricsRouter.get(
  "/ia/sessions/:sessionId",
  ...readGuard,
  metricsController.iaSessionDetail,
);
metricsRouter.get("/engine", ...readGuard, metricsController.engine);
metricsRouter.get("/web", ...readGuard, metricsController.web);
// Cuentas de la plataforma: altas nuevas + stock por compañía.
metricsRouter.get("/accounts", ...readGuard, metricsController.accounts);
// Métricas por app y hub (usabilidad estándar + detalle propio de cada app).
metricsRouter.get("/apps", ...readGuard, metricsController.appsByHub);
metricsRouter.get("/apps/:appId", ...readGuard, metricsController.appDetail);
metricsRouter.get("/feature-demand", ...readGuard, metricsController.featureDemand);
metricsRouter.get("/health", ...readGuard, metricsController.health);
metricsRouter.get(
  "/companies/:companyId",
  ...readGuard,
  metricsController.company,
);

// Recomputar es caro y reescribe el rollup: admin+, no analyst.
metricsRouter.post(
  "/recompute",
  authenticate,
  authorize("admin"),
  metricsController.recompute,
);
