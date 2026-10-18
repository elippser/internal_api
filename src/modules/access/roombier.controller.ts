import Joi from "joi";
import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { PmsProxyError, pmsRequest } from "../../shared/middleware/pmsProxy";

/**
 * Roombiers: empleados o usuarios especiales de Roombir dentro del PMS.
 *
 * La marca vive en pms-core (`User.isRoombier`), que es quien la aplica: hoy
 * habilita el selector de company con TODAS las companies, donde el roombier
 * opera como admin. Acá sólo se valida y se delega, igual que los bloqueos.
 * Otorgarla es `admin`: da acceso de admin a cualquier hotel.
 */

const setSchema = Joi.object({
  enabled: Joi.boolean().required(),
}).unknown(false);

export const roombierController = {
  async set(req: Request, res: Response) {
    const { error, value } = setSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const result = await pmsRequest({
        service: "pms-core",
        method: "PATCH",
        path: `/api/v1/access/users/${encodeURIComponent(req.params.userId)}/roombier`,
        body: { enabled: value.enabled, grantedBy: req.internalUser?.email ?? null },
      });
      return ok(res, result);
    } catch (err) {
      if (err instanceof PmsProxyError) {
        const upstream = err.upstream as { error?: string } | undefined;
        if (err.status === 404) return fail(res, 404, "Usuario no encontrado", "not_found");
        return res
          .status(err.status === 401 ? 502 : err.status)
          .json(upstream ?? { error: err.message });
      }
      console.error("[access/roombier] error:", err);
      const msg = err instanceof Error ? err.message : "Error interno";
      return fail(res, 502, `Fallo comunicación con el PMS: ${msg}`);
    }
  },
};
