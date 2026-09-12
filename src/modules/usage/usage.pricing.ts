/**
 * Tabla de precios por modelo (USD por 1M tokens) para convertir consumo de
 * tokens a costo monetario. Es la unica fuente de verdad del costo: cambiala
 * aca cuando un proveedor ajuste tarifas o se agregue un modelo nuevo.
 *
 * El match es por patron contra el model id normalizado (lowercase), porque los
 * ids concretos cambian de version pero la tarifa de la familia se mantiene
 * bastante estable. El id puede venir cualificado (`openrouter/z-ai/...`) o
 * desnudo: los patrones no anclan el principio, asi que matchean igual.
 *
 * Precios vigentes del catalogo de OpenRouter al 2026-09-10 (USD / 1M tokens).
 * Se dejan tambien las familias de Anthropic: hay asientos historicos en el
 * ledger que se siguen recalculando y tienen que costear con SU tarifa, no con
 * la nueva -- si no, el historial de gasto se reescribe solo y las
 * comparaciones antes/despues de la migracion dejan de significar nada.
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
  // ── Tiers vigentes (OpenRouter) ────────────────────────────────────────────
  // Ojo con el orden: `deepseek-v4-flash` tiene que ir ANTES que un patron mas
  // ancho de deepseek, y los tres van antes que las familias de Anthropic para
  // que un id como `openrouter/anthropic/claude-...` no se los coma.
  {
    // cheap
    match: /deepseek-v4-flash/,
    pricing: {
      inputPerMTok: 0.065,
      outputPerMTok: 0.18,
      // OpenRouter no cobra la escritura de cache de DeepSeek aparte.
      cacheWritePerMTok: 0.065,
      cacheReadPerMTok: 0.016,
    },
  },
  {
    // standard
    match: /glm-5\.3-flash/,
    pricing: {
      inputPerMTok: 0.075,
      outputPerMTok: 0.25,
      cacheWritePerMTok: 0.075,
      cacheReadPerMTok: 0.015,
    },
  },
  {
    // premium
    match: /gemini-3\.8-flash/,
    pricing: {
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      cacheWritePerMTok: 0.75,
      cacheReadPerMTok: 0.075,
    },
  },
  // ── Familias historicas de Anthropic (asientos previos a la migracion) ─────
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

// Si el modelo no matchea ninguna familia conocida usamos la tarifa del tier
// premium, que es el techo de lo que la plataforma elige por su cuenta: un
// costo estimado de mas se ve raro y se corrige, mientras que uno de menos se
// naturaliza y nadie lo mira. Ademas logueamos para que se note que falta un
// modelo en la tabla.
//
// Antes el fallback era la tarifa de Sonnet (3 / 15). Dejarlo asi despues de la
// migracion habria multiplicado por cuarenta el costo informado de CADA turno,
// porque ningun id nuevo matchea las familias viejas.
const FALLBACK: ModelPricing = {
  inputPerMTok: 0.75,
  outputPerMTok: 3.75,
  cacheWritePerMTok: 0.75,
  cacheReadPerMTok: 0.075,
};

const warnedModels = new Set<string>();

export function getModelPricing(model: string): ModelPricing {
  const id = (model || "").toLowerCase();
  const hit = TABLE.find((row) => row.match.test(id));
  if (hit) return hit.pricing;
  if (!warnedModels.has(id)) {
    warnedModels.add(id);
    console.warn(
      `[usage] modelo sin tarifa en usage.pricing.ts: "${model}" — uso tarifa del tier premium`,
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
