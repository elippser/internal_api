import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authController } from "./auth.controller";

export const authRouter = Router();

authRouter.post("/login", authController.login);
authRouter.post("/logout", authenticate, authController.logout);
authRouter.get("/me", authenticate, authController.me);
