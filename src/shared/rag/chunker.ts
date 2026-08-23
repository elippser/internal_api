import { countTokens } from "./tokens";

export interface RawChunk {
  content: string;
  tokenCount: number;
  chunkType: "markdown_section" | "paragraph_group";
}

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

export function chunk(text: string, sourceType: string): RawChunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const isMarkdown = sourceType === "markdown" || /^#{1,6}\s/m.test(cleaned);
  return isMarkdown ? chunkByHeaders(cleaned) : chunkByParagraphs(cleaned);
}

function chunkByHeaders(text: string): RawChunk[] {
  // Split en bloques que empiezan con ## o ###
  const parts = text.split(/(?=^#{1,3}\s)/m).filter((p) => p.trim());
  const out: RawChunk[] = [];
  for (const part of parts) {
    const tokens = countTokens(part);
    if (tokens <= TARGET_TOKENS) {
      out.push({
        content: part.trim(),
        tokenCount: tokens,
        chunkType: "markdown_section",
      });
    } else {
      // Sub-dividir bloques grandes por parrafos
      for (const sub of chunkByParagraphs(part)) {
        out.push({ ...sub, chunkType: "markdown_section" });
      }
    }
  }
  return out;
}

function chunkByParagraphs(text: string): RawChunk[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const out: RawChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n\n");
    out.push({
      content,
      tokenCount: bufferTokens,
      chunkType: "paragraph_group",
    });
  };

  for (const p of paragraphs) {
    const pTokens = countTokens(p);
    if (pTokens > TARGET_TOKENS) {
      // Parrafo muy largo - split duro por oraciones
      flush();
      buffer = [];
      bufferTokens = 0;
      out.push(...splitLongParagraph(p));
      continue;
    }
    if (bufferTokens + pTokens > TARGET_TOKENS && buffer.length > 0) {
      flush();
      // Overlap: arrancar el siguiente bucket con cola del anterior
      const tail = tailWithinTokens(buffer, OVERLAP_TOKENS);
      buffer = tail.parts;
      bufferTokens = tail.tokens;
    }
    buffer.push(p);
    bufferTokens += pTokens;
  }
  flush();
  return out;
}

function splitLongParagraph(text: string): RawChunk[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: RawChunk[] = [];
  let buf: string[] = [];
  let toks = 0;
  for (const s of sentences) {
    const sToks = countTokens(s);
    if (toks + sToks > TARGET_TOKENS && buf.length) {
      out.push({
        content: buf.join(" "),
        tokenCount: toks,
        chunkType: "paragraph_group",
      });
      buf = [];
      toks = 0;
    }
    buf.push(s);
    toks += sToks;
  }
  if (buf.length) {
    out.push({
      content: buf.join(" "),
      tokenCount: toks,
      chunkType: "paragraph_group",
    });
  }
  return out;
}

function tailWithinTokens(parts: string[], budget: number) {
  const result: string[] = [];
  let total = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = countTokens(parts[i]);
    if (total + t > budget) break;
    result.unshift(parts[i]);
    total += t;
  }
  return { parts: result, tokens: total };
}
