import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import {
  CONNECTOR_NAMES,
  deleteWatchpoint,
  getHealth,
  getSummary,
  ingestAll,
  ingestConnector,
  listSignals,
  listWatchpoints,
  upsertWatchpoint,
} from "./intelligence.service";
import {
  ingestParamsSchema,
  ingestQuerySchema,
  listSignalsSchema,
  watchpointBodySchema,
  watchpointParamsSchema,
} from "./intelligence.validation";

export const intelligenceController = {
  async signals(req: Request, res: Response) {
    const { error, value } = listSignalsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    const data = await listSignals(value);
    return ok(res, { signals: data, total: data.length });
  },

  // Snapshot agregado para el radar (una sola llamada pinta todas las capas).
  async summary(_req: Request, res: Response) {
    return ok(res, await getSummary());
  },

  async health(_req: Request, res: Response) {
    return ok(res, await getHealth());
  },

  // Trigger manual de ingesta: POST /ingest/:connector (o "all"). Con
  // ?pointIds=a,b el barrido es dirigido solo a esos puntos (alta de property).
  async ingest(req: Request, res: Response) {
    const { error, value } = ingestParamsSchema.validate(req.params);
    if (error) return fail(res, 400, error.message, "invalid_params");
    const q = ingestQuerySchema.validate(req.query);
    if (q.error) return fail(res, 400, q.error.message, "invalid_query");
    const pointIds = (q.value.pointIds ?? "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const opts = pointIds.length ? { pointIds } : {};
    try {
      if (value.connector === "all") {
        return ok(res, { runs: await ingestAll("manual") });
      }
      return ok(res, await ingestConnector(value.connector, "manual", opts));
    } catch (err) {
      return fail(res, 500, err instanceof Error ? err.message : "Error desconocido");
    }
  },

  // Puntos de barrido (property-driven): PUT /watchpoints/:pointId
  async upsertWatchpoint(req: Request, res: Response) {
    const p = watchpointParamsSchema.validate(req.params);
    if (p.error) return fail(res, 400, p.error.message, "invalid_params");
    const b = watchpointBodySchema.validate(req.body);
    if (b.error) return fail(res, 400, b.error.message, "invalid_body");
    return ok(res, await upsertWatchpoint(p.value.pointId, b.value));
  },

  async watchpoints(_req: Request, res: Response) {
    const points = await listWatchpoints();
    return ok(res, { watchpoints: points, total: points.length });
  },

  async deleteWatchpoint(req: Request, res: Response) {
    const p = watchpointParamsSchema.validate(req.params);
    if (p.error) return fail(res, 400, p.error.message, "invalid_params");
    const deleted = await deleteWatchpoint(p.value.pointId);
    return ok(res, { deleted });
  },

  async connectors(_req: Request, res: Response) {
    return ok(res, { connectors: CONNECTOR_NAMES });
  },
};
