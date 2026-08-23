import type { NextFunction, Request, Response } from "express";
import { fail } from "../utils/http";

// Protege endpoints invocados server-to-server desde el PMS embebido.
// El PMS debe mandar X-Internal-Secret en cada request. El mismo secret
// se usa para validar tanto las llamadas que vienen del PMS hacia
// internal-laupser (este middleware) como las que van de internal-laupser
// al PMS (header inyectado por pmsProxy).
export function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.PMS_INTERNAL_SECRET;
  if (!expected) {
    fail(
      res,
      500,
      "PMS_INTERNAL_SECRET no configurado",
      "server_misconfigured",
    );
    return;
  }
  const provided = req.headers["x-internal-secret"];
  if (provided !== expected) {
    fail(res, 401, "X-Internal-Secret invalido o ausente", "invalid_secret");
    return;
  }
  next();
}
