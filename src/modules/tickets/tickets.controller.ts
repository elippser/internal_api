import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { ticketsService } from "./tickets.service";
import {
  createTicketSchema,
  listTicketsSchema,
  updateTicketSchema,
} from "./tickets.validation";
import { runTicketingCron } from "./ticketingCron";

export const ticketsController = {
  async list(req: Request, res: Response) {
    const { error, value } = listTicketsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const result = await ticketsService.list(value);
    return ok(res, result);
  },

  async getOne(req: Request, res: Response) {
    const result = await ticketsService.getById(req.params.id);
    if (!result) return fail(res, 404, "Ticket no encontrado", "not_found");
    return ok(res, result);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createTicketSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await ticketsService.create(value);
    return ok(res, doc, 201);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateTicketSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const doc = await ticketsService.update(req.params.id, value);
    if (!doc) return fail(res, 404, "Ticket no encontrado", "not_found");
    return ok(res, doc);
  },

  // Trigger manual del cron (admin+). El startup tambien lo schedulea.
  async runCron(_req: Request, res: Response) {
    try {
      const summary = await runTicketingCron({ triggeredManually: true });
      return ok(res, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      return fail(res, 500, msg);
    }
  },
};
