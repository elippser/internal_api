import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { memoryController } from "./memory.controller";

export const memoryRouter = Router();

// Server-to-server (PMS): el hotelero ve y limpia la memoria de su espacio.
const runtime = Router();
runtime.use(requireInternalSecret);
runtime.get("/", memoryController.list);
runtime.delete("/", memoryController.clear);
runtime.delete("/:memoryId", memoryController.remove);
memoryRouter.use("/runtime", runtime);

// Operador interno (audit/soporte).
memoryRouter.get("/", authenticate, authorize("support"), memoryController.list);
