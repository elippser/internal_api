import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { infraController as c } from "./infra.controller";

/**
 * /api/v1/infra — que hay corriendo, donde y con que deploy.
 *
 * TODO es de solo lectura. No hay redeploy, no hay rollback y no hay borrar un
 * proyecto: el token de Vercel puede hacer las tres cosas, y justamente por eso
 * ninguna se expone. Poner un boton de "redeploy" en un panel interno es poner
 * un boton de "romper produccion" a un click de distancia; cuando haga falta,
 * que sea una decision propia con su piso de rol y su bitacora.
 *
 * El piso es `developer`, el mismo que leer DNS: esto expone la topologia del
 * stack, los dominios y quien desplego que. No es un tablero de negocio.
 *
 * El motor agentico NO tiene una tool que llegue aca. No hay nada que un agente
 * necesite decidir con esta informacion que no pueda mirar una persona.
 */
export const infraRouter = Router();

infraRouter.use(authenticate);

infraRouter.get("/status", authorize("developer"), c.status);
infraRouter.get("/inventory", authorize("developer"), c.inventory);
infraRouter.get("/overview", authorize("developer"), c.overview);
infraRouter.get("/activity", authorize("developer"), c.activity);
// Repositorios en GitHub. Va en este modulo y no en uno propio porque la
// pregunta es la misma: que hay publicado y que quedo sin publicar. El repo es
// el origen del deploy, no un tema aparte.
infraRouter.get("/repos", authorize("developer"), c.repos);
// El detalle cuelga de /services/ y no de la raiz a proposito: asi "status" o
// "activity" nunca pueden caer como si fueran un id de servicio.
infraRouter.get("/services/:id", authorize("developer"), c.detail);
