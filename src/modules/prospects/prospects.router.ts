import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { prospectsController as c } from "./prospects.controller";

/**
 * /api/v1/prospects — la lista de alojamientos a llamar.
 *
 * El piso es `support`: quien hace las llamadas no es analista ni desarrollador,
 * y necesita leer la cola y registrar el resultado. Lo que toca muchas fichas de
 * una (import, acciones masivas, recompute) o borra, sube de rol.
 *
 * Las rutas fijas van ANTES de "/:id" o "cola" caeria como un prospectId.
 */
export const prospectsRouter = Router();

prospectsRouter.use(authenticate);

prospectsRouter.get("/dashboard", authorize("analyst"), c.dashboard);
prospectsRouter.get("/queue", authorize("support"), c.queue);
prospectsRouter.get("/facets", authorize("support"), c.facets);
prospectsRouter.get("/activities", authorize("support"), c.listActivities);

prospectsRouter.post("/import", authorize("developer"), c.importRows);
prospectsRouter.post("/bulk", authorize("analyst"), c.bulk);
prospectsRouter.post("/recompute", authorize("developer"), c.recompute);

prospectsRouter.get("/", authorize("support"), c.list);
prospectsRouter.post("/", authorize("support"), c.create);

prospectsRouter.get("/:id", authorize("support"), c.get);
prospectsRouter.patch("/:id", authorize("support"), c.update);
// Convertir escribe en el CRM: es una decision comercial, no una llamada.
prospectsRouter.post("/:id/convert", authorize("analyst"), c.convert);
prospectsRouter.post("/:id/activities", authorize("support"), c.logActivity);
prospectsRouter.delete("/:id", authorize("admin"), c.remove);
