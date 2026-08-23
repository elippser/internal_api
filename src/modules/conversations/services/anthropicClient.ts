import Anthropic from "@anthropic-ai/sdk";

// Cliente Anthropic compartido por el runtime de conversaciones (runner +
// taskRouter). Cacheado: una sola instancia por proceso.
let cachedClient: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY no esta configurada");
  cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}
