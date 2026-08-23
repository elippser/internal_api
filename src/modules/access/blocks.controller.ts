import Joi from "joi";
import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { PmsProxyError, pmsRequest } from "../../shared/middleware/pmsProxy";

/**
 * Reglas de bloqueo de acceso (USERS-ACTIONS-SPEC §20).
 *
 * Acá no hay lógica: las reglas viven en pms-core, que es el único que puede
 * aplicarlas en el momento del login. Duplicarlas de este lado sería tener dos
 * verdades sobre quién puede entrar, y la que manda siempre sería la otra.
 *
 * Este módulo es la pantalla de administración: valida la forma, delega, y
 * traduce los errores del upstream a algo que la UI pueda mostrar.
 */

const createSchema = Joi.object({
  action: Joi.string().valid("block", "allow").default("block"),
  type: Joi.string().valid("country", "region", "ip").required(),
  scope: Joi.string().valid("all", "login", "register").default("all"),
  /**
   * Una sola entrada o una lista. La lista es el caso normal: bloquear se hace
   * pegando países o IPs de a varios, no de a uno.
   */
  value: Joi.alternatives()
    .try(Joi.string().max(200), Joi.array().items(Joi.string().max(200)).max(200))
    .required(),
  reason: Joi.string().max(300).allow("", null),
  enabled: Joi.boolean().default(true),
}).unknown(false);

const updateSchema = Joi.object({
  enabled: Joi.boolean(),
  reason: Joi.string().max(300).allow("", null),
  scope: Joi.string().valid("all", "login", "register"),
  action: Joi.string().valid("block", "allow"),
})
  .min(1)
  .unknown(false);

const testSchema = Joi.object({
  ip: Joi.string().max(60),
  country: Joi.string().max(10),
  region: Joi.string().max(120),
  scope: Joi.string().valid("login", "register", "session").default("login"),
}).unknown(false);

function handle(res: Response, err: unknown) {
  if (err instanceof PmsProxyError) {
    const upstream = err.upstream as { error?: string; failed?: unknown } | undefined;
    // El 400 del PMS trae el detalle de qué entrada estaba mal escrita: se pasa
    // tal cual, porque es exactamente lo que la persona necesita leer.
    return res
      .status(err.status === 401 ? 502 : err.status)
      .json(upstream ?? { error: err.message });
  }
  console.error("[access/blocks] error:", err);
  const msg = err instanceof Error ? err.message : "Error interno";
  return fail(res, 502, `Fallo comunicación con el PMS: ${msg}`);
}

export const blocksController = {
  async list(_req: Request, res: Response) {
    try {
      const rules = await pmsRequest({
        service: "pms-core",
        path: "/api/v1/access/blocks",
      });
      return ok(res, rules);
    } catch (err) {
      return handle(res, err);
    }
  },

  async create(req: Request, res: Response) {
    const { error, value } = createSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const result = await pmsRequest({
        service: "pms-core",
        method: "POST",
        path: "/api/v1/access/blocks",
        body: {
          ...value,
          // Queda registrado quién la creó: una regla que deja gente afuera
          // tiene que poder atribuirse a una persona.
          createdBy: req.internalUser?.email,
        },
      });
      return ok(res, result, 201);
    } catch (err) {
      return handle(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const result = await pmsRequest({
        service: "pms-core",
        method: "PATCH",
        path: `/api/v1/access/blocks/${encodeURIComponent(req.params.ruleId)}`,
        body: value,
      });
      return ok(res, result);
    } catch (err) {
      return handle(res, err);
    }
  },

  async remove(req: Request, res: Response) {
    try {
      await pmsRequest({
        service: "pms-core",
        method: "DELETE",
        path: `/api/v1/access/blocks/${encodeURIComponent(req.params.ruleId)}`,
      });
      return res.status(204).end();
    } catch (err) {
      return handle(res, err);
    }
  },

  /** Prueba en seco antes de guardar: "¿esta IP entraría?". */
  async test(req: Request, res: Response) {
    const { error, value } = testSchema.validate(req.body ?? {});
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const result = await pmsRequest({
        service: "pms-core",
        method: "POST",
        path: "/api/v1/access/blocks/test",
        body: value,
      });
      return ok(res, result);
    } catch (err) {
      return handle(res, err);
    }
  },
};
