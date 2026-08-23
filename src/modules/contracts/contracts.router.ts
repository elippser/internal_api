import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { contractsController } from "./contracts.controller";

export const contractsRouter = Router();

// ---------- Server-to-server: enforcement de creditos (PMS) ----------
// Montado antes del authenticate: pms-core/api lo llama con X-Internal-Secret
// antes de cada turno del editor.
const internal = Router();
internal.use(requireInternalSecret);
internal.post("/check", contractsController.checkCredits);
contractsRouter.use("/credits", internal);

// ---------- Operador interno ----------
contractsRouter.use(authenticate);

// Rutas especificas ANTES de "/:id" para que no las capture como contractId.
contractsRouter.get(
  "/catalog",
  authorize("analyst"),
  contractsController.catalog,
);
contractsRouter.get(
  "/company/:companyId/credits",
  authorize("analyst"),
  contractsController.companyCredits,
);

contractsRouter.get("/", authorize("analyst"), contractsController.list);
contractsRouter.get(
  "/:id/credits",
  authorize("analyst"),
  contractsController.contractCredits,
);
contractsRouter.get("/:id", authorize("analyst"), contractsController.getOne);

// Escritura: admin+ (los contratos definen limites de facturacion).
contractsRouter.post("/", authorize("admin"), contractsController.create);
contractsRouter.patch("/:id", authorize("admin"), contractsController.update);
contractsRouter.patch(
  "/:id/associate",
  authorize("admin"),
  contractsController.associate,
);
contractsRouter.patch(
  "/:id/status",
  authorize("admin"),
  contractsController.updateStatus,
);
