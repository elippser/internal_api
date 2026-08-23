/**
 * Router del motor agéntico, montado bajo `/api/v1/engine`.
 *
 * Vive en su propio prefijo y NO toca `/api/v1/agents` ni `/api/v1/conversations`,
 * que siguen sirviendo al runtime actual del chat del PMS sin un solo cambio.
 * Es la decisión de convivencia: el motor nuevo se levanta al lado, se valida
 * con tráfico real, y recién entonces se migran los agentes existentes. Un
 * reemplazo directo habría puesto el chat de producción a depender de código
 * sin rodaje desde el primer día.
 *
 * Dos superficies con autenticación distinta:
 *   - `/runtime/*`  server-to-server desde el PMS (X-Internal-Secret), ámbito de
 *     inquilino obligatorio y SIN ámbito de sistema.
 *   - el resto      consola interna (JWT + rol), ámbito de organización.
 */
import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { engineAgentsController } from "./agents.controller";
import { engineAnalyticsController } from "./analytics.controller";
import { engineExecutionsController } from "./executions.controller";
import { engineSessionsController } from "./sessions.controller";
import { engineSkillsController } from "./skills.controller";
import { engineSystemController } from "./system.controller";
import { engineToolsController } from "./tools.controller";
import { handle, withConsoleScope, withRuntimeScope } from "./engine.scope";

export const engineRouter = Router();

// ---------------------------------------------------------------------------
// Superficie de runtime (server-to-server). Montada ANTES de `authenticate`.
// ---------------------------------------------------------------------------

const runtime = Router();
runtime.use(requireInternalSecret);
runtime.use(withRuntimeScope);

runtime.post("/executions", handle(engineExecutionsController.create));
runtime.get("/executions/:id", handle(engineExecutionsController.getOne));
runtime.get("/executions/:id/stream", handle(engineExecutionsController.stream));
runtime.post("/executions/:id/cancel", handle(engineExecutionsController.cancel));
runtime.post("/executions/:id/resume", handle(engineExecutionsController.resume));

engineRouter.use("/runtime", runtime);

// ---------------------------------------------------------------------------
// Consola interna
// ---------------------------------------------------------------------------

engineRouter.use(authenticate);
engineRouter.use(withConsoleScope);

// --- Sistema (lectura: analyst+) -------------------------------------------
engineRouter.get("/system/health", authorize("analyst"), handle(engineSystemController.health));
engineRouter.get("/system/models", authorize("analyst"), handle(engineSystemController.models));
engineRouter.post(
  "/system/models/refresh",
  authorize("developer"),
  handle(engineSystemController.refreshModels),
);
engineRouter.get(
  "/system/vocabulary",
  authorize("analyst"),
  handle(engineSystemController.vocabulary),
);
engineRouter.get(
  "/system/event-protocol",
  authorize("analyst"),
  handle(engineSystemController.eventProtocol),
);
engineRouter.get("/system/registry", authorize("analyst"), handle(engineSystemController.registry));

// --- Agentes ---------------------------------------------------------------
engineRouter.get("/agents", authorize("analyst"), handle(engineAgentsController.list));
engineRouter.post("/agents", authorize("developer"), handle(engineAgentsController.create));
engineRouter.get("/agents/:id", authorize("analyst"), handle(engineAgentsController.getOne));
engineRouter.patch("/agents/:id", authorize("developer"), handle(engineAgentsController.update));
engineRouter.delete("/agents/:id", authorize("developer"), handle(engineAgentsController.archive));
engineRouter.post(
  "/agents/:id/clone",
  authorize("developer"),
  handle(engineAgentsController.clone),
);
engineRouter.get(
  "/agents/:id/export",
  authorize("developer"),
  handle(engineAgentsController.exportOne),
);

// Versionado inmutable: crear versión, listarlas, leerlas, activar una.
engineRouter.get(
  "/agents/:id/versions",
  authorize("analyst"),
  handle(engineAgentsController.listVersions),
);
engineRouter.post(
  "/agents/:id/versions",
  authorize("developer"),
  handle(engineAgentsController.createVersion),
);
engineRouter.get(
  "/agents/:id/versions/:versionId",
  authorize("analyst"),
  handle(engineAgentsController.getVersion),
);
engineRouter.post(
  "/agents/:id/versions/:versionId/activate",
  authorize("developer"),
  handle(engineAgentsController.activateVersion),
);

// --- Herramientas ----------------------------------------------------------
// El catálogo unificado va ANTES de "/:id" para que Express no lo capture.
engineRouter.get(
  "/tools/available",
  authorize("analyst"),
  handle(engineToolsController.available),
);
engineRouter.get("/tools", authorize("analyst"), handle(engineToolsController.list));
engineRouter.post("/tools", authorize("developer"), handle(engineToolsController.create));
engineRouter.get("/tools/:id", authorize("analyst"), handle(engineToolsController.getOne));
engineRouter.patch("/tools/:id", authorize("developer"), handle(engineToolsController.update));
engineRouter.delete("/tools/:id", authorize("developer"), handle(engineToolsController.remove));

// --- Habilidades (§19) ------------------------------------------------------
engineRouter.get("/skills", authorize("analyst"), handle(engineSkillsController.list));
engineRouter.post("/skills", authorize("developer"), handle(engineSkillsController.create));
engineRouter.get(
  "/skills/for-agent/:agentId",
  authorize("analyst"),
  handle(engineSkillsController.forAgent),
);
engineRouter.get("/skills/:id", authorize("analyst"), handle(engineSkillsController.getOne));
engineRouter.post(
  "/skills/:id/versions",
  authorize("developer"),
  handle(engineSkillsController.saveVersion),
);
engineRouter.post(
  "/skills/:id/versions/:versionId/activate",
  authorize("developer"),
  handle(engineSkillsController.activateVersion),
);
engineRouter.delete("/skills/:id", authorize("developer"), handle(engineSkillsController.remove));

// --- Sesiones (§6.4) --------------------------------------------------------
// Sin POST de creación: se acuñan implícitamente al encolar una ejecución.
engineRouter.get("/sessions", authorize("analyst"), handle(engineSessionsController.list));
engineRouter.get("/sessions/:id", authorize("analyst"), handle(engineSessionsController.getOne));
engineRouter.get(
  "/sessions/:id/messages",
  authorize("analyst"),
  handle(engineSessionsController.messages),
);
engineRouter.delete(
  "/sessions/:id",
  authorize("developer"),
  handle(engineSessionsController.remove),
);

// --- Analítica (§23, §24) ---------------------------------------------------
engineRouter.get(
  "/analytics/summary",
  authorize("analyst"),
  handle(engineAnalyticsController.summary),
);
engineRouter.get(
  "/analytics/timeseries",
  authorize("analyst"),
  handle(engineAnalyticsController.timeseries),
);
engineRouter.get(
  "/analytics/by-agent",
  authorize("analyst"),
  handle(engineAnalyticsController.byAgent),
);
engineRouter.get(
  "/analytics/by-model",
  authorize("analyst"),
  handle(engineAnalyticsController.byModel),
);
engineRouter.get(
  "/analytics/failures",
  authorize("analyst"),
  handle(engineAnalyticsController.failures),
);
engineRouter.get(
  "/analytics/latency",
  authorize("analyst"),
  handle(engineAnalyticsController.latency),
);
engineRouter.get(
  "/analytics/tools",
  authorize("analyst"),
  handle(engineAnalyticsController.tools),
);

// --- Ejecuciones -----------------------------------------------------------
engineRouter.get("/executions", authorize("analyst"), handle(engineExecutionsController.list));
engineRouter.post("/executions", authorize("analyst"), handle(engineExecutionsController.create));
engineRouter.get("/executions/:id", authorize("analyst"), handle(engineExecutionsController.getOne));
engineRouter.get(
  "/executions/:id/steps",
  authorize("analyst"),
  handle(engineExecutionsController.steps),
);
engineRouter.get(
  "/executions/:id/steps/:stepId/payload",
  // La carga cruda puede contener el prompt completo: piso más alto que el
  // resto del depurador.
  authorize("developer"),
  handle(engineExecutionsController.stepPayload),
);
engineRouter.get(
  "/executions/:id/events",
  authorize("analyst"),
  handle(engineExecutionsController.events),
);
engineRouter.get(
  "/executions/:id/usage",
  authorize("analyst"),
  handle(engineExecutionsController.usage),
);
engineRouter.get(
  "/executions/:id/stream",
  authorize("analyst"),
  handle(engineExecutionsController.stream),
);
engineRouter.post(
  "/executions/:id/cancel",
  authorize("analyst"),
  handle(engineExecutionsController.cancel),
);
engineRouter.post(
  "/executions/:id/pause",
  authorize("analyst"),
  handle(engineExecutionsController.pause),
);
engineRouter.post(
  "/executions/:id/resume",
  authorize("analyst"),
  handle(engineExecutionsController.resume),
);
engineRouter.post(
  "/executions/:id/retry",
  authorize("developer"),
  handle(engineExecutionsController.retry),
);
engineRouter.post(
  "/executions/:id/replay",
  authorize("developer"),
  handle(engineExecutionsController.replay),
);
