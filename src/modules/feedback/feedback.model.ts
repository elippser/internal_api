import { Schema, model, type InferSchemaType } from "mongoose";

export const FEEDBACK_CATEGORIES = [
  "integration",
  "payment",
  "reporting",
  "feature",
  "bug",
  "ui_ux",
  "other",
] as const;

export const FEEDBACK_CONFIDENCES = ["high", "medium", "low"] as const;

export const FEEDBACK_STATUSES = [
  "new",
  "reviewed",
  "linked_to_ticket",
  "discarded",
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackConfidence = (typeof FEEDBACK_CONFIDENCES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const classificationSchema = new Schema(
  {
    intent: { type: String, default: "" },
    category: {
      type: String,
      enum: FEEDBACK_CATEGORIES,
      default: "other",
    },
    confidence: {
      type: String,
      enum: FEEDBACK_CONFIDENCES,
      default: "medium",
    },
    summary: { type: String, default: "" },
  },
  { _id: false },
);

const feedbackSchema = new Schema(
  {
    feedbackId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    companyId: { type: String, default: null, index: true },
    propertyId: { type: String, default: null },
    rawUserMessage: { type: String, default: "" },
    agentResponse: { type: String, default: "" },
    classification: { type: classificationSchema, default: () => ({}) },
    userConfirmed: { type: Boolean, default: false },
    status: {
      type: String,
      enum: FEEDBACK_STATUSES,
      default: "new",
      index: true,
    },
    linkedTicketId: { type: String, default: null },
    capturedAt: { type: Date, required: true, default: () => new Date() },
    reviewedAt: { type: Date },
  },
  { timestamps: false, collection: "feedback_requests" },
);

feedbackSchema.index({ status: 1, capturedAt: -1 });
feedbackSchema.index({ "classification.category": 1, capturedAt: -1 });

export type FeedbackRequestDoc = InferSchemaType<typeof feedbackSchema>;
export const FeedbackRequest = model("FeedbackRequest", feedbackSchema);

export function sanitizeFeedback(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}
