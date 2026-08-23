import { Router, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { plansCodeService } from "./planscode.service";

/**
 * El workspace de código de las pantallas de planes.
 *
 * Todo pide `developer`, igual que el workspace del sitio: acá se escribe
 * código que después corre en producción, no configuración.
 */
export const plansCodeRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[planscode]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

plansCodeRouter.use(authenticate);
plansCodeRouter.use(authorize("developer"));

const target = Joi.string().valid("pms", "mkt").required();
const relPath = Joi.string().min(1).max(400).required();

plansCodeRouter.get("/targets", async (_req, res) => {
  try {
    return ok(res, { data: await plansCodeService.targets() });
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.get("/tree", async (req, res) => {
  const { error, value } = Joi.object({ target }).validate(req.query);
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, { data: await plansCodeService.tree(value.target) });
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.get("/file", async (req, res) => {
  const { error, value } = Joi.object({ target, path: relPath }).validate(
    req.query,
  );
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, await plansCodeService.readFile(value.target, value.path));
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.put("/file", async (req, res) => {
  const { error, value } = Joi.object({
    target,
    path: relPath,
    content: Joi.string().allow("").required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(
      res,
      await plansCodeService.writeFile(value.target, value.path, value.content),
    );
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.post("/file", async (req, res) => {
  const { error, value } = Joi.object({
    target,
    path: relPath,
    content: Joi.string().allow("").default(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(
      res,
      await plansCodeService.createFile(value.target, value.path, value.content),
      201,
    );
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.post("/rename", async (req, res) => {
  const { error, value } = Joi.object({
    target,
    from: relPath,
    to: relPath,
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await plansCodeService.rename(value.target, value.from, value.to));
  } catch (err) {
    return handleErr(res, err);
  }
});

plansCodeRouter.delete("/entry", async (req, res) => {
  const { error, value } = Joi.object({ target, path: relPath }).validate(
    req.query,
  );
  if (error) return fail(res, 400, error.message, "invalid_query");
  try {
    return ok(res, await plansCodeService.remove(value.target, value.path));
  } catch (err) {
    return handleErr(res, err);
  }
});
