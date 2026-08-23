import { createHash } from "node:crypto";

// Dimensiones fijas para mantener compatibilidad cuando se hace el cambio
// OpenAI -> fallback. Si OpenAI esta configurado se trunca a esta dim
// (text-embedding-3-small soporta truncation via param `dimensions`).
const EMBEDDING_DIM = 384;

interface Embedder {
  mode: "openai" | "hash";
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

function createHashEmbedder(): Embedder {
  // Random projection determinista basada en hash SHA-256 de n-gramas.
  // No es semantico pero es estable: el mismo texto siempre da el mismo
  // vector. Sirve para validar el pipeline end-to-end sin OpenAI.
  const embed = (text: string): number[] => {
    const normalized = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    const vec = new Array(EMBEDDING_DIM).fill(0);
    if (normalized.length === 0) return vec;

    // Bag-of-ngrams (1 y 2) con peso TF dividido por log(1+freq)
    const tokens: string[] = [];
    for (const w of normalized) tokens.push(w);
    for (let i = 0; i < normalized.length - 1; i++) {
      tokens.push(`${normalized[i]} ${normalized[i + 1]}`);
    }

    for (const t of tokens) {
      const hash = createHash("sha256").update(t).digest();
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        const byte = hash[i % hash.length];
        // Mapear 0-255 a [-1, 1]
        vec[i] += (byte - 128) / 128;
      }
    }

    // Normalizar L2 para que el cosine similarity sea estable
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
    return vec;
  };

  return {
    mode: "hash",
    async embed(text) {
      return embed(text);
    },
    async embedBatch(texts) {
      return texts.map(embed);
    },
  };
}

function createOpenAIEmbedder(apiKey: string, model: string): Embedder {
  const url = "https://api.openai.com/v1/embeddings";

  const call = async (input: string[]) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
        dimensions: EMBEDDING_DIM,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI embeddings failed: ${res.status} ${errText}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  };

  return {
    mode: "openai",
    async embed(text) {
      const [v] = await call([text]);
      return v;
    },
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      // Lote de hasta 96 (limite practico)
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 96) {
        out.push(...(await call(texts.slice(i, i + 96))));
      }
      return out;
    },
  };
}

let cached: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cached) return cached;
  const key = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  if (key) {
    cached = createOpenAIEmbedder(key, model);
  } else {
    cached = createHashEmbedder();
  }
  return cached;
}

export function getEmbeddingDim(): number {
  return EMBEDDING_DIM;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
