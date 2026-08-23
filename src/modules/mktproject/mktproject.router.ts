import { Router, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { htmlToJsx } from "./htmlToJsx";
import { mktprojectService } from "./mktproject.service";

/**
 * El workspace del sitio público. Todo pide `developer`: acá se escribe código
 * que después corre en producción, no configuración.
 */
export const mktprojectRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[mktproject]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

mktprojectRouter.use(authenticate);
mktprojectRouter.use(authorize("developer"));

const relPath = Joi.string().min(1).max(400).required();

// ---------------------------------------------------------------------------
// Estado y árbol
// ---------------------------------------------------------------------------

mktprojectRouter.get("/status", async (_req, res) => {
  try {
    return ok(res, await mktprojectService.status());
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.get("/tree", async (_req, res) => {
  try {
    return ok(res, { data: await mktprojectService.tree() });
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------

mktprojectRouter.get("/file", async (req, res) => {
  const { error, value } = Joi.object({ path: relPath }).validate(req.query);
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, await mktprojectService.readFile(value.path));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.put("/file", async (req, res) => {
  const { error, value } = Joi.object({
    path: relPath,
    content: Joi.string().allow("").required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktprojectService.writeFile(value.path, value.content));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.post("/file", async (req, res) => {
  const { error, value } = Joi.object({
    path: relPath,
    content: Joi.string().allow("").default(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktprojectService.createFile(value.path, value.content), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.post("/dir", async (req, res) => {
  const { error, value } = Joi.object({ path: relPath }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktprojectService.createDir(value.path), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.post("/rename", async (req, res) => {
  const { error, value } = Joi.object({ from: relPath, to: relPath }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktprojectService.rename(value.from, value.to));
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.delete("/entry", async (req, res) => {
  const { error, value } = Joi.object({ path: relPath }).validate(req.query);
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, await mktprojectService.remove(value.path));
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

mktprojectRouter.get("/pages", async (_req, res) => {
  try {
    return ok(res, { data: await mktprojectService.listPages() });
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.post("/pages", async (req, res) => {
  const { error, value } = Joi.object({
    name: Joi.string().min(1).max(120).required(),
    route: Joi.string().min(1).max(300).required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await mktprojectService.createPage(value), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.delete("/pages", async (req, res) => {
  const { error, value } = Joi.object({
    route: Joi.string().min(1).max(300).required(),
  }).validate(req.query);
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, await mktprojectService.deletePage(value.route));
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// site.config.json
// ---------------------------------------------------------------------------

mktprojectRouter.get("/config", async (_req, res) => {
  try {
    return ok(res, await mktprojectService.readConfig());
  } catch (err) {
    return handleErr(res, err);
  }
});

mktprojectRouter.put("/config", async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return fail(res, 400, "Se espera el objeto de configuración", "invalid_body");
  }
  try {
    return ok(res, await mktprojectService.writeConfig(req.body));
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Utilidades del editor
// ---------------------------------------------------------------------------

/**
 * Convierte un bloque de HTML a JSX. Es la misma pasada que usó la migración
 * del sitio viejo; queda expuesta para poder pegar HTML de una plantilla dentro
 * de una página sin salir del panel.
 */
mktprojectRouter.post("/html-to-jsx", async (req, res) => {
  const { error, value } = Joi.object({
    html: Joi.string().allow("").max(2_000_000).required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, htmlToJsx(value.html));
  } catch (err) {
    return handleErr(res, err);
  }
});
