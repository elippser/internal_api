import { Schema, model, type InferSchemaType } from "mongoose";

export const KB_LANGUAGES = ["es", "en", "pt", "mixed"] as const;
export const KB_STATUSES = ["building", "ready", "error"] as const;
export const DOC_SOURCE_TYPES = [
  "pdf",
  "markdown",
  "text",
  "url",
  "manual",
] as const;
export const DOC_STATUSES = [
  "pending",
  "processing",
  "indexed",
  "error",
] as const;

const kbSchema = new Schema(
  {
    knowledgeBaseId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    language: { type: String, enum: KB_LANGUAGES, default: "es" },
    status: { type: String, enum: KB_STATUSES, default: "ready" },
    documentCount: { type: Number, default: 0 },
    totalChunks: { type: Number, default: 0 },
    lastIndexedAt: { type: Date },
  },
  { timestamps: true, collection: "knowledge_bases" },
);

const docMetadataSchema = new Schema(
  {
    title: { type: String },
    description: { type: String },
    tags: { type: [String], default: [] },
    language: { type: String },
  },
  { _id: false },
);

const docSchema = new Schema(
  {
    documentId: { type: String, required: true, unique: true, index: true },
    knowledgeBaseId: { type: String, required: true, index: true },
    sourceType: { type: String, enum: DOC_SOURCE_TYPES, required: true },
    originalName: { type: String, required: true },
    storageUrl: { type: String, default: "" },
    status: { type: String, enum: DOC_STATUSES, default: "pending" },
    errorMessage: { type: String },
    rawText: { type: String, default: "" },
    chunkCount: { type: Number, default: 0 },
    metadata: { type: docMetadataSchema, default: () => ({}) },
    indexedAt: { type: Date },
  },
  { timestamps: true, collection: "knowledge_documents" },
);

export type KnowledgeBaseDoc = InferSchemaType<typeof kbSchema>;
export type KnowledgeDocumentDoc = InferSchemaType<typeof docSchema>;

export const KnowledgeBase = model("KnowledgeBase", kbSchema);
export const KnowledgeDocument = model("KnowledgeDocument", docSchema);

export function sanitizeKb(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

export function sanitizeDoc(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}
