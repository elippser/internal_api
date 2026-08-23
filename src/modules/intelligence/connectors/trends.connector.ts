// Connector Search Trends (spec §7): señal adelantada de intención de viaje.
//
// Google Trends no tiene API pública estable y pytrends murió en 2025
// (repo archivado, 429 permanente). El fetching real corre en un
// microservicio Python separado (internal-laupser/trends-service) basado en
// trendspy, expuesto como POST /fetch-trends. Este connector lo consume por
// HTTP interno como a cualquier provider; si el servicio no está corriendo,
// reporta estado degradado sin romper la ingesta.

import { v4 as uuid } from "uuid";
import { TRENDS_CONFIG } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

// Contrato del microservicio (implementado en trends-service/main.py).
interface TrendsServiceWeek {
  weekStart: string; // YYYY-MM-DD (lunes)
  weekEnd: string; // YYYY-MM-DD
  value: number; // 0-100, escala nativa de Google Trends
}

interface TrendsServiceResult {
  keyword: string;
  geo: string;
  weeks: TrendsServiceWeek[];
  relatedQueries?: string[];
  error?: string;
}

interface TrendsServiceResponse {
  results: TrendsServiceResult[];
}

function serviceUrl(): string | null {
  return process.env.TRENDS_SERVICE_URL ?? null;
}

export function createTrendsConnector(): Connector {
  return {
    name: "trends",

    async healthCheck() {
      const url = serviceUrl();
      if (!url) {
        return {
          ok: false,
          detail:
            "TRENDS_SERVICE_URL no configurada — levantar internal-laupser/trends-service " +
            "(FastAPI + trendspy) y apuntar la env, ej. http://localhost:8700",
        };
      }
      try {
        await fetchJson(`${url}/health`, { retries: 0, timeoutMs: 5000 });
        return { ok: true, detail: `trends-service OK (${url})` };
      } catch (err) {
        return { ok: false, detail: `trends-service inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const url = serviceUrl();
      if (!url) {
        return {
          signals: [],
          meta: { degraded: true, reason: "TRENDS_SERVICE_URL no configurada" },
        };
      }

      const res = await fetchJson<TrendsServiceResponse>(`${url}/fetch-trends`, {
        method: "POST",
        body: { keywords: TRENDS_CONFIG.keywords, weeks: 12 },
        // trendspy scrapea Google con pausas anti rate-limit; darle aire.
        timeoutMs: 180_000,
        retries: 0,
      });

      const signals: Signal[] = [];
      const errors: string[] = [];
      for (const result of res.results ?? []) {
        if (result.error) {
          errors.push(`${result.geo}/${result.keyword}: ${result.error}`);
          continue;
        }
        for (const week of result.weeks ?? []) {
          signals.push({
            id: uuid(),
            type: "search_trend",
            source: "trendspy",
            scope: { geo: { countryCode: result.geo } },
            timeWindow: {
              start: `${week.weekStart}T00:00:00Z`,
              end: `${week.weekEnd}T23:59:59Z`,
            },
            magnitude: Math.min(1, Math.max(0, week.value / 100)),
            confidence: SOURCE_CONFIDENCE.trendspy,
            rawPayload: {
              keyword: result.keyword,
              geo: result.geo,
              value: week.value,
              relatedQueries: result.relatedQueries ?? [],
            },
            ingestedAt: "",
            dedupeKey: `trend:${result.geo}:${result.keyword}:${week.weekStart}`,
          });
        }
      }

      return {
        signals,
        meta: {
          keywords: TRENDS_CONFIG.keywords.length,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
