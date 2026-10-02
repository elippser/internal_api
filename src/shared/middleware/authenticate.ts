import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { checkArea, type AreaAccess } from "../access/areas";
import { getUserAccess, isAccessExpired } from "../access/userAccessCache";
import { fail } from "../utils/http";

export type InternalRole =
  | "super_admin"
  | "admin"
  | "developer"
  | "analyst"
  | "support";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: InternalRole;
  /** Permisos por area vigentes (vacio = sin recortes). */
  areaAccess?: AreaAccess;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      internalUser?: AuthenticatedUser;
    }
  }
}

/**
 * Autentica al operador del panel y aplica sus restricciones.
 *
 * El JWT solo prueba QUIEN es. Rol, status, vencimiento y permisos por area se
 * leen del padron (con cache corto, ver userAccessCache) para que una baja o
 * un recorte rija enseguida. Despues, el area de la URL se chequea contra sus
 * permisos (shared/access/areas.ts): esto corre en TODAS las rutas con
 * `authenticate`, asi que ningun modulo tiene que acordarse de hacerlo.
 *
 * Un token cuyo usuario no esta en el padron se rechaza en produccion. En
 * desarrollo se acepta con los claims del token: los smokes firman usuarios
 * sinteticos ("smoke") que no existen en la base.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    fail(res, 401, "Token requerido", "missing_token");
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    fail(res, 500, "JWT_SECRET no configurado", "server_misconfigured");
    return;
  }

  let decoded: AuthenticatedUser;
  try {
    decoded = jwt.verify(token, secret) as AuthenticatedUser;
  } catch {
    fail(res, 401, "Token invalido o expirado", "invalid_token");
    return;
  }

  let access;
  try {
    access = await getUserAccess(decoded.userId);
  } catch {
    fail(res, 503, "No se pudo verificar el usuario", "user_lookup_failed");
    return;
  }

  if (!access) {
    if (process.env.NODE_ENV === "production") {
      fail(res, 401, "Usuario inexistente", "user_not_found");
      return;
    }
    req.internalUser = { userId: decoded.userId, email: decoded.email, role: decoded.role };
    next();
    return;
  }

  if (access.status !== "active") {
    fail(res, 401, "Usuario inactivo", "user_inactive");
    return;
  }
  if (isAccessExpired(access)) {
    fail(res, 401, "Tu acceso vencio", "access_expired");
    return;
  }

  req.internalUser = {
    userId: access.userId,
    email: access.email,
    role: access.role as InternalRole,
    areaAccess: access.areaAccess,
  };

  // super_admin no se recorta: es la cuenta que arregla los permisos de los
  // demas, y recortarla podria dejar el panel sin nadie que pueda hacerlo.
  if (access.role !== "super_admin") {
    const decision = checkArea(access.areaAccess, req.method, req.originalUrl);
    if (!decision.ok) {
      fail(res, 403, decision.message, decision.code);
      return;
    }
  }

  next();
}
