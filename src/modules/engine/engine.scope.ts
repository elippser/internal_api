/**
 * Resolución del ámbito del motor a partir de la petición HTTP (§7.2).
 *
 * Traduce el principal de internal-laupser al `EngineScope` que leen los
 * repositorios. Es el único punto donde se decide qué ve un llamador, y por eso
 * concentra las tres reglas que no pueden estar dispersas:
 *
 *  1. El ÁMBITO DE SISTEMA (`crossTenant`) se concede por el ROL del token, no
 *     por nada que venga en el cuerpo. Un cuerpo hostil que traiga
 *     `crossTenant: true` es inerte.
 *  2. La cabecera de inquilino ACOTA, nunca amplía. Un operador de plataforma
 *     puede mirar un inquilino concreto; un llamador con ámbito de inquilino no
 *     puede cambiarse a otro poniendo la cabecera.
 *  3. La superficie de runtime (server-to-server desde el PMS, protegida por
 *     `X-Internal-Secret`) NUNCA obtiene ámbito de sistema. Ese secreto lo
 *     tienen los microservicios del producto, no los operadores.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { hasMinRole } from "../../shared/middleware/authorize";
import { runWithScope, type EngineScope } from "../../engine/core/scope";
import { fail } from "../../shared/utils/http";

/** Cabecera con la que la consola se enfoca en un inquilino concreto. */
export const TENANT_HEADER = "x-engine-tenant";

/** Ancla de organización de este despliegue. */
function organizationId(): string {
  return process.env.ENGINE_ORGANIZATION_ID ?? "laupser";
}

function headerTenant(req: Request): string | null {
  const raw = req.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() ? value.trim() : null;
}

/**
 * Ámbito para la CONSOLA (operadores internos, JWT). Los operadores administran
 * la plataforma, así que su ámbito por defecto es de organización y ven entre
 * inquilinos a partir de `admin`. La cabecera acota a un inquilino.
 */
export const withConsoleScope: RequestHandler = (req, res, next) => {
  const user = req.internalUser;
  if (!user) {
    fail(res, 401, "No autenticado", "not_authenticated");
    return;
  }

  const tenantId = headerTenant(req);
  const scope: EngineScope = {
    tenantId,
    organizationId: organizationId(),
    userId: user.userId,
    role: user.role,
    // Ver entre inquilinos es una capacidad del ROL. Sin cabecera y sin este
    // permiso, un analista ve sólo los recursos globales de plataforma.
    crossTenant: hasMinRole(user.role, "admin") && !tenantId,
  };

  runWithScope(scope, () => next());
};

/**
 * Ámbito para la superficie de RUNTIME (server-to-server desde el PMS). El
 * inquilino es obligatorio y NO hay ámbito de sistema: aunque el secreto
 * interno es de confianza, esa confianza es para operar en nombre de un hotel
 * concreto, no para leer los datos de todos.
 */
export const withRuntimeScope: RequestHandler = (req, res, next) => {
  const tenantId =
    headerTenant(req) ??
    (typeof req.body?.tenantId === "string" ? req.body.tenantId : null) ??
    (typeof req.query?.tenantId === "string" ? (req.query.tenantId as string) : null);

  if (!tenantId) {
    fail(
      res,
      400,
      `Falta el inquilino: mandá la cabecera ${TENANT_HEADER} o el campo tenantId`,
      "missing_tenant",
    );
    return;
  }

  const scope: EngineScope = {
    tenantId,
    organizationId: organizationId(),
    userId: typeof req.body?.userId === "string" ? req.body.userId : null,
    role: typeof req.body?.userRole === "string" ? req.body.userRole : null,
    crossTenant: false,
  };

  runWithScope(scope, () => next());
};

/**
 * Envoltorio de controlador que traduce los errores de dominio del motor a HTTP
 * en un único manejador (§9.3). Sin esto, cada controlador repetiría el
 * try/catch y tarde o temprano dos rutas devolverían códigos distintos para la
 * misma falla.
 */
export function handle(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        await fn(req, res);
      } catch (err) {
        // Se importa perezosamente para no arrastrar el motor a la carga de
        // este módulo cuando sólo se necesita el middleware.
        const { toHttpError } = await import("../../engine/core/errors");
        const mapped = toHttpError(err);
        if (mapped.reportable) {
          console.error("[engine:http] error no manejado:", err);
        }
        if (res.headersSent) {
          next(err);
          return;
        }
        res.status(mapped.status).json(mapped.body);
      }
    })();
  };
}
