import type { Request, Response } from "express";
import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import { APP_CATALOG } from "./contracts.model";
import { contractsService } from "./contracts.service";
import {
  associateSchema,
  checkCreditsSchema,
  createContractSchema,
  listContractsSchema,
  updateContractSchema,
  updateStatusSchema,
} from "./contracts.validation";

export const contractsController = {
  // Catalogo de apps (para que el front arme los toggles).
  async catalog(_req: Request, res: Response) {
    return ok(res, { apps: APP_CATALOG });
  },

  async list(req: Request, res: Response) {
    const { error, value } = listContractsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const { page, limit, skip } = parsePagination(value);
    const result = await contractsService.list({
      status: value.status,
      companyId: value.companyId,
      search: value.search,
      page,
      limit,
      skip,
    });
    return paginated(res, result.data, result.total, result.page, result.limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await contractsService.getOne(req.params.id);
    if (!doc) return fail(res, 404, "Contrato no encontrado", "not_found");
    return ok(res, doc);
  },

  async create(req: Request, res: Response) {
    const { error, value } = createContractSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const userId = req.internalUser?.userId ?? "unknown";
    const doc = await contractsService.create(value, userId);
    return ok(res, doc, 201);
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateContractSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await contractsService.update(req.params.id, value);
      return ok(res, doc);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async associate(req: Request, res: Response) {
    const { error, value } = associateSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await contractsService.associate(
        req.params.id,
        value.companyIds,
      );
      return ok(res, doc);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // Balance por company del contrato (para el dashboard).
  async contractCredits(req: Request, res: Response) {
    const data = await contractsService.getContractCredits(req.params.id);
    return ok(res, { data });
  },

  async updateStatus(req: Request, res: Response) {
    const { error, value } = updateStatusSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const doc = await contractsService.updateStatus(req.params.id, value.status);
      return ok(res, doc);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // Balance de creditos de una company (dashboard, analyst+).
  async companyCredits(req: Request, res: Response) {
    const credits = await contractsService.getCompanyCredits(
      req.params.companyId,
    );
    return ok(res, credits);
  },

  // Decision de enforcement (server-to-server, X-Internal-Secret). La usa
  // pms-core/api antes de cada turno del editor.
  async checkCredits(req: Request, res: Response) {
    const { error, value } = checkCreditsSchema.validate(req.body);
    if (error) return fail(res, 400, error.message, "invalid_body");
    const result = await contractsService.checkCredits(value.companyId);
    return ok(res, result);
  },
};

function handleErr(res: Response, err: unknown) {
  const e = err as { status?: number; message?: string; code?: string };
  return fail(
    res,
    e.status ?? 500,
    e.message ?? "Error interno",
    e.code ?? "error",
  );
}
