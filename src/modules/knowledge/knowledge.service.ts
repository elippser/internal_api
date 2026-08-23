import { makeId } from "../../shared/utils/ids";
import { DocumentChunk } from "./chunk.model";
import {
  KnowledgeBase,
  KnowledgeDocument,
  sanitizeDoc,
  sanitizeKb,
} from "./knowledge.model";
import {
  deleteDocumentChunks,
  processDocument,
  refreshKbCounts,
} from "../../shared/rag/documentProcessor";

interface CreateKbInput {
  name: string;
  description?: string;
  language?: string;
}

interface CreateDocInput {
  knowledgeBaseId: string;
  sourceType: "pdf" | "markdown" | "text" | "url" | "manual";
  originalName: string;
  storageUrl?: string;
  rawText?: string;
  fileBuffer?: Buffer;
  metadata?: {
    title?: string;
    description?: string;
    tags?: string[];
    language?: string;
  };
}

function runInBackground(work: () => Promise<unknown>, label: string) {
  // No bloqueamos la respuesta HTTP. Los errores quedan capturados en
  // KnowledgeDocument.status = "error" + errorMessage.
  work().catch((err) => {
    console.error(`[knowledge] background job ${label} failed:`, err);
  });
}

export const knowledgeService = {
  async listKbs() {
    const docs = await KnowledgeBase.find().sort({ updatedAt: -1 });
    return docs.map(sanitizeKb);
  },

  async createKb(input: CreateKbInput) {
    const doc = await KnowledgeBase.create({
      knowledgeBaseId: makeId("kb"),
      name: input.name,
      description: input.description ?? "",
      language: input.language ?? "es",
      status: "ready",
    });
    return sanitizeKb(doc);
  },

  async getKb(knowledgeBaseId: string) {
    const kb = await KnowledgeBase.findOne({ knowledgeBaseId });
    if (!kb) return null;
    const docs = await KnowledgeDocument.find({ knowledgeBaseId }).sort({
      createdAt: -1,
    });
    return {
      ...sanitizeKb(kb),
      documents: docs.map(sanitizeDoc),
    };
  },

  async updateKb(knowledgeBaseId: string, input: Partial<CreateKbInput>) {
    const doc = await KnowledgeBase.findOneAndUpdate(
      { knowledgeBaseId },
      { $set: input },
      { new: true },
    );
    return doc ? sanitizeKb(doc) : null;
  },

  async deleteKb(knowledgeBaseId: string) {
    await DocumentChunk.deleteMany({ knowledgeBaseId });
    await KnowledgeDocument.deleteMany({ knowledgeBaseId });
    const res = await KnowledgeBase.deleteOne({ knowledgeBaseId });
    return res.deletedCount > 0;
  },

  async createDoc(input: CreateDocInput) {
    const documentId = makeId("doc");
    const doc = await KnowledgeDocument.create({
      documentId,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceType: input.sourceType,
      originalName: input.originalName,
      storageUrl: input.storageUrl ?? "",
      rawText: input.rawText ?? "",
      metadata: input.metadata ?? { tags: [] },
      status: "processing",
      chunkCount: 0,
    });
    await KnowledgeBase.updateOne(
      { knowledgeBaseId: input.knowledgeBaseId },
      { $set: { status: "building" } },
    );

    runInBackground(
      () =>
        processDocument({
          documentId,
          knowledgeBaseId: input.knowledgeBaseId,
          sourceType: input.sourceType,
          rawText: input.rawText,
          storageUrl: input.storageUrl,
          fileBuffer: input.fileBuffer,
          title: input.metadata?.title ?? input.originalName,
        }),
      `processDocument(${documentId})`,
    );

    return sanitizeDoc(doc);
  },

  async deleteDoc(knowledgeBaseId: string, documentId: string) {
    await deleteDocumentChunks(documentId);
    const res = await KnowledgeDocument.deleteOne({
      knowledgeBaseId,
      documentId,
    });
    if (res.deletedCount > 0) await refreshKbCounts(knowledgeBaseId);
    return res.deletedCount > 0;
  },

  async reindex(knowledgeBaseId: string) {
    await KnowledgeBase.updateOne(
      { knowledgeBaseId },
      { $set: { status: "building" } },
    );
    const docs = await KnowledgeDocument.find({ knowledgeBaseId });

    runInBackground(async () => {
      for (const doc of docs) {
        await processDocument({
          documentId: doc.documentId,
          knowledgeBaseId,
          sourceType: doc.sourceType as
            | "pdf"
            | "markdown"
            | "text"
            | "url"
            | "manual",
          rawText: doc.rawText,
          storageUrl: doc.storageUrl,
          title: doc.metadata?.title ?? doc.originalName,
        });
      }
      await refreshKbCounts(knowledgeBaseId);
    }, `reindex(${knowledgeBaseId})`);

    return this.getKb(knowledgeBaseId);
  },
};
