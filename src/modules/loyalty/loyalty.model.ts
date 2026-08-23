import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Traduccion B2B del modulo de fidelizacion de la spec original: en vez de
 * descuentos por reserva directa del huesped, descuentos de plan y referidos
 * entre hoteles.
 */

export const DISCOUNT_TYPES = ["percent", "fixed", "free_months"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

const couponSchema = new Schema(
  {
    couponId: { type: String, required: true, unique: true, index: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: "" },
    discountType: { type: String, enum: DISCOUNT_TYPES, required: true },
    value: { type: Number, required: true, min: 0 },
    validFrom: { type: Date, default: () => new Date() },
    validUntil: { type: Date, required: true },
    maxUses: { type: Number, required: false, min: 1 },
    usedCount: { type: Number, default: 0 },
    /** Solo canjeable por cuentas del segmento (ej: cupon de reactivacion). */
    restrictToSegmentId: { type: String, required: false },
    active: { type: Boolean, default: true, index: true },
    createdByUserId: { type: String, default: "system" },
  },
  { timestamps: true, collection: "mkt_coupons" },
);

export type MktCouponDoc = InferSchemaType<typeof couponSchema>;
export const MktCoupon = model("MktCoupon", couponSchema);

const redemptionSchema = new Schema(
  {
    redemptionId: { type: String, required: true, unique: true, index: true },
    couponId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    redeemedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: "mkt_coupon_redemptions" },
);

// Una cuenta canjea un cupon una sola vez.
redemptionSchema.index({ couponId: 1, accountId: 1 }, { unique: true });

export type MktRedemptionDoc = InferSchemaType<typeof redemptionSchema>;
export const MktRedemption = model("MktRedemption", redemptionSchema);

export const REFERRAL_STATUSES = [
  "invited",
  "signed_up",
  "converted",
  "rewarded",
  "expired",
] as const;

const referralSchema = new Schema(
  {
    referralId: { type: String, required: true, unique: true, index: true },
    referrerAccountId: { type: String, required: true, index: true },
    referredAccountId: { type: String, required: false, index: true },
    referredEmail: { type: String, required: true, lowercase: true, trim: true },
    status: {
      type: String,
      enum: REFERRAL_STATUSES,
      default: "invited",
      index: true,
    },
    rewardCouponId: { type: String, required: false },
    invitedAt: { type: Date, default: () => new Date() },
    convertedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_referrals" },
);

// No se invita dos veces al mismo mail desde la misma cuenta.
referralSchema.index({ referrerAccountId: 1, referredEmail: 1 }, { unique: true });

export type MktReferralDoc = InferSchemaType<typeof referralSchema>;
export const MktReferral = model("MktReferral", referralSchema);

export function sanitize<T>(doc: T): T {
  if (!doc) return doc;
  const obj =
    doc && typeof doc === "object" && "toObject" in (doc as object)
      ? (doc as unknown as { toObject: () => Record<string, unknown> }).toObject()
      : (doc as unknown as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}
