import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { authService } from "./auth.service";
import { loginSchema } from "./auth.validation";

export const authController = {
  async login(req: Request, res: Response) {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const result = await authService.login(value.email, value.password);
      return ok(res, result);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return fail(res, status, (err as Error).message);
    }
  },

  async logout(_req: Request, res: Response) {
    // Sin blacklist por ahora: el cliente descarta el token.
    // Si en el futuro se requiere invalidacion server-side, agregar coleccion TTL.
    return ok(res, { ok: true });
  },

  async me(req: Request, res: Response) {
    const auth = req.internalUser;
    if (!auth) return fail(res, 401, "No autenticado", "not_authenticated");
    const user = await authService.getMe(auth.userId);
    if (!user) return fail(res, 404, "Usuario no encontrado", "not_found");
    return ok(res, user);
  },
};
