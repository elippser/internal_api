// Connector FX (spec §4): tipo de cambio para N pares emisor→receptor.
// Fuente primaria: open.er-api.com (gratis, sin key, actualización diaria).
// Capa adicional para mercados con brecha cambiaria (AR): dolarapi.com.
// magnitude = atractivo cambiario vs promedio móvil 90d del propio par.

import { v4 as uuid } from "uuid";
import { FX_CONFIG, type FxPair } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import { normalizeRateVsHistorical } from "../core/normalize";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type HistoryReader,
  type Signal,
} from "../core/signal.types";

const ER_API_BASE = "https://open.er-api.com/v6/latest";
const DOLARAPI_DOLARES = "https://dolarapi.com/v1/dolares";

interface ErApiResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc?: string;
}

interface DolarApiCasa {
  casa: string;
  nombre: string;
  compra: number | null;
  venta: number | null;
  fechaActualizacion: string;
}

// Bucket de 6h para el dedupeKey: cada corrida dentro de la misma ventana
// actualiza la señal en vez de duplicarla; entre ventanas queda serie
// histórica para el rolling 90d.
function sixHourBucket(date: Date): string {
  const h = Math.floor(date.getUTCHours() / 6) * 6;
  return `${date.toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}`;
}

export function createFxConnector(history: HistoryReader): Connector {
  return {
    name: "fx",

    async healthCheck() {
      try {
        const res = await fetchJson<ErApiResponse>(`${ER_API_BASE}/USD`, { retries: 0 });
        return { ok: res.result === "success", detail: "open.er-api.com OK (sin key)" };
      } catch (err) {
        return { ok: false, detail: `open.er-api.com inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const now = new Date();
      const nowIso = now.toISOString();
      const bucket = sixHourBucket(now);

      // 1) Cotizaciones oficiales: una llamada por moneda base única.
      const bases = Array.from(new Set(FX_CONFIG.pairs.map((p) => p.base)));
      const officialByBase = new Map<string, ErApiResponse>();
      const errors: string[] = [];
      await Promise.allSettled(
        bases.map(async (base) => {
          try {
            officialByBase.set(base, await fetchJson<ErApiResponse>(`${ER_API_BASE}/${base}`));
          } catch (err) {
            errors.push(`official ${base}: ${(err as Error).message}`);
          }
        }),
      );

      // 2) Capa de mercado paralelo (solo si algún par lo requiere).
      let blueUsdArs: DolarApiCasa | null = null;
      const needsParallel = FX_CONFIG.pairs.some((p) =>
        FX_CONFIG.marketsWithParallelRate.includes(p.quoteCountryCode),
      );
      if (needsParallel) {
        try {
          const casas = await fetchJson<DolarApiCasa[]>(DOLARAPI_DOLARES);
          blueUsdArs = casas.find((c) => c.casa === "blue") ?? null;
        } catch (err) {
          errors.push(`dolarapi: ${(err as Error).message}`);
        }
      }

      const signals: Signal[] = [];
      for (const pair of FX_CONFIG.pairs) {
        const official = officialByBase.get(pair.base);
        const officialRate = official?.rates?.[pair.quote];
        if (typeof officialRate !== "number" || !isFinite(officialRate)) continue;

        const parallelRate = computeParallelRate(pair, official!, blueUsdArs);
        // Para el turista, el poder de compra real en mercados con brecha es
        // el paralelo; ese es el rate que alimenta magnitude si existe.
        const effectiveRate = parallelRate ?? officialRate;
        const rollingAvg = await history.rollingAvgFxRate(pair.base, pair.quote, 90);

        signals.push({
          id: uuid(),
          type: "fx_rate",
          source: "exchangerate-api",
          scope: { geo: { countryCode: pair.quoteCountryCode } },
          timeWindow: { start: nowIso, end: nowIso }, // fx es un punto en el tiempo
          magnitude: normalizeRateVsHistorical(effectiveRate, rollingAvg),
          confidence: SOURCE_CONFIDENCE["exchangerate-api"],
          rawPayload: {
            base: pair.base,
            quote: pair.quote,
            rate: effectiveRate,
            officialRate,
            parallelRate,
            parallelSource: parallelRate !== null ? "dolarapi-blue" : null,
            providerUpdatedAt: official?.time_last_update_utc ?? null,
            rolling90dAvg: rollingAvg,
          },
          ingestedAt: "", // lo setea la ingesta
          dedupeKey: `fx:${pair.base}${pair.quote}:${bucket}`,
        });
      }

      return {
        signals,
        meta: {
          pairs: FX_CONFIG.pairs.length,
          produced: signals.length,
          parallelLayer: blueUsdArs ? "dolarapi-blue" : "unavailable",
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}

// Paralelo para pares que cotizan contra un mercado con brecha:
// base→ARS_blue = (base→USD oficial) × (USD→ARS blue venta).
function computeParallelRate(
  pair: FxPair,
  official: ErApiResponse,
  blueUsdArs: DolarApiCasa | null,
): number | null {
  if (!blueUsdArs?.venta) return null;
  if (pair.quote !== "ARS") return null;
  if (pair.base === "USD") return blueUsdArs.venta;
  const baseToUsd = official.rates?.USD;
  if (typeof baseToUsd !== "number" || baseToUsd <= 0) return null;
  return Number((baseToUsd * blueUsdArs.venta).toFixed(4));
}
