import { Router, type NextFunction, type Request, type Response } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail } from "../../shared/utils/http";
import { intelligenceController } from "./intelligence.controller";

// Auth dual: usuarios internos con JWT (como el resto de la API) o
// servicios (el proxy del radar elippser-gl) con x-internal-secret ===
// PMS_INTERNAL_SECRET — server-to-server, la key nunca llega al browser.
function authenticateUserOrService(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.PMS_INTERNAL_SECRET;
  const provided = req.headers["x-internal-secret"];
  if (secret && typeof provided === "string" && provided === secret) {
    next();
    return;
  }
  authenticate(req, res, next);
}

// El trigger manual de ingesta solo para servicios o usuarios developer+.
function requireServiceOrRole(role: Parameters<typeof authorize>[0]) {
  const roleCheck = authorize(role);
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env.PMS_INTERNAL_SECRET;
    const provided = req.headers["x-internal-secret"];
    if (secret && typeof provided === "string" && provided === secret) {
      next();
      return;
    }
    if (!req.internalUser) {
      fail(res, 401, "Token requerido", "missing_token");
      return;
    }
    roleCheck(req, res, next);
  };
}

export const intelligenceRouter = Router();

intelligenceRouter.use(authenticateUserOrService);

intelligenceRouter.get("/signals", intelligenceController.signals);
intelligenceRouter.get("/summary", intelligenceController.summary);
intelligenceRouter.get("/health", intelligenceController.health);
intelligenceRouter.get("/connectors", intelligenceController.connectors);
intelligenceRouter.post(
  "/ingest/:connector",
  requireServiceOrRole("developer"),
  intelligenceController.ingest,
);

// Puntos de barrido registrados por servicios (RMS): la cobertura de eventos
// sigue a las properties, no al catálogo. Escritura solo servicio/developer+.
intelligenceRouter.get("/watchpoints", intelligenceController.watchpoints);
intelligenceRouter.put(
  "/watchpoints/:pointId",
  requireServiceOrRole("developer"),
  intelligenceController.upsertWatchpoint,
);
intelligenceRouter.delete(
  "/watchpoints/:pointId",
  requireServiceOrRole("developer"),
  intelligenceController.deleteWatchpoint,
);
