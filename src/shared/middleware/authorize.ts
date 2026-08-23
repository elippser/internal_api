import type { NextFunction, Request, Response } from "express";
import { fail } from "../utils/http";
import type { InternalRole } from "./authenticate";

const RANK: Record<InternalRole, number> = {
  super_admin: 5,
  admin: 4,
  developer: 3,
  analyst: 2,
  support: 1,
};

export function authorize(minRole: InternalRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.internalUser;
    if (!user) {
      fail(res, 401, "No autenticado", "not_authenticated");
      return;
    }
    if (RANK[user.role] < RANK[minRole]) {
      fail(res, 403, "Permisos insuficientes", "forbidden");
      return;
    }
    next();
  };
}

export function hasMinRole(role: InternalRole, minRole: InternalRole): boolean {
  return RANK[role] >= RANK[minRole];
}
