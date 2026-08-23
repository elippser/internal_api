import { Router, type Request, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { REVIEW_SOURCES } from "./reputation.model";
import { reputationService } from "./reputation.service";

export const reputationRouter = Router();
/** Encuesta NPS publica: la responde el cliente desde el link del mail. */
export const publicNpsRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[reputation]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

// ---------------------------------------------------------------------------
// Publico
// ---------------------------------------------------------------------------

publicNpsRouter.get("/:token", async (req: Request, res: Response) => {
  try {
    return ok(res, await reputationService.getNpsByToken(req.params.token));
  } catch (err) {
    return handleErr(res, err);
  }
});

publicNpsRouter.post("/:token", async (req: Request, res: Response) => {
  const { error, value } = Joi.object({
    score: Joi.number().integer().min(0).max(10).required(),
    comment: Joi.string().max(4000).allow(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(
      res,
      await reputationService.submitNps(req.params.token, value.score, value.comment),
    );
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Operador interno
// ---------------------------------------------------------------------------

reputationRouter.use(authenticate);

reputationRouter.get("/dashboard", authorize("analyst"), async (_req, res) => {
  try {
    return ok(res, await reputationService.dashboard());
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.get("/reviews", authorize("analyst"), async (req, res) => {
  try {
    return ok(res, {
      data: await reputationService.listReviews({
        source: req.query.source as never,
        unanswered: req.query.unanswered === "1",
      }),
    });
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.post("/reviews", authorize("analyst"), async (req, res) => {
  const { error, value } = Joi.object({
    source: Joi.string()
      .valid(...REVIEW_SOURCES)
      .required(),
    rating: Joi.number().min(0).max(5),
    text: Joi.string().max(8000).allow(""),
    authorName: Joi.string().max(200).allow(""),
    url: Joi.string().max(600).allow(""),
    externalId: Joi.string().max(200).allow(""),
    publishedAt: Joi.date(),
    accountId: Joi.string().max(120).allow(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await reputationService.createReview(value), 201);
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.patch("/reviews/:id", authorize("analyst"), async (req, res) => {
  const { error, value } = Joi.object({
    responseText: Joi.string().max(8000).allow(""),
    respondedAt: Joi.date(),
    sentiment: Joi.string().valid("positive", "neutral", "negative"),
    rating: Joi.number().min(0).max(5),
    text: Joi.string().max(8000).allow(""),
  })
    .min(1)
    .validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(res, await reputationService.updateReview(req.params.id, value));
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.delete("/reviews/:id", authorize("admin"), async (req, res) => {
  try {
    return ok(res, await reputationService.deleteReview(req.params.id));
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.get("/nps", authorize("analyst"), async (_req, res) => {
  try {
    return ok(res, { data: await reputationService.listNps() });
  } catch (err) {
    return handleErr(res, err);
  }
});

reputationRouter.post("/nps/invite", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    accountId: Joi.string().required(),
    contactId: Joi.string().allow(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    return ok(
      res,
      await reputationService.createNpsInvite(value.accountId, value.contactId || undefined),
      201,
    );
  } catch (err) {
    return handleErr(res, err);
  }
});
