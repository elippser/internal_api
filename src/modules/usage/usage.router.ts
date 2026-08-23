import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { usageController } from "./usage.controller";

export const usageRouter = Router();

// Ingestion server-to-server: la reporta pms-core/api (editor) o el propio
// internal (agentes de conversacion). Protegida por X-Internal-Secret.
usageRouter.post("/records", requireInternalSecret, usageController.record);

// Reportes: dashboard interno (analyst+). Jerarquia company > property > user.
const readGuard = [authenticate, authorize("analyst")];

usageRouter.get("/summary", ...readGuard, usageController.summary);
usageRouter.get("/companies", ...readGuard, usageController.companies);
usageRouter.get(
  "/companies/:companyId",
  ...readGuard,
  usageController.companyDetail,
);
usageRouter.get(
  "/companies/:companyId/properties/:propertyId",
  ...readGuard,
  usageController.propertyDetail,
);
usageRouter.get(
  "/companies/:companyId/properties/:propertyId/users/:userId",
  ...readGuard,
  usageController.userDetail,
);
usageRouter.get("/models", ...readGuard, usageController.models);
usageRouter.get("/timeseries", ...readGuard, usageController.timeseries);
usageRouter.get("/records", ...readGuard, usageController.records);
