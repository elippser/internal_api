/**
 * Tarjeta de tarifas versionada por modelo (§24).
 *
 * Dos diferencias deliberadas con `modules/usage/usage.pricing.ts`, que es la
 * tabla del runtime viejo y sigue viva sin cambios:
 *
 *  1. El match es por ID EXACTO primero, y sólo después por familia. La tabla
 *     vieja matchea únicamente por familia (`/opus/`), lo que era correcto
 *     mientras toda la familia Opus costaba igual. Ya no: Opus 4.6 y Opus 5
 *     son ambos "opus" y tienen tarifas distintas, así que un match por familia
 *     cobraría Opus 5 al triple de lo que sale. Fable 5 directamente no matchea
 *     ninguna familia conocida y caería al fallback.
 *  2. Devuelve la INSTANTÁNEA junto con el costo, para congelarla en el asiento.
 *     Cambiar esta tabla no debe reescribir la historia (§24).
 *
 * La tarificación FALLA ABIERTA (§35.7): si no se puede tarificar, se registra
 * costo cero con la instantánea `unknown` y la corrida sigue. Un problema de
 * tarifas jamás impide ejecutar.
 */
import type { PricingSnapshot } from "../models/usageRecord.model";
import { providerOf, stripProvider } from "./catalog";
import { openRouterModel } from "./providers/openrouterCatalog";

export interface RateCard {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Tarifas de referencia (USD por millón de tokens), API de primera parte.
 * Las de caché se derivan de la convención del proveedor: escritura 1.25× la
 * entrada (TTL de 5 minutos) y lectura 0.1× la entrada.
 */
function card(input: number, output: number): RateCard {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheWritePerMTok: Math.round(input * 1.25 * 1000) / 1000,
    cacheReadPerMTok: Math.round(input * 0.1 * 1000) / 1000,
  };
}

/** Match EXACTO. Es el que manda. */
const EXACT: Record<string, RateCard> = {
  "claude-fable-5": card(10, 50),
  "claude-mythos-5": card(10, 50),
  "claude-opus-5": card(5, 25),
  "claude-opus-4-8": card(5, 25),
  "claude-opus-4-7": card(5, 25),
  "claude-opus-4-6": card(5, 25),
  "claude-opus-4-5": card(5, 25),
  "claude-sonnet-5": card(3, 15),
  "claude-sonnet-4-6": card(3, 15),
  "claude-sonnet-4-5": card(3, 15),
  "claude-haiku-4-5": card(1, 5),
  "claude-haiku-4-5-20251001": card(1, 5),
};

/**
 * Reserva por familia, SÓLO para ids con sufijo o variantes que no listamos.
 * Conservadora hacia arriba: si un modelo `opus` nuevo aparece y no está en la
 * tabla, prefiero sobreestimar el costo (y que alguien lo note en el tablero) a
 * subestimarlo y descubrirlo en la factura.
 */
const FAMILY: Array<{ match: RegExp; card: RateCard; label: string }> = [
  { match: /fable|mythos/, card: card(10, 50), label: "family:fable" },
  { match: /opus/, card: card(15, 75), label: "family:opus-legacy" },
  { match: /sonnet/, card: card(3, 15), label: "family:sonnet" },
  { match: /haiku/, card: card(1, 5), label: "family:haiku" },
];

const UNKNOWN_CARD: RateCard = card(3, 15);

const warned = new Set<string>();

export function rateCardFor(model: string): { card: RateCard; source: string } {
  // Ramal del gateway agregador: la tarifa la publica ÉL, por modelo. Usar la
  // tabla local para un modelo de Mistral o Llama sería inventar un número —
  // y un número inventado en el ledger de costos es peor que ninguno.
  if (providerOf(model) === "openrouter") {
    const gateway = openRouterModel(stripProvider(model));
    if (gateway) {
      return {
        card: {
          inputPerMTok: gateway.promptPerMTok,
          outputPerMTok: gateway.completionPerMTok,
          // El gateway no publica tarifas de caché diferenciadas: se igualan a
          // la de entrada en vez de aplicar los multiplicadores de Anthropic,
          // que no valen para los otros proveedores.
          cacheWritePerMTok: gateway.promptPerMTok,
          cacheReadPerMTok: gateway.promptPerMTok,
        },
        source: `openrouter:${gateway.id}`,
      };
    }
    // Catálogo frío: cero explícito. Prefiero un costo visiblemente ausente a
    // uno plausible y falso — el primero se nota en el tablero, el segundo no.
    return {
      card: { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
      source: "openrouter:catalog-frio",
    };
  }

  const bare = stripProvider(model || "").toLowerCase();

  const exact = EXACT[bare];
  if (exact) return { card: exact, source: `exact:${bare}` };

  const family = FAMILY.find((row) => row.match.test(bare));
  if (family) {
    if (!warned.has(bare)) {
      warned.add(bare);
      console.warn(
        `[engine:pricing] "${bare}" sin tarifa exacta — uso ${family.label}. ` +
          `Agregalo a EXACT en engine/llm/pricing.ts: la tarifa por familia puede estar lejos de la real.`,
      );
    }
    return { card: family.card, source: family.label };
  }

  if (!warned.has(bare)) {
    warned.add(bare);
    console.warn(`[engine:pricing] modelo desconocido "${bare}" — tarifa de reserva.`);
  }
  return { card: UNKNOWN_CARD, source: "unknown" };
}

export interface TokenCounts {
  tokensInput: number;
  tokensOutput: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface CostBreakdown {
  costInputUsd: number;
  costOutputUsd: number;
  costCacheReadUsd: number;
  costCacheWriteUsd: number;
  costTotalUsd: number;
  pricingSnapshot: PricingSnapshot;
}

/** Redondeo a 6 decimales: un turno cuesta fracciones de centavo y sumamos miles. */
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Desglose columnar del costo de UNA llamada. Falla abierta: cualquier
 * excepción produce un desglose en cero con instantánea `error`, nunca un throw
 * que aborte la corrida.
 */
export function computeCost(model: string, usage: TokenCounts): CostBreakdown {
  try {
    const { card: c, source } = rateCardFor(model);

    // Los tokens de razonamiento ya vienen contados dentro de los de salida en
    // la facturación del proveedor: cobrarlos aparte sería contar doble.
    const costInputUsd = round6((usage.tokensInput || 0) * c.inputPerMTok / 1_000_000);
    const costOutputUsd = round6((usage.tokensOutput || 0) * c.outputPerMTok / 1_000_000);
    const costCacheReadUsd = round6(
      (usage.cacheReadTokens || 0) * c.cacheReadPerMTok / 1_000_000,
    );
    const costCacheWriteUsd = round6(
      (usage.cacheCreationTokens || 0) * c.cacheWritePerMTok / 1_000_000,
    );

    return {
      costInputUsd,
      costOutputUsd,
      costCacheReadUsd,
      costCacheWriteUsd,
      costTotalUsd: round6(
        costInputUsd + costOutputUsd + costCacheReadUsd + costCacheWriteUsd,
      ),
      pricingSnapshot: { ...c, source },
    };
  } catch (err) {
    console.error("[engine:pricing] fallo al tarificar; sigo con costo cero:", err);
    return {
      costInputUsd: 0,
      costOutputUsd: 0,
      costCacheReadUsd: 0,
      costCacheWriteUsd: 0,
      costTotalUsd: 0,
      pricingSnapshot: { ...UNKNOWN_CARD, source: "error" },
    };
  }
}
