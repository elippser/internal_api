import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { dnsService, type Actor } from "./dns.service";
import {
  changelogSchema,
  createRecordSchema,
  listRecordsSchema,
  removeRecordSchema,
  updateRecordSchema,
} from "./dns.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[dns]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

/** El `authenticate` ya corrio, asi que `internalUser` esta. */
function actorOf(req: Request): Actor {
  const u = req.internalUser!;
  return { userId: u.userId, email: u.email };
}

export const dnsController = {
  /** Nunca falla: el estado "sin configurar" es una respuesta valida. */
  async status(_req: Request, res: Response) {
    try {
      return ok(res, await dnsService.status());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async list(req: Request, res: Response) {
    const { error, value } = listRecordsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await dnsService.list(value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async audit(_req: Request, res: Response) {
    try {
      return ok(res, await dnsService.audit());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async create(req: Request, res: Response) {
    const { error, value } = createRecordSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const { force, ...input } = value;
    try {
      const rec = await dnsService.create(input, actorOf(req), force);
      return ok(res, rec, 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateRecordSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const { force, ...patch } = value;
    try {
      const rec = await dnsService.update(req.params.id, patch, actorOf(req), force);
      return ok(res, rec);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async remove(req: Request, res: Response) {
    // El `force` del borrado viaja por querystring: DELETE con body no lo
    // mandan todos los clientes y axios lo esconde en `config.data`.
    const { error, value } = removeRecordSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      await dnsService.remove(req.params.id, actorOf(req), value.force);
      return ok(res, { deleted: true });
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async changelog(req: Request, res: Response) {
    const { error, value } = changelogSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, { data: await dnsService.changelog(value.limit) });
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
