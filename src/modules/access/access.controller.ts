import type { Request, Response } from "express";
import { fail, ok, paginated } from "../../shared/utils/http";
import { accessService } from "./access.service";
import {
  geoPointsSchema,
  listEventsSchema,
  listUsersSchema,
  summarySchema,
  userActionsSchema,
} from "./access.validation";

/**
 * Controladores de `/api/v1/access/*` (USERS-ACTIONS-SPEC §11).
 *
 * Mismo contrato de errores que `hotels`: 400 `invalid_query` cuando Joi
 * rechaza, 404 `not_found` cuando el id no existe y 502 para cualquier fallo de
 * lectura contra la base del PMS — que es una base ajena y puede no estar.
 */

export const accessController = {
  async listEvents(req: Request, res: Response) {
    const { error, value } = listEventsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const result = await accessService.listEvents(value);
      return paginated(res, result.data, result.total, result.page, result.limit);
    } catch (err) {
      return handle(res, err);
    }
  },

  async getEvent(req: Request, res: Response) {
    try {
      const doc = await accessService.getEvent(req.params.eventId);
      if (!doc) return fail(res, 404, "Evento no encontrado", "not_found");
      return ok(res, doc);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listUsers(req: Request, res: Response) {
    const { error, value } = listUsersSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const result = await accessService.listUsers(value);
      return paginated(res, result.data, result.total, result.page, result.limit);
    } catch (err) {
      return handle(res, err);
    }
  },

  async getUser(req: Request, res: Response) {
    try {
      const doc = await accessService.getUser(req.params.userId);
      if (!doc) return fail(res, 404, "Usuario no encontrado", "not_found");
      return ok(res, doc);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listUserEvents(req: Request, res: Response) {
    const { error, value } = listEventsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      if (!(await accessService.userExists(req.params.userId))) {
        return fail(res, 404, "Usuario no encontrado", "not_found");
      }
      // El userId del path gana sobre el de la query: la ruta ES el filtro.
      const result = await accessService.listEvents({
        ...value,
        userId: req.params.userId,
      });
      return paginated(res, result.data, result.total, result.page, result.limit);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listUserActions(req: Request, res: Response) {
    const { error, value } = userActionsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      // Se chequea la existencia aunque la timeline salga de la base de
      // internal: un id mal tipeado tiene que dar 404 y no una lista vacía,
      // que se leería como "este usuario no hizo nada".
      if (!(await accessService.userExists(req.params.userId))) {
        return fail(res, 404, "Usuario no encontrado", "not_found");
      }
      const docs = await accessService.listUserActions(req.params.userId, value);
      return ok(res, docs);
    } catch (err) {
      return handle(res, err);
    }
  },

  async listUserDevices(req: Request, res: Response) {
    try {
      if (!(await accessService.userExists(req.params.userId))) {
        return fail(res, 404, "Usuario no encontrado", "not_found");
      }
      const docs = await accessService.listUserDevices(req.params.userId);
      return ok(res, docs);
    } catch (err) {
      return handle(res, err);
    }
  },

  async summary(req: Request, res: Response) {
    const { error, value } = summarySchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const result = await accessService.summary(value);
      return ok(res, result);
    } catch (err) {
      return handle(res, err);
    }
  },

  async geoPoints(req: Request, res: Response) {
    const { error, value } = geoPointsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const points = await accessService.geoPoints(value);
      return ok(res, points);
    } catch (err) {
      return handle(res, err);
    }
  },
};

function handle(res: Response, err: unknown) {
  console.error("[access] error:", err);
  const msg = err instanceof Error ? err.message : "Error interno";
  return fail(res, 502, `Fallo lectura del PMS: ${msg}`);
}
