import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { usabilityController as c } from "./usability.controller";

/**
 * /api/v1/usability (USABILIDAD-SPEC.md §5.3). Area de permisos "usability"
 * (shared/access/areas.ts): la aplica authenticate.
 */
export const usabilityRouter = Router();

usabilityRouter.use(authenticate, authorize("analyst"));

usabilityRouter.get("/overview", c.overview);
usabilityRouter.get("/screens", c.screens);
// screenKey va por query: lleva "/" y ":" ("projects/:id/editor").
usabilityRouter.get("/screen", c.screenDetail);
usabilityRouter.get("/flows", c.flows);
usabilityRouter.get("/frictions", c.frictions);
usabilityRouter.post("/recompute", authorize("admin"), c.recompute);
// Analisis de como le hablan a la IA (spec §6).
usabilityRouter.get("/ia/overview", c.iaOverview);
usabilityRouter.get("/ia/questions", c.iaQuestions);
usabilityRouter.post("/ia/label", authorize("admin"), c.iaLabel);
