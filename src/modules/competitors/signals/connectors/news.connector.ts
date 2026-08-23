import { emptyUsage } from "../../ciLlm";
import {
  emptyResult,
  fetchJsonPublic,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
} from "./types";

/**
 * Connector `news` (spec v2 §5): GDELT DOC API (gratis, sin key). Articulos
 * de los ultimos 30 dias que nombran al competidor. Players chicos no suelen
 * aparecer; barato igual.
 */

interface GdeltResp {
  articles?: Array<{ url: string; title: string; seendate: string; domain: string; language: string }>;
}

const GENERIC = new Set(["suite", "cloud", "pms", "hotel", "software", "system", "booking"]);

export const newsConnector: SignalConnector = {
  id: "news",
  label: "Prensa (GDELT DOC)",
  paid: false,
  accepts: { perCompetitor: true },
  // GDELT pide 1 request cada 5 s, tarda 12-17 s en responder y limita por IP.
  minDelayMs: 10_000,
  async healthCheck() {
    return {
      ok: true,
      detail: "api.gdeltproject.org, sin key. Cuota compartida por IP: es lento (~15 s) y suele limitar (429); cuando eso pasa el connector saltea y reintenta la próxima corrida.",
    };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    const usage = emptyUsage();
    const name = ctx.competitor.name.trim();
    if (name.length < 4 || GENERIC.has(name.toLowerCase())) return emptyResult(usage, { skipped: "nombre genérico o muy corto" });
    const q = encodeURIComponent(`"${name}"`);
    const r = await fetchJsonPublic<GdeltResp>(
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&timespan=30d&maxrecords=25&sort=datedesc`,
      { timeoutMs: 30_000 },
    );
    if (!r.ok) {
      // Limitar por cuota o rechazar la conexión es lo normal en el endpoint
      // gratuito: se saltea (no ensucia la corrida) y se reintenta la próxima.
      const throttled = /http_429|UND_ERR_CONNECT_TIMEOUT|timeout|limit requests/i.test(r.error ?? "");
      if (throttled) return emptyResult(usage, { skipped: `GDELT limitó la consulta (${(r.error ?? "").slice(0, 60)}); se reintenta la próxima corrida` });
      return emptyResult(usage, { error: r.error ?? "gdelt_failed" });
    }
    const articles = (r.json?.articles ?? []).filter((a) => a?.url && a?.title);
    const signals: SignalDraft[] = [{ metric: "newsCount", value: articles.length, unit: "count", sourceUrl: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=html&timespan=30d` }];
    const events: SignalEventDraft[] = [];
    const min = ctx.settings.signals.thresholds.newsMin ?? 1;
    if (articles.length >= min) {
      for (const a of articles.slice(0, 5)) {
        const seen = a.seendate ? new Date(a.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) : new Date();
        events.push({
          kind: "press",
          severity: "low",
          title: a.title.slice(0, 160),
          summary: `Artículo en ${a.domain} (${a.language}).`,
          sourceUrl: a.url,
          network: "web",
          dedupeKey: `${ctx.competitor.competitorId}|press|${a.url}`,
          observedAt: Number.isNaN(seen.getTime()) ? new Date() : seen,
        });
      }
    }
    return emptyResult(usage, { signals, events });
  },
};
