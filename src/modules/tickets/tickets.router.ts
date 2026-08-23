import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { ticketsController } from "./tickets.controller";

export const ticketsRouter = Router();

ticketsRouter.use(authenticate);

ticketsRouter.get("/", authorize("support"), ticketsController.list);

ticketsRouter.post(
  "/cron/run",
  authorize("admin"),
  ticketsController.runCron,
);

ticketsRouter.post("/", authorize("developer"), ticketsController.create);
ticketsRouter.get("/:id", authorize("support"), ticketsController.getOne);
ticketsRouter.patch("/:id", authorize("support"), ticketsController.update);
