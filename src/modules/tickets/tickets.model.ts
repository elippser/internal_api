import { Schema, model, type InferSchemaType } from "mongoose";

export const TICKET_TYPES = [
  "feature",
  "integration",
  "bug",
  "improvement",
] as const;
export const TICKET_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "done",
  "wont_do",
  "duplicate",
] as const;
export const TICKET_EFFORTS = ["xs", "s", "m", "l", "xl"] as const;

export type TicketType = (typeof TICKET_TYPES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketEffort = (typeof TICKET_EFFORTS)[number];

const impactSchema = new Schema(
  {
    requestCount: { type: Number, default: 0 },
    uniqueCompanies: { type: Number, default: 0 },
    uniqueProperties: { type: Number, default: 0 },
  },
  { _id: false },
);

const ticketSchema = new Schema(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    type: { type: String, enum: TICKET_TYPES, required: true, index: true },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: "medium",
      index: true,
    },
    priorityScore: { type: Number, default: 0, index: true },
    impact: { type: impactSchema, default: () => ({}) },
    linkedFeedbackIds: { type: [String], default: [] },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: "open",
      index: true,
    },
    assignedTo: { type: String },
    duplicateOfTicketId: { type: String },
    internalNotes: { type: String, default: "" },
    estimatedEffort: { type: String, enum: TICKET_EFFORTS },
    createdByAgent: { type: Boolean, default: false, index: true },
    cronRunId: { type: String },
    // Embedding del title+description, usado por el cron para detectar
    // tickets similares (dedup). Dimension igual al embedder activo.
    embedding: { type: [Number], default: [] },
    resolvedAt: { type: Date },
  },
  { timestamps: true, collection: "improvement_tickets" },
);

ticketSchema.index({ status: 1, priorityScore: -1 });
ticketSchema.index({ status: 1, createdAt: -1 });

export type ImprovementTicketDoc = InferSchemaType<typeof ticketSchema>;
export const ImprovementTicket = model("ImprovementTicket", ticketSchema);

export function sanitizeTicket(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, embedding, ...rest } = obj;
  return rest;
}
