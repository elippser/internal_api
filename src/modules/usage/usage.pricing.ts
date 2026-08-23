/**
 * Tabla de precios por modelo (USD por 1M tokens) para convertir consumo de
 * tokens a costo monetario. Es la unica fuente de verdad del costo: cambiala
 * aca cuando Anthropic ajuste tarifas o se agregue un modelo nuevo.
 *
 * El match es por prefijo/familia contra el model id normalizado (lowercase),
 * porque los ids concretos cambian de version (claude-sonnet-4-5,
 * claude-sonnet-4-6, ...) pero la tarifa por familia se mantiene estable.
 *
 * Precios de referencia (publicos Anthropic, USD / 1M tokens):
 *   Opus    : input 15  · output 75  · cache write 18.75 · cache read 1.50
 *   Sonnet  : input  3  · output 15  · cache write  3.75 · cache read 0.30
 *   Haiku   : input 0.8 · output  4  · cache write  1.00 · cache read 0.08
 */

export interface ModelPricing {
  /** USD por 1M tokens de input (prompt sin cache). */
  inputPerMTok: number;
  /** USD por 1M tokens de output (respuesta del modelo). */
  outputPerMTok: number;
  /** USD por 1M tokens escritos a cache (cache_creation). */
  cacheWritePerMTok: number;
  /** USD por 1M tokens leidos de cache (cache_read, mucho mas barato). */
  cacheReadPerMTok: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

const TABLE: Array<{ match: RegExp; pricing: ModelPricing }> = [
  {
    match: /opus/,
    pricing: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheWritePerMTok: 18.75,
      cacheReadPerMTok: 1.5,
    },
  },
  {
    match: /sonnet/,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    },
  },
  {
    match: /haiku/,
    pricing: {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheWritePerMTok: 1,
      cacheReadPerMTok: 0.08,
    },
  },
];

// Si el modelo no matchea ninguna familia conocida, usamos la tarifa de Sonnet
// como conservadora (ni la mas barata ni la mas cara). Ademas logueamos para
// que se note que falta un modelo en la tabla.
const FALLBACK: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

const warnedModels = new Set<string>();

export function getModelPricing(model: string): ModelPricing {
  const id = (model || "").toLowerCase();
  const hit = TABLE.find((row) => row.match.test(id));
  if (hit) return hit.pricing;
  if (!warnedModels.has(id)) {
    warnedModels.add(id);
    console.warn(
      `[usage] modelo sin tarifa en usage.pricing.ts: "${model}" — uso fallback Sonnet`,
    );
  }
  return FALLBACK;
}

/**
 * Costo en USD de un turno. Redondeado a 6 decimales (un turno puede costar
 * fracciones de centavo; no perdemos precision al agregar miles de turnos).
 */
export function computeCostUsd(model: string, usage: TokenUsage): number {
  const p = getModelPricing(model);
  const input = (usage.inputTokens || 0) * p.inputPerMTok;
  const output = (usage.outputTokens || 0) * p.outputPerMTok;
  const cacheWrite = (usage.cacheCreationTokens || 0) * p.cacheWritePerMTok;
  const cacheRead = (usage.cacheReadTokens || 0) * p.cacheReadPerMTok;
  const total = (input + output + cacheWrite + cacheRead) / 1_000_000;
  return Math.round(total * 1_000_000) / 1_000_000;
}
