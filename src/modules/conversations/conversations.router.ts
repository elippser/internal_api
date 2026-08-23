import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { conversationsController } from "./conversations.controller";
import { requirePmsUser, requireSessionOwner } from "./conversations.guards";

export const conversationsRouter = Router();

// ---------- Runtime: server-to-server desde el PMS embebido ----------
// Protegidos por X-Internal-Secret en vez de JWT del operador.
// Montados bajo /sessions para que no intercepten requests del audit.
//
// El secret solo autentica al PMS como servicio; la identidad del hotelero
// viaja aparte en X-Pms-User-Token. Toda ruta con :id pasa por
// requireSessionOwner para que un usuario no pueda abrir (ni escribir en) la
// conversación de otro.
const runtime = Router();
runtime.use(requireInternalSecret);
runtime.post("/", conversationsController.createSession);
// Listar conversaciones (sidebar del PMS): scoped por query
// (operativeSpaceId/propertyId/companyId) + userId forzado al del token.
// Antes de "/:id".
runtime.get("/", requirePmsUser, conversationsController.list);
runtime.get(
  "/:id/messages",
  requireSessionOwner,
  conversationsController.listMessages,
);
runtime.post(
  "/:id/messages/:messageId/feedback",
  requireSessionOwner,
  conversationsController.rateMessage,
);
// Acciones disparadas desde las cards del chat (UI generativa accionable).
runtime.post(
  "/:id/actions",
  requireSessionOwner,
  conversationsController.executeAction,
);
// Descarga de archivos generados por la IA (code_execution → Files API).
// Antes de "/:id" para que no lo capture el catch-all de sesión.
runtime.get("/files/:fileId", conversationsController.downloadFile);
// Créditos de IA de la company (widget de uso del sidebar). Antes de "/:id".
runtime.get("/credits", conversationsController.getCredits);
runtime.get("/:id", requireSessionOwner, conversationsController.getSession);
runtime.delete("/:id", requireSessionOwner, conversationsController.endSession);
runtime.post(
  "/:id/messages",
  requireSessionOwner,
  conversationsController.postMessage,
);
// Variante SSE: status del turno en vivo + respuesta final.
runtime.post(
  "/:id/messages/stream",
  requireSessionOwner,
  conversationsController.postMessageStream,
);

conversationsRouter.use("/sessions", runtime);

// ---------- Audit: equipo bookfer ----------
// Montado en raiz. NOTA: definimos rutas explicitas en vez de un
// /:id catch-all para evitar que "sessions" sea interpretado como id.
const audit = Router();
audit.use(authenticate);
audit.use(authorize("support"));

audit.get("/", conversationsController.list);
audit.get("/:id/messages", conversationsController.listMessages);
audit.get("/:id", conversationsController.getSession);

conversationsRouter.use("/", audit);
