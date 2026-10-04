import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { supportChatAgentController, supportChatRuntimeController } from "./supportChat.controller";

/**
 * Asistencia 24/7 (chat en vivo PMS ↔ equipo interno).
 *
 *   /support-chat/runtime/*  → lo llama el PMS server-to-server
 *                              (X-Internal-Secret + X-Pms-User-Token).
 *   /support-chat/*          → la bandeja del panel interno (área "support").
 */
export const supportChatRouter = Router();

const runtime = Router();
runtime.use(requireInternalSecret);
runtime.get("/current", supportChatRuntimeController.current);
runtime.get("/conversations", supportChatRuntimeController.list);
runtime.post("/messages", supportChatRuntimeController.send);
runtime.post("/uploads/sign", supportChatRuntimeController.sign);
runtime.get("/files", supportChatRuntimeController.file);
runtime.get("/conversations/:id/sync", supportChatRuntimeController.sync);
runtime.post("/conversations/:id/typing", supportChatRuntimeController.typing);
runtime.post("/conversations/:id/close", supportChatRuntimeController.close);
supportChatRouter.use("/runtime", runtime);

supportChatRouter.use(authenticate);
supportChatRouter.get("/pulse", authorize("support"), supportChatAgentController.pulse);
supportChatRouter.get("/conversations", authorize("support"), supportChatAgentController.list);
supportChatRouter.get("/conversations/:id/sync", authorize("support"), supportChatAgentController.sync);
supportChatRouter.post("/conversations/:id/join", authorize("support"), supportChatAgentController.join);
supportChatRouter.post("/conversations/:id/messages", authorize("support"), supportChatAgentController.send);
supportChatRouter.post("/conversations/:id/typing", authorize("support"), supportChatAgentController.typing);
supportChatRouter.post("/conversations/:id/close", authorize("support"), supportChatAgentController.close);
supportChatRouter.post("/uploads/sign", authorize("support"), supportChatAgentController.sign);
supportChatRouter.get("/files", authorize("support"), supportChatAgentController.file);
