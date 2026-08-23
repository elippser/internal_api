import { Router, type Request, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { mktsiteService } from "./mktsite.service";

export const mktsiteRouter = Router();

/**
 * Sirve el sitio publicado en /s/:slug. Sin JWT.
 *
 * DEPRECADO. El sitio de bookfer se mudó a `public-side/mkt-renderer`, un repo
 * Next que el panel edita como proyecto (ver el módulo `mktproject`). Esto
 * queda en pie porque el sitio viejo sigue publicado en Mongo y despublicarlo
 * es una decisión, no un efecto secundario de la migración: mientras la fila
 * exista, /s/:slug la sigue sirviendo.
 *
 * Lo que NO está deprecado de este módulo: la captura de leads, las
 * conversiones server-side y el token de la Conversions API, que siguen siendo
 * los de siempre y los usa el sitio nuevo.
 */
export const publicSiteRouter = Router();
/** Recibe el formulario de captura. Se monta aparte, en /public/mkt/leads. */
export const publicLeadRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[mktsite]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

const seo = Joi.object({
  title: Joi.string().max(200).allow(""),
  description: Joi.string().max(500).allow(""),
  ogImage: Joi.string().max(600).allow(""),
  noindex: Joi.boolean(),
});

const siteSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  slug: Joi.string().max(120).allow(""),
  status: Joi.string().valid("draft", "published"),
  defaultLanguage: Joi.string().max(10),
  favicon: Joi.string().max(600).allow(""),
  seo,
  pixels: Joi.object({
    metaPixelId: Joi.string().max(60).allow(""),
    metaCapiToken: Joi.string().max(400).allow(""),
    googleAdsConversionId: Joi.string().max(60).allow(""),
    googleAdsConversionLabel: Joi.string().max(80).allow(""),
    ga4MeasurementId: Joi.string().max(60).allow(""),
    gtmContainerId: Joi.string().max(60).allow(""),
  }),
  headHtml: Joi.string().max(50_000).allow(""),
  bodyEndHtml: Joi.string().max(50_000).allow(""),
});

const pageSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  path: Joi.string().max(300),
  status: Joi.string().valid("draft", "published"),
  html: Joi.string().max(500_000).allow(""),
  css: Joi.string().max(200_000).allow(""),
  js: Joi.string().max(200_000).allow(""),
  seo,
});

// ---------------------------------------------------------------------------
// Publico
// ---------------------------------------------------------------------------

/** Rate-limit en memoria: 10 envios por IP cada 10 minutos. */
const leadHits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = leadHits.get(ip);
  if (!entry || entry.resetAt < now) {
    leadHits.set(ip, { count: 1, resetAt: now + 10 * 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

publicLeadRouter.post("/", async (req: Request, res: Response) => {
  const ip = req.ip ?? "unknown";
  if (rateLimited(ip)) {
    return fail(res, 429, "Demasiados envios, intenta mas tarde", "rate_limited");
  }

  const { error, value } = Joi.object({
    name: Joi.string().max(160).allow(""),
    // `tlds: false`: la lista de TLDs que trae Joi se queda vieja y rechazar el
    // mail de un prospecto real por eso es mucho peor que aceptar uno raro.
    email: Joi.string()
      .email({ tlds: { allow: false } })
      .required(),
    phone: Joi.string().max(40).allow(""),
    company: Joi.string().max(200).allow(""),
    message: Joi.string().max(4000).allow(""),
    siteId: Joi.string().max(120).allow(""),
    utm: Joi.object().pattern(Joi.string(), Joi.string().max(200)),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    await mktsiteService.captureLead(value);
    // No se devuelve si la cuenta ya existia: es informacion sobre quien esta
    // en la base de bookfer y este endpoint es publico.
    return ok(res, { received: true }, 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

/**
 * Sirve el sitio publicado. `?preview=1` sirve el borrador (iframe del editor).
 *
 * Dos rutas y no un patron con wildcard opcional: este repo usa Express 4, que
 * no entiende la sintaxis `{/*path}` de Express 5 — con ella la ruta no
 * matcheaba nunca y todo caia en el 404 global.
 */
async function servePage(req: Request, res: Response) {
  try {
    const rest = (req.params as Record<string, string>)[0];
    const path = rest ? `/${rest}` : "/";
    const preview = req.query.preview === "1";
    const html = await mktsiteService.renderPage(req.params.slug, path, preview);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (preview) res.setHeader("Cache-Control", "no-store");
    return res.send(html);
  } catch (err: any) {
    const status = err?.status ?? 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res
      .status(status)
      .send(
        `<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font-family:system-ui;padding:60px;text-align:center"><h1>${status}</h1><p>${err?.message ?? "Error"}</p></body>`,
      );
  }
}

publicSiteRouter.get("/:slug", servePage);
publicSiteRouter.get("/:slug/*", servePage);

// ---------------------------------------------------------------------------
// Operador interno
// ---------------------------------------------------------------------------

mktsiteRouter.use(authenticate);

mktsiteRouter.get("/conversions", authorize("analyst"), async (_req, res) => {
  try {
    return ok(res, { data: await mktsiteService.listConversions() });
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.post("/conversions", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    siteId: Joi.string().max(120),
    accountId: Joi.string().max(120),
    eventName: Joi.string().max(80).required(),
    eventId: Joi.string().max(120),
    email: Joi.string().email(),
    phone: Joi.string().max(40),
    value: Joi.number().min(0),
    currency: Joi.string().max(8),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktsiteService.trackConversion(value), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

// Paginas — antes de "/:id" para no capturarlas como siteId.
mktsiteRouter.get("/pages/:pageId", authorize("analyst"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.getPage(req.params.pageId));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.patch("/pages/:pageId", authorize("developer"), async (req, res) => {
  const { error, value } = pageSchema
    .fork(["name"], (s) => s.optional())
    .min(1)
    .validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktsiteService.updatePage(req.params.pageId, value));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.delete("/pages/:pageId", authorize("developer"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.deletePage(req.params.pageId));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.post("/pages/:pageId/publish", authorize("developer"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.publishPage(req.params.pageId));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.post("/pages/:pageId/unpublish", authorize("developer"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.unpublishPage(req.params.pageId));
  } catch (err) {
    return handleErr(res, err);
  }
});

// Sitios
mktsiteRouter.get("/", authorize("analyst"), async (_req, res) => {
  try {
    return ok(res, { data: await mktsiteService.listSites() });
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.post("/", authorize("developer"), async (req, res) => {
  const { error, value } = siteSchema.validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    const userId = req.internalUser?.userId ?? "unknown";
    return ok(res, await mktsiteService.createSite(value, userId), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.get("/:id", authorize("analyst"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.getSite(req.params.id));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.patch("/:id", authorize("developer"), async (req, res) => {
  const { error, value } = siteSchema
    .fork(["name"], (s) => s.optional())
    .min(1)
    .validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktsiteService.updateSite(req.params.id, value));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.delete("/:id", authorize("admin"), async (req, res) => {
  try {
    return ok(res, await mktsiteService.deleteSite(req.params.id));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktsiteRouter.post("/:id/pages", authorize("developer"), async (req, res) => {
  const { error, value } = pageSchema.validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktsiteService.createPage(req.params.id, value), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});
