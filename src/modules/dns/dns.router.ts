import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { dnsController as c } from "./dns.controller";

/**
 * /api/v1/mkt/dns — gestor de DNS de la zona bookfer.com en Cloudflare.
 *
 * Los pisos de rol son distintos a proposito:
 *  - LEER es `developer`, como /mkt/site: la zona dice donde vive cada app y
 *    eso es informacion de infraestructura, no un tablero de marketing.
 *  - ESCRIBIR es `admin`. Un registro mal cargado tira abajo un hostname de
 *    produccion entero, y a diferencia de casi todo lo demas del panel no hay
 *    forma de deshacerlo desde adentro.
 *
 * El motor agentico NO tiene una tool que llegue aca, y no conviene que la
 * tenga: escribir DNS es la clase de accion que no se delega a un LLM.
 */
export const dnsRouter = Router();

dnsRouter.use(authenticate);

dnsRouter.get("/status", authorize("developer"), c.status);
dnsRouter.get("/audit", authorize("developer"), c.audit);
dnsRouter.get("/changelog", authorize("developer"), c.changelog);

dnsRouter.get("/records", authorize("developer"), c.list);
dnsRouter.post("/records", authorize("admin"), c.create);
dnsRouter.patch("/records/:id", authorize("admin"), c.update);
dnsRouter.delete("/records/:id", authorize("admin"), c.remove);
