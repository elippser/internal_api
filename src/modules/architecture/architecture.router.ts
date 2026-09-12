import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { architectureController as c } from "./architecture.controller";

/**
 * /api/v1/architecture — como esta hecha la plataforma y como se conecta.
 *
 * Es el complemento de /infra, no su reemplazo:
 *
 *   /infra          estado en vivo: que corre, con que deploy, desde cuando.
 *                   Sale a Vercel, Coolify y GitHub, y gasta presupuesto.
 *   /architecture   analisis estatico: con que esta hecho, quien le habla a
 *                   quien, por donde pasa un pedido de punta a punta.
 *                   No sale a la red: se sirve entero desde el bundle.
 *
 * Todo de solo lectura, y aca ni siquiera existe la opcion contraria: no hay
 * modelo, no hay coleccion y no hay escritura posible. Actualizar el panorama
 * es editar `architecture.inventory.ts` o `architecture.tech.ts` y desplegar.
 *
 * El piso es `developer`, el mismo que /infra y DNS: esto expone la topologia
 * completa del stack, los nombres de los secretos y donde estan los huecos. Es
 * exactamente el mapa que uno querria tener antes de atacar la plataforma, asi
 * que no baja a `analyst` aunque no muestre ningun valor sensible.
 *
 * El motor agentico NO tiene una tool que llegue aca, por el mismo motivo.
 */
export const architectureRouter = Router();

architectureRouter.use(authenticate);

architectureRouter.get("/overview", authorize("developer"), c.overview);
architectureRouter.get("/stack", authorize("developer"), c.stack);
architectureRouter.get("/flows", authorize("developer"), c.flows);
architectureRouter.get("/integrations", authorize("developer"), c.integrations);
// El detalle cuelga de /services/ y no de la raiz a proposito: asi "stack" o
// "flows" nunca pueden caer como si fueran un id de servicio.
architectureRouter.get("/services", authorize("developer"), c.services);
architectureRouter.get("/services/:id", authorize("developer"), c.detail);
