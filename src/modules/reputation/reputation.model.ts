import { Schema, model, type InferSchemaType } from "mongoose";

export const REVIEW_SOURCES = [
  "google",
  "capterra",
  "g2",
  "software_advice",
  "direct",
  "social",
] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const SOURCE_LABELS: Record<ReviewSource, string> = {
  google: "Google Business",
  capterra: "Capterra",
  g2: "G2",
  software_advice: "Software Advice",
  direct: "Encuesta propia",
  social: "Redes",
};

const reviewSchema = new Schema(
  {
    reviewId: { type: String, required: true, unique: true, index: true },
    source: { type: String, enum: REVIEW_SOURCES, required: true, index: true },
    rating: { type: Number, min: 0, max: 5 },
    text: { type: String, default: "" },
    authorName: { type: String, default: "" },
    url: { type: String, default: "" },
    /** Id en el origen. Evita duplicar al reimportar. */
    externalId: { type: String, required: false },
    publishedAt: { type: Date, default: () => new Date(), index: true },
    respondedAt: { type: Date, required: false },
    responseText: { type: String, default: "" },
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative"],
      required: false,
      index: true,
    },
    /** Ninguno de estos directorios tiene API de lectura publica: casi todo entra a mano. */
    ingestion: { type: String, enum: ["manual", "api"], default: "manual" },
    accountId: { type: String, required: false, index: true },
  },
  { timestamps: true, collection: "mkt_reviews" },
);

reviewSchema.index(
  { source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } },
);

export type MktReviewDoc = InferSchemaType<typeof reviewSchema>;
export const MktReview = model("MktReview", reviewSchema);

// ---------------------------------------------------------------------------
// NPS
// ---------------------------------------------------------------------------

const npsSchema = new Schema(
  {
    npsId: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: true, index: true },
    contactId: { type: String, required: false },
    /** Token del link enviado. Es lo que autentica la respuesta publica. */
    token: { type: String, required: true, unique: true, index: true },
    score: { type: Number, min: 0, max: 10, required: false },
    comment: { type: String, default: "" },
    /**
     * Ruteo por score. Promotor (9-10) recibe el pedido de reseña publica;
     * detractor (0-6) se escala al equipo y NO se lo empuja a reseñar. Es lo
     * estandar de la industria y evita reseñas negativas evitables.
     */
    followUpStatus: {
      type: String,
      enum: ["none", "review_requested", "escalated", "resolved"],
      default: "none",
      index: true,
    },
    sentAt: { type: Date, default: () => new Date() },
    submittedAt: { type: Date, required: false, index: true },
    expiresAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_nps" },
);

export type MktNpsDoc = InferSchemaType<typeof npsSchema>;
export const MktNps = model("MktNps", npsSchema);

export function npsCategory(score: number): "promoter" | "passive" | "detractor" {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

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
