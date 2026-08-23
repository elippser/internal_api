import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { hotelsController } from "./hotels.controller";

export const hotelsRouter = Router();

hotelsRouter.use(authenticate);
hotelsRouter.use(authorize("analyst"));

hotelsRouter.get("/", hotelsController.list);
hotelsRouter.get("/:id", hotelsController.getOne);
hotelsRouter.get("/:id/properties", hotelsController.listProperties);
hotelsRouter.get("/:id/activity", hotelsController.listActivity);
