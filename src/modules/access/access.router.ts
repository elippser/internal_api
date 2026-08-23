import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { accessController } from "./access.controller";
import { blocksController } from "./blocks.controller";

/**
 * `/api/v1/access/*` — quién entró a Bookfer, desde dónde y con qué equipo.
 *
 * El piso es `analyst` y no `support`: estas rutas devuelven IP, ubicación y
 * huella del equipo, que son datos personales sensibles (USERS-ACTIONS-SPEC
 * §11 y §13). Misma vara que `/hotels`.
 */
export const accessRouter = Router();

accessRouter.use(authenticate);
accessRouter.use(authorize("analyst"));

// Reglas de bloqueo por pais, region e IP. Leerlas es `analyst` como todo el
// modulo; ESCRIBIRLAS es `admin`: una regla mal puesta deja afuera a un hotel
// entero, y eso no es una consulta, es una decision (USERS-ACTIONS-SPEC §20).
accessRouter.get("/blocks", blocksController.list);
accessRouter.post("/blocks/test", blocksController.test);
accessRouter.post("/blocks", authorize("admin"), blocksController.create);
accessRouter.patch("/blocks/:ruleId", authorize("admin"), blocksController.update);
accessRouter.delete("/blocks/:ruleId", authorize("admin"), blocksController.remove);

accessRouter.get("/events", accessController.listEvents);
accessRouter.get("/events/:eventId", accessController.getEvent);

accessRouter.get("/users", accessController.listUsers);
accessRouter.get("/users/:userId", accessController.getUser);
accessRouter.get("/users/:userId/events", accessController.listUserEvents);
accessRouter.get("/users/:userId/actions", accessController.listUserActions);
accessRouter.get("/users/:userId/devices", accessController.listUserDevices);

accessRouter.get("/summary", accessController.summary);
accessRouter.get("/geo/points", accessController.geoPoints);
