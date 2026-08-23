/**
 * `/api/v1/agents` — DEPRECADO. Sucesor: `/api/v1/engine/agents`.
 *
 * El módulo se conserva vivo pero congelado, en dos capas:
 *
 *   ESCRITURAS -> 410 Gone, apuntando al motor. Cerrarlas es lo que impide que
 *   la colección vieja y el motor se separen: mientras algo pueda escribir acá,
 *   existe el escenario de un agente editado en un lado y ejecutado con la
 *   configuración del otro, y ese desacuerdo es invisible hasta que un huésped
 *   recibe una respuesta que nadie autorizó.
 *
 *   LECTURAS -> siguen funcionando, pero servidas DESDE EL MOTOR y con las
 *   cabeceras estándar de deprecación (RFC 8594). Se conservan para no romper
 *   a ningún cliente desplegado en el mismo despliegue en que se migró; se
 *   borran cuando el header deje de verse en los accesos.
 *
 * La superficie de runtime (`/runtime/by-slug`) NO está deprecada: la consume
 * el PMS embebido y ahora resuelve contra el motor.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { fail } from "../../shared/utils/http";
import { agentsController } from "./agents.controller";

export const agentsRouter = Router();

/** Fecha a partir de la cual estas rutas se borran. Va en la cabecera `Sunset`. */
const SUNSET = "Wed, 31 Dec 2025 23:59:59 GMT";
const SUCCESSOR = "/api/v1/engine/agents";

// ---------------------------------------------------------------------------
// Runtime: server-to-server desde el PMS embebido. NO deprecado.
// ---------------------------------------------------------------------------

const runtime = Router();
runtime.use(requireInternalSecret);
runtime.get("/by-slug/:slug", agentsController.resolveBySlug);
agentsRouter.use("/runtime", runtime);

// ---------------------------------------------------------------------------
// Consola: deprecada.
// ---------------------------------------------------------------------------

agentsRouter.use(authenticate);

/**
 * Marca toda respuesta con las cabeceras estándar. `Deprecation` y `Sunset` son
 * las que un cliente puede detectar de forma automática; el `Link` con
 * `rel="successor-version"` es el que le dice a dónde ir sin leer un changelog.
 */
agentsRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", SUNSET);
  res.setHeader("Link", `<${SUCCESSOR}>; rel="successor-version"`);
  next();
});

/**
 * Corta las escrituras. 410 y no 404: el recurso EXISTIÓ y se retiró a
 * propósito — un 404 sugeriría un error de ruta y llevaría a alguien a
 * "arreglar" la URL en vez de migrar.
 */
function writesClosed(req: Request, res: Response): void {
  console.warn(
    `[agents] escritura rechazada sobre el módulo deprecado: ${req.method} ${req.originalUrl}`,
  );
  fail(
    res,
    410,
    `El módulo /agents está deprecado y es de sólo lectura. Usá ${SUCCESSOR}: ` +
      `crear agente (POST ${SUCCESSOR}) y guardar configuración (POST ${SUCCESSOR}/:id/versions). ` +
      `El motor versiona cada guardado en vez de sobrescribir.`,
    "module_deprecated",
  );
}

agentsRouter.post("/", authorize("developer"), writesClosed);
agentsRouter.patch("/:id", authorize("developer"), writesClosed);
agentsRouter.patch("/:id/status", authorize("developer"), writesClosed);
agentsRouter.delete("/:id", authorize("developer"), writesClosed);

// --- Lecturas: siguen sirviendo, ahora desde el motor -----------------------

// Va ANTES de "/:id" para que Express no lo capture como un agentId.
agentsRouter.get(
  "/available-models",
  authorize("analyst"),
  agentsController.availableModels,
);

agentsRouter.get("/", authorize("analyst"), agentsController.list);
agentsRouter.get("/:id", authorize("analyst"), agentsController.getOne);
