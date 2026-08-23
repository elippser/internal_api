import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { analyticsController } from "./analytics.controller";

export const analyticsRouter = Router();

// Ingesta server-to-server. No la llama el browser: cada app tiene un proxy
// same-origin que inyecta el secret del lado del servidor (así el secret nunca
// viaja al cliente y la telemetría pública no puede ser falsificada por
// cualquiera, que era el agujero de la versión anterior sin auth).
analyticsRouter.post("/events", requireInternalSecret, analyticsController.ingest);

// Consulta (protegidos)
const readGuard = [authenticate, authorize("analyst")];

analyticsRouter.get("/summary", ...readGuard, analyticsController.summary);
analyticsRouter.get("/adoption", ...readGuard, analyticsController.adoption);
analyticsRouter.get("/funnel", ...readGuard, analyticsController.funnel);
analyticsRouter.get("/engagement", ...readGuard, analyticsController.engagement);
analyticsRouter.get("/builder", ...readGuard, analyticsController.builder);
analyticsRouter.get("/events", ...readGuard, analyticsController.events);
analyticsRouter.get("/health", ...readGuard, analyticsController.health);
