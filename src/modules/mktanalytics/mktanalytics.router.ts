import { Router, type Response } from "express";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { fail, ok } from "../../shared/utils/http";
import {
  ingest,
  ingestSchema,
  overview,
  parseRange,
  realtime,
  recentSessions,
  sessionTimeline,
} from "./mktanalytics.service";
import { journey, JOURNEY_GROUPS, type JourneyGroup } from "./journey.service";

/**
 * Ingesta del sitio de marca. No la llama el navegador: la llama el proxy
 * same-origin `/api/track` de mkt-renderer con `X-Internal-Secret`, que además
 * le agrega el país y el navegador. Se monta en `/public/mkt/events`, con el
 * resto de la superficie que consume el sitio.
 */
export const publicMktEventsRouter = Router();

publicMktEventsRouter.post("/", requireInternalSecret, async (req, res) => {
  const { value, error } = ingestSchema.validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_batch");
  try {
    return ok(res, await ingest(value.events), 202);
  } catch (err) {
    // Telemetría: el sitio no se entera, pero el log sí.
    console.error("[mkt-analytics] ingesta:", err);
    return ok(res, { accepted: 0, dropped: value.events.length }, 202);
  }
});

/** Tablero Marketing › Tráfico (`/api/v1/mkt/analytics/*`). */
export const mktAnalyticsRouter = Router();

mktAnalyticsRouter.use(authenticate, authorize("analyst"));

function handleErr(res: Response, err: unknown) {
  console.error("[mkt-analytics]", err);
  return fail(res, 500, "No se pudo calcular la analítica del sitio", "mkt_analytics_failed");
}

mktAnalyticsRouter.get("/overview", async (req, res) => {
  try {
    return ok(res, await overview(parseRange(req.query as Record<string, string>)));
  } catch (err) {
    return handleErr(res, err);
  }
});

/** El recorrido de alta: del sitio al final del onboarding (`journey.service`). */
mktAnalyticsRouter.get("/journey", async (req, res) => {
  const q = req.query as Record<string, string>;
  const group = (JOURNEY_GROUPS as readonly string[]).includes(q.group) ? (q.group as JourneyGroup) : "channel";
  try {
    return ok(res, await journey(parseRange(q), group));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktAnalyticsRouter.get("/realtime", async (_req, res) => {
  try {
    return ok(res, await realtime());
  } catch (err) {
    return handleErr(res, err);
  }
});

mktAnalyticsRouter.get("/sessions", async (req, res) => {
  try {
    const q = req.query as Record<string, string>;
    return ok(res, { data: await recentSessions(parseRange(q), Number(q.limit) || 40) });
  } catch (err) {
    return handleErr(res, err);
  }
});

mktAnalyticsRouter.get("/sessions/:sid", async (req, res) => {
  const sid = String(req.params.sid);
  if (!/^[a-z0-9]{1,64}$/.test(sid)) return fail(res, 400, "sid invalido", "invalid_sid");
  try {
    return ok(res, { data: await sessionTimeline(sid) });
  } catch (err) {
    return handleErr(res, err);
  }
});
