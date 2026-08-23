import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { usersController } from "./users.controller";

export const usersRouter = Router();

usersRouter.use(authenticate, authorize("admin"));

usersRouter.get("/", usersController.list);
usersRouter.post("/", usersController.create);
usersRouter.get("/:id", usersController.getOne);
usersRouter.patch("/:id", usersController.update);
usersRouter.delete("/:id", usersController.remove);
