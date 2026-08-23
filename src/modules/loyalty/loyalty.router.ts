import { Router, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { makeId } from "../../shared/utils/ids";
import { fail, ok } from "../../shared/utils/http";
import { MktAccount } from "../crm/crm.model";
import { segmentsService } from "../crm/segments.service";
import {
  DISCOUNT_TYPES,
  MktCoupon,
  MktRedemption,
  MktReferral,
  sanitize,
} from "./loyalty.model";

export const loyaltyRouter = Router();

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[loyalty]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

loyaltyRouter.use(authenticate);

// ---------- Cupones ----------

loyaltyRouter.get("/coupons", authorize("analyst"), async (_req, res) => {
  try {
    const rows = await MktCoupon.find().sort({ createdAt: -1 }).lean();
    return ok(res, { data: rows.map(sanitize) });
  } catch (err) {
    return handleErr(res, err);
  }
});

loyaltyRouter.post("/coupons", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    code: Joi.string().min(3).max(40).required(),
    description: Joi.string().max(500).allow(""),
    discountType: Joi.string()
      .valid(...DISCOUNT_TYPES)
      .required(),
    value: Joi.number().min(0).required(),
    validFrom: Joi.date(),
    validUntil: Joi.date().required(),
    maxUses: Joi.number().integer().min(1),
    restrictToSegmentId: Joi.string().allow(""),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    const userId = req.internalUser?.userId ?? "unknown";
    const doc = await MktCoupon.create({
      ...value,
      couponId: makeId("cpn"),
      createdByUserId: userId,
    });
    return ok(res, sanitize(doc.toObject()), 201);
  } catch (err: any) {
    if (err?.code === 11000) {
      return fail(res, 409, "Ya existe un cupon con ese codigo", "duplicate");
    }
    return handleErr(res, err);
  }
});

loyaltyRouter.patch("/coupons/:id", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    description: Joi.string().max(500).allow(""),
    validUntil: Joi.date(),
    maxUses: Joi.number().integer().min(1),
    active: Joi.boolean(),
    restrictToSegmentId: Joi.string().allow(""),
  })
    .min(1)
    .validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");
  try {
    const doc = await MktCoupon.findOneAndUpdate(
      { couponId: req.params.id },
      { $set: value },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) return fail(res, 404, "Cupon no encontrado", "not_found");
    return ok(res, sanitize(doc));
  } catch (err) {
    return handleErr(res, err);
  }
});

/**
 * Canje. Valida vigencia, tope de usos y pertenencia al segmento; el unico-por-
 * cuenta lo garantiza el indice unico de `mkt_coupon_redemptions`.
 */
loyaltyRouter.post("/coupons/:code/redeem", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    accountId: Joi.string().required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    const coupon = await MktCoupon.findOne({
      code: String(req.params.code).toUpperCase(),
    });
    if (!coupon) return fail(res, 404, "Cupon no encontrado", "not_found");
    if (!coupon.active) return fail(res, 400, "El cupon esta desactivado", "inactive");

    const now = Date.now();
    if (coupon.validFrom && coupon.validFrom.getTime() > now) {
      return fail(res, 400, "El cupon todavia no empezo", "not_started");
    }
    if (coupon.validUntil && coupon.validUntil.getTime() < now) {
      return fail(res, 400, "El cupon vencio", "expired");
    }
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
      return fail(res, 400, "El cupon llego a su tope de usos", "exhausted");
    }

    const account = await MktAccount.findOne({ accountId: value.accountId }).lean();
    if (!account) return fail(res, 404, "Cuenta no encontrada", "not_found");

    if (coupon.restrictToSegmentId) {
      const { data } = await segmentsService.resolveAccounts(
        coupon.restrictToSegmentId,
        5000,
      );
      const allowed = (data as any[]).some((a) => a.accountId === value.accountId);
      if (!allowed) {
        return fail(res, 403, "La cuenta no pertenece al segmento del cupon", "not_in_segment");
      }
    }

    try {
      await MktRedemption.create({
        redemptionId: makeId("rdm"),
        couponId: coupon.couponId,
        accountId: value.accountId,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return fail(res, 409, "Esta cuenta ya uso el cupon", "already_redeemed");
      }
      throw err;
    }

    coupon.set("usedCount", coupon.usedCount + 1);
    await coupon.save();

    return ok(res, {
      redeemed: true,
      discountType: coupon.discountType,
      value: coupon.value,
    });
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------- Referidos ----------

loyaltyRouter.get("/referrals", authorize("analyst"), async (_req, res) => {
  try {
    const rows = await MktReferral.find().sort({ createdAt: -1 }).limit(300).lean();
    return ok(res, { data: rows.map(sanitize) });
  } catch (err) {
    return handleErr(res, err);
  }
});

loyaltyRouter.post("/referrals", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    referrerAccountId: Joi.string().required(),
    referredEmail: Joi.string()
      .email({ tlds: { allow: false } })
      .required(),
  }).validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    const doc = await MktReferral.create({
      ...value,
      referralId: makeId("ref"),
    });
    return ok(res, sanitize(doc.toObject()), 201);
  } catch (err: any) {
    if (err?.code === 11000) {
      return fail(res, 409, "Esa cuenta ya invito a ese email", "duplicate");
    }
    return handleErr(res, err);
  }
});

loyaltyRouter.patch("/referrals/:id", authorize("developer"), async (req, res) => {
  const { error, value } = Joi.object({
    status: Joi.string().valid(
      "invited",
      "signed_up",
      "converted",
      "rewarded",
      "expired",
    ),
    referredAccountId: Joi.string().allow(""),
    rewardCouponId: Joi.string().allow(""),
  })
    .min(1)
    .validate(req.body);
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    if (value.status === "converted") value.convertedAt = new Date();
    const doc = await MktReferral.findOneAndUpdate(
      { referralId: req.params.id },
      { $set: value },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) return fail(res, 404, "Referido no encontrado", "not_found");
    return ok(res, sanitize(doc));
  } catch (err) {
    return handleErr(res, err);
  }
});
