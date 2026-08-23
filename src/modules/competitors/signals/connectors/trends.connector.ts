import { emptyUsage } from "../../ciLlm";
import {
  emptyResult,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
} from "./types";

/**
 * Connector `trends` (spec v2 §5): interes de busqueda por marca via el
 * microservicio trends-service del intelligence-hub (POST /fetch-trends).
 * Escala relativa POR keyword (no comparable entre competidores sin el
 * endpoint de comparacion, §5.9).
 */

const serviceUrl = () => process.env.TRENDS_SERVICE_URL?.trim() || null;

interface TrendsResp {
  results: Array<{ keyword: string; geo: string; weeks: Array<{ weekStart: string; weekEnd: string; value: number }>; error?: string }>;
}

export const trendsConnector: SignalConnector = {
  id: "trends",
  label: "Google Trends (interés de búsqueda por marca)",
  paid: false,
  accepts: { perCompetitor: true },
  async healthCheck() {
    const url = serviceUrl();
    if (!url) return { ok: false, detail: "falta TRENDS_SERVICE_URL — levantar internal-laupser/trends-service (FastAPI + trendspy), ej. http://localhost:8700" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(`${url}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok ? { ok: true, detail: `trends-service OK (${url})` } : { ok: false, detail: `trends-service respondió ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `trends-service no responde: ${(err as Error)?.message}` };
    }
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    const usage = emptyUsage();
    const url = serviceUrl();
    if (!url) return emptyResult(usage, { skipped: "sin TRENDS_SERVICE_URL" });
    const keyword = ctx.competitor.name.trim();
    if (keyword.length < 3) return emptyResult(usage, { skipped: "nombre muy corto" });
    const geos = (ctx.settings.signals.trendsGeos ?? []).slice(0, 7);
    if (!geos.length) return emptyResult(usage, { skipped: "sin geos configuradas" });
    let json: TrendsResp | null = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120_000);
      const res = await fetch(`${url}/fetch-trends`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keywords: geos.map((geo) => ({ keyword, geo })), weeks: 16 }),
      });
      clearTimeout(t);
      if (!res.ok) return emptyResult(usage, { error: `trends-service ${res.status}` });
      json = (await res.json()) as TrendsResp;
    } catch (err) {
      return emptyResult(usage, { error: err instanceof Error ? err.message : String(err) });
    }
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const spikeX = ctx.settings.signals.thresholds.activitySpikeX;
    for (const r of json?.results ?? []) {
      if (r.error || !r.weeks?.length) continue;
      const weeks = [...r.weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      const last4 = weeks.slice(-4);
      const prev12 = weeks.slice(0, -4);
      const avg = (xs: Array<{ value: number }>) => (xs.length ? xs.reduce((a, w) => a + w.value, 0) / xs.length : 0);
      const recent = Math.round(avg(last4) * 10) / 10;
      const base = Math.round(avg(prev12) * 10) / 10;
      signals.push({ metric: "searchInterest", value: recent, unit: `index_0_100:${r.geo}`, sourceUrl: `https://trends.google.com/trends/explore?geo=${r.geo}&q=${encodeURIComponent(keyword)}`, network: null });
      if (base >= 5 && recent >= base * spikeX) {
        events.push({
          kind: "activity_spike",
          severity: "low",
          title: `Interés de búsqueda en ${r.geo}: ${base} → ${recent}`,
          summary: `La media de las últimas 4 semanas (${recent}) supera ×${spikeX} la de las 12 anteriores (${base}) en Google Trends (${r.geo}).`,
          sourceUrl: `https://trends.google.com/trends/explore?geo=${r.geo}&q=${encodeURIComponent(keyword)}`,
          network: null,
          evidence: { geo: r.geo, recent, base },
          dedupeKey: `${ctx.competitor.competitorId}|activity_spike|trends|${r.geo}|${last4[last4.length - 1]?.weekStart ?? ""}`,
        });
      }
    }
    return emptyResult(usage, { signals, events });
  },
};
