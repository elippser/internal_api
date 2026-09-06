import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { leadsController as c } from "./leads.controller";

/**
 * Tres routers para tres publicos distintos, y por eso son tres archivos de
 * montaje distintos en `index.ts`:
 *
 * - `publicLeadsRouter`  el formulario de roombir.com. Sin token de ninguna
 *   clase (es un visitante) y por eso todo el peso lo lleva el filtro:
 *   `leads.screening.ts` + el schema estricto.
 * - `internalLeadsRouter`  server-to-server con pms-core. X-Internal-Secret,
 *   nunca JWT de operador: quien pregunta no es una persona, es el /register.
 * - `leadsRouter`  el panel interno. JWT + rol.
 *
 * El piso del panel es `support`: quien atiende "no me llego el mail" tiene que
 * poder reenviarlo. Descartar y revocar suben a `analyst` porque cierran la
 * puerta de alguien.
 */

// ---------------------------------------------------------------------------
// Publico: el formulario del sitio
// ---------------------------------------------------------------------------

export const publicLeadsRouter = Router();

publicLeadsRouter.post("/", c.capture);

// ---------------------------------------------------------------------------
// Server-to-server: el /register del PMS
// ---------------------------------------------------------------------------

export const internalLeadsRouter = Router();

internalLeadsRouter.use(requireInternalSecret);
internalLeadsRouter.post("/invite/verify", c.verifyInvite);
internalLeadsRouter.post("/invite/consume", c.consumeInvite);

// ---------------------------------------------------------------------------
// Panel interno
// ---------------------------------------------------------------------------

export const leadsRouter = Router();

leadsRouter.use(authenticate);

// Las rutas fijas van ANTES de "/:id" o "stats" caeria como un leadId.
leadsRouter.get("/stats", authorize("analyst"), c.stats);

leadsRouter.get("/", authorize("support"), c.list);
leadsRouter.get("/:id", authorize("support"), c.get);
leadsRouter.patch("/:id", authorize("support"), c.update);
leadsRouter.post("/:id/resend", authorize("support"), c.resend);
leadsRouter.post("/:id/revoke", authorize("analyst"), c.revoke);
