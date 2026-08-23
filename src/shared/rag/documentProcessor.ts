import { v4 as uuidv4 } from "uuid";
import {
  KnowledgeBase,
  KnowledgeDocument,
} from "../../modules/knowledge/knowledge.model";
import { DocumentChunk } from "../../modules/knowledge/chunk.model";
import { chunk as splitIntoChunks } from "./chunker";
import { getEmbedder } from "./embedder";
import { stripHtml } from "../web/fetchPage";

interface ProcessInput {
  documentId: string;
  knowledgeBaseId: string;
  sourceType: "pdf" | "markdown" | "text" | "url" | "manual";
  rawText?: string;
  storageUrl?: string;
  fileBuffer?: Buffer;
  title?: string;
}

async function extractText(input: ProcessInput): Promise<string> {
  if (input.rawText) return input.rawText;

  if (input.sourceType === "url" && input.storageUrl) {
    const res = await fetch(input.storageUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`URL fetch ${input.storageUrl} -> ${res.status}`);
    }
    const html = await res.text();
    return stripHtml(html);
  }

  if (input.sourceType === "pdf" && input.fileBuffer) {
    // Import dinamico: pdf-parse intenta leer un fixture si se importa
    // top-level
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(input.fileBuffer);
    return parsed.text;
  }

  if (input.fileBuffer) {
    return input.fileBuffer.toString("utf8");
  }

  return "";
}

export async function processDocument(input: ProcessInput): Promise<{
  chunkCount: number;
}> {
  await KnowledgeDocument.updateOne(
    { documentId: input.documentId },
    { $set: { status: "processing", errorMessage: undefined } },
  );

  try {
    const text = await extractText(input);
    if (!text.trim()) {
      await markDocError(input.documentId, "Texto vacio tras extraccion");
      return { chunkCount: 0 };
    }

    const rawChunks = splitIntoChunks(text, input.sourceType);
    if (rawChunks.length === 0) {
      await markDocError(input.documentId, "No se generaron chunks");
      return { chunkCount: 0 };
    }

    const embedder = getEmbedder();
    const embeddings = await embedder.embedBatch(rawChunks.map((c) => c.content));

    // Borrar chunks viejos si era un reindex
    await DocumentChunk.deleteMany({ documentId: input.documentId });

    const chunkDocs = rawChunks.map((c, i) => ({
      chunkId: `chunk-${uuidv4()}`,
      knowledgeBaseId: input.knowledgeBaseId,
      documentId: input.documentId,
      content: c.content,
      embedding: embeddings[i],
      tokenCount: c.tokenCount,
      chunkIndex: i,
      metadata: {
        title: input.title ?? "",
        sourceType: input.sourceType,
        chunkType: c.chunkType,
      },
    }));
    await DocumentChunk.insertMany(chunkDocs);

    await KnowledgeDocument.updateOne(
      { documentId: input.documentId },
      {
        $set: {
          status: "indexed",
          chunkCount: chunkDocs.length,
          rawText: text.slice(0, 50_000),
          indexedAt: new Date(),
          errorMessage: undefined,
        },
      },
    );

    await refreshKbCounts(input.knowledgeBaseId);
    return { chunkCount: chunkDocs.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    await markDocError(input.documentId, msg);
    return { chunkCount: 0 };
  }
}

async function markDocError(documentId: string, message: string) {
  await KnowledgeDocument.updateOne(
    { documentId },
    { $set: { status: "error", errorMessage: message, chunkCount: 0 } },
  );
}

export async function deleteDocumentChunks(documentId: string) {
  await DocumentChunk.deleteMany({ documentId });
}

export async function refreshKbCounts(knowledgeBaseId: string) {
  const [docCount, chunkCount] = await Promise.all([
    KnowledgeDocument.countDocuments({ knowledgeBaseId, status: "indexed" }),
    DocumentChunk.countDocuments({ knowledgeBaseId }),
  ]);
  await KnowledgeBase.updateOne(
    { knowledgeBaseId },
    {
      $set: {
        documentCount: docCount,
        totalChunks: chunkCount,
        status: chunkCount > 0 ? "ready" : "ready",
        lastIndexedAt: new Date(),
      },
    },
  );
}
