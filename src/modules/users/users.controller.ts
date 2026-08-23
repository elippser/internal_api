import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { usersService } from "./users.service";
import {
  createUserSchema,
  listUsersSchema,
  updateUserSchema,
} from "./users.validation";

export const usersController = {
  async list(req: Request, res: Response) {
    const { error, value } = listUsersSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");

    const { page, limit, skip } = parsePagination(value);
    const result = await usersService.list({
      role: value.role,
      status: value.status,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createUserSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");

    try {
      const user = await usersService.create(value);
      return ok(res, user, 201);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return fail(res, status, (err as Error).message);
    }
  },

  async getOne(req: Request, res: Response) {
    const user = await usersService.getById(req.params.id);
    if (!user) return fail(res, 404, "Usuario no encontrado", "not_found");
    return ok(res, user);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateUserSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const user = await usersService.update(req.params.id, value);
    if (!user) return fail(res, 404, "Usuario no encontrado", "not_found");
    return ok(res, user);
  },

  async remove(req: Request, res: Response) {
    const user = await usersService.softDelete(req.params.id);
    if (!user) return fail(res, 404, "Usuario no encontrado", "not_found");
    return ok(res, user);
  },
};
