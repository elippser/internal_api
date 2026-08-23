import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      internalUser?: AuthenticatedUser;
    }
  }
}

export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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

  try {
    const decoded = jwt.verify(token, secret) as AuthenticatedUser & {
      iat?: number;
      exp?: number;
    };
    req.internalUser = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch {
    fail(res, 401, "Token invalido o expirado", "invalid_token");
  }
}
