import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { feedbackController } from "./feedback.controller";

export const feedbackRouter = Router();

// POST sin auth de usuario interno (llamado desde el pipeline del agente).
// El resto va con auth.
feedbackRouter.post("/", feedbackController.create);

feedbackRouter.use(authenticate);

feedbackRouter.get("/", authorize("support"), feedbackController.list);
feedbackRouter.get("/:id", authorize("support"), feedbackController.getOne);
feedbackRouter.patch("/:id", authorize("support"), feedbackController.update);
