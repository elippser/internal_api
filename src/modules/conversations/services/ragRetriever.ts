import { DocumentChunk } from "../../knowledge/chunk.model";
import { cosineSimilarity, getEmbedder } from "../../../shared/rag/embedder";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  content: string;
  title: string;
  score: number;
  tokenCount: number;
}

interface RetrieveOptions {
  topK?: number;
  scoreThreshold?: number;
  tokenBudget?: number;
}

export async function retrieve(
  query: string,
  knowledgeBaseIds: string[],
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (!query.trim() || knowledgeBaseIds.length === 0) return [];

  const topK = opts.topK ?? Number(process.env.RAG_TOP_K ?? 5);
  const threshold =
    opts.scoreThreshold ?? Number(process.env.RAG_SCORE_THRESHOLD ?? 0.75);
  const tokenBudget =
    opts.tokenBudget ?? Number(process.env.RAG_TOKEN_BUDGET ?? 2000);

  const embedder = getEmbedder();
  const queryVec = await embedder.embed(query);

  // Cargamos solo los campos necesarios para evitar traer payload extra.
  const chunks = await DocumentChunk.find(
    { knowledgeBaseId: { $in: knowledgeBaseIds } },
    {
      chunkId: 1,
      documentId: 1,
      knowledgeBaseId: 1,
      content: 1,
      embedding: 1,
      tokenCount: 1,
      "metadata.title": 1,
    },
  ).lean();

  if (chunks.length === 0) return [];

  const scored = chunks
    .map((c) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      knowledgeBaseId: c.knowledgeBaseId,
      content: c.content,
      title: c.metadata?.title ?? "",
      tokenCount: c.tokenCount ?? 0,
      score: cosineSimilarity(queryVec, c.embedding ?? []),
    }))
    .filter((c) => c.score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const c of scored) {
    if (used + c.tokenCount > tokenBudget) break;
    used += c.tokenCount;
    out.push(c);
  }
  return out;
}
