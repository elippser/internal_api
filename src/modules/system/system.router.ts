import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { systemController } from "./system.controller";

export const systemRouter = Router();

systemRouter.use(authenticate);
systemRouter.use(authorize("admin"));

systemRouter.get("/health", systemController.health);
