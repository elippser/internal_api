import { Router, type Request, type Response } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { webStatsService } from "./webStats.service";

// Analitica de los sitios web de los clientes (lectura de siteevents del PMS).
export const webStatsRouter = Router();

webStatsRouter.use(authenticate);
webStatsRouter.use(authorize("analyst"));

const handle = (res: Response, err: unknown) => {
  console.error("[web-stats] error:", err);
  return fail(res, 502, "No se pudo leer la analítica del PMS");
};

webStatsRouter.get("/", async (req: Request, res: Response) => {
  try {
    return ok(res, await webStatsService.overview(req.query.days));
  } catch (err) {
    return handle(res, err);
  }
});

webStatsRouter.get("/:companyId", async (req: Request, res: Response) => {
  const subSiteId =
    typeof req.query.subSiteId === "string" && /^[a-f0-9]{24}$/.test(req.query.subSiteId)
      ? req.query.subSiteId
      : undefined;
  try {
    const data = await webStatsService.company(req.params.companyId, req.query.days, subSiteId);
    if (!data) return fail(res, 404, "Compañía no encontrada", "not_found");
    return ok(res, data);
  } catch (err) {
    return handle(res, err);
  }
});
