import { encode } from "gpt-tokenizer";

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fallback aproximado: ~4 chars por token
    return Math.ceil(text.length / 4);
  }
}
