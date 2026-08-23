import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { crmService } from "./crm.service";
import { segmentsService } from "./segments.service";
import {
  createAccountSchema,
  createContactSchema,
  importAccountsSchema,
  ingestEventSchema,
  listAccountsSchema,
  listEventsSchema,
  segmentSchema,
  updateAccountSchema,
  updateContactSchema,
} from "./crm.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[crm]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

export const crmController = {
  // ---------- Cuentas ----------

  async listAccounts(req: Request, res: Response) {
    const { error, value } = listAccountsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const { page, limit, skip } = parsePagination(value);
      const r = await crmService.listAccounts({ ...value, page, limit, skip });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async getAccount(req: Request, res: Response) {
    try {
      return ok(res, await crmService.getAccount(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async createAccount(req: Request, res: Response) {
    const { error, value } = createAccountSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await crmService.createAccount(value), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async updateAccount(req: Request, res: Response) {
    const { error, value } = updateAccountSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await crmService.updateAccount(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async importAccounts(req: Request, res: Response) {
    const { error, value } = importAccountsSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await crmService.importAccounts(value.rows));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---------- Contactos ----------

  async listContacts(req: Request, res: Response) {
    try {
      const accountId =
        typeof req.query.accountId === "string" ? req.query.accountId : undefined;
      return ok(res, { data: await crmService.listContacts(accountId) });
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async createContact(req: Request, res: Response) {
    const { error, value } = createContactSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await crmService.createContact(value), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async updateContact(req: Request, res: Response) {
    const { error, value } = updateContactSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await crmService.updateContact(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async deleteContact(req: Request, res: Response) {
    try {
      return ok(res, await crmService.deleteContact(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---------- Eventos ----------

  /**
   * Ingesta server-to-server. Responde 200 tambien cuando el evento ya existia:
   * el emisor es fire-and-forget y un 409 lo obligaria a distinguir errores que
   * no le importan.
   */
  async ingestEvent(req: Request, res: Response) {
    const { error, value } = ingestEventSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const r = await crmService.ingestEvent(value);
      return ok(res, r, r.duplicate ? 200 : 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async listEvents(req: Request, res: Response) {
    const { error, value } = listEventsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const { page, limit, skip } = parsePagination(value);
      const r = await crmService.listEvents({ ...value, page, limit, skip });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async drainOutbox(_req: Request, res: Response) {
    try {
      return ok(res, await crmService.drainOutbox());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---------- Segmentos ----------

  async listSegments(_req: Request, res: Response) {
    try {
      return ok(res, { data: await segmentsService.list() });
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async getSegment(req: Request, res: Response) {
    try {
      return ok(res, await segmentsService.getOne(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async createSegment(req: Request, res: Response) {
    const { error, value } = segmentSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const userId = req.internalUser?.userId ?? "unknown";
      return ok(res, await segmentsService.create(value, userId), 201);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async updateSegment(req: Request, res: Response) {
    const { error, value } = segmentSchema
      .fork(["name"], (s) => s.optional())
      .min(1)
      .validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await segmentsService.update(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async deleteSegment(req: Request, res: Response) {
    try {
      return ok(res, await segmentsService.remove(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async segmentAccounts(req: Request, res: Response) {
    try {
      return ok(res, await segmentsService.resolveAccounts(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---------- Tablero ----------

  async dashboard(_req: Request, res: Response) {
    try {
      return ok(res, await crmService.dashboard());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ---------- Sincronizacion ----------

  async backfill(_req: Request, res: Response) {
    try {
      return ok(res, await crmService.backfillFromPms());
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async refreshStats(_req: Request, res: Response) {
    try {
      return ok(res, await crmService.refreshStats());
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
