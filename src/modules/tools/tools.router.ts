import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { toolsController } from "./tools.controller";

export const toolsRouter = Router();

toolsRouter.use(authenticate);

toolsRouter.get("/", authorize("analyst"), toolsController.list);
toolsRouter.get("/:id", authorize("analyst"), toolsController.getOne);

toolsRouter.post("/", authorize("developer"), toolsController.create);
toolsRouter.patch("/:id", authorize("developer"), toolsController.update);
toolsRouter.patch(
  "/:id/status",
  authorize("developer"),
  toolsController.updateStatus,
);
