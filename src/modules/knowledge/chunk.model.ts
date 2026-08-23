import { Schema, model, type InferSchemaType } from "mongoose";

const chunkMetaSchema = new Schema(
  {
    title: { type: String },
    sourceType: { type: String },
    chunkType: { type: String },
  },
  { _id: false },
);

const chunkSchema = new Schema(
  {
    chunkId: { type: String, required: true, unique: true, index: true },
    knowledgeBaseId: { type: String, required: true, index: true },
    documentId: { type: String, required: true, index: true },
    content: { type: String, required: true },
    // embedding como array de floats. Atlas vector search no esta disponible
    // en este cluster; el matching se hace por cosine similarity en Node.
    embedding: { type: [Number], default: [] },
    tokenCount: { type: Number, default: 0 },
    chunkIndex: { type: Number, default: 0 },
    metadata: { type: chunkMetaSchema, default: () => ({}) },
  },
  { timestamps: true, collection: "knowledge_chunks" },
);

export type DocumentChunkDoc = InferSchemaType<typeof chunkSchema>;
export const DocumentChunk = model("DocumentChunk", chunkSchema);
