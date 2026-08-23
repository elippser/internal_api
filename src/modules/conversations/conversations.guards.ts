import type { NextFunction, Request, Response } from "express";
import { fail } from "../../shared/utils/http";
import { ConversationSession } from "./conversations.model";
import { verifyUserToken } from "./services/pmsContextResolver";

// JWT del hotelero reenviado por el proxy del PMS en cada request runtime.
// El X-Internal-Secret solo prueba "esto viene del PMS"; NO dice qué usuario
// está del otro lado. Sin este header cualquier usuario logueado podía pedir
// /sessions/<id> de otro y leer (o seguir escribiendo en) su conversación.
const USER_TOKEN_HEADER = "x-pms-user-token";

// userId VERIFICADO (firma chequeada contra los secrets compartidos). Nunca
// confiamos en un userId que venga suelto en el body/query: eso lo elige el
// cliente.
function verifiedUserId(req: Request): string | null {
  const raw = req.headers[USER_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  return verifyUserToken(token)?.userId ?? null;
}

// Exige usuario identificado y fuerza el filtro `userId` de la query con el
// verificado: el listado del sidebar solo puede devolver conversaciones
// propias, sin importar qué mande el cliente.
export function requirePmsUser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = verifiedUserId(req);
  if (!userId) {
    fail(res, 401, "Usuario no identificado", "user_token_required");
    return;
  }
  res.locals.pmsUserId = userId;
  req.query.userId = userId;
  next();
}

// Exige que la sesión de :id pertenezca al usuario que llama. Responde 404
// (no 403) ante una sesión ajena para no confirmar que ese sessionId existe.
// Las sesiones sin `context.userId` (creadas por un agente sin requiresAuth)
// tampoco son accesibles por esta vía: el listado ya no las devuelve, así que
// dejarlas abiertas sería la única puerta que queda.
export function requireSessionOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = verifiedUserId(req);
  if (!userId) {
    fail(res, 401, "Usuario no identificado", "user_token_required");
    return;
  }

  ConversationSession.findOne(
    { sessionId: req.params.id },
    { "context.userId": 1 },
  )
    .then((session) => {
      if (!session || session.context?.userId !== userId) {
        fail(res, 404, "Sesion no encontrada", "not_found");
        return;
      }
      res.locals.pmsUserId = userId;
      next();
    })
    .catch(next);
}
