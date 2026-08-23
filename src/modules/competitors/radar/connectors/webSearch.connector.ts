import { callJson, emptyUsage, radarModel } from "../../ciLlm";
import { CONFIDENCES, type Confidence } from "../../competitors.model";
import type {
  RadarCandidate,
  RadarConnector,
  RadarConnectorContext,
  RadarConnectorResult,
  RadarQuery,
} from "./types";

/**
 * Connector `web_search` (spec §7.3): una llamada a Claude con la server tool
 * web_search por query fija, que devuelve candidatos ya clasificados. Necesita
 * un modelo con server tools (Sonnet); Haiku no las soporta de forma confiable.
 */

const RADAR_SYSTEM =
  "Sos el radar de competencia de bookfer (PMS + motor de reservas para alojamientos chicos, foco LATAM). " +
  "Con la búsqueda web, encontrá PRODUCTOS DE SOFTWARE para hoteles/alojamientos (PMS, motor de reservas, channel manager, suites) " +
  "que parezcan nuevos, recién lanzados o en crecimiento, priorizando resultados de los últimos 90 días. " +
  "Ignorá directorios, notas de prensa genéricas, consultoras, agencias y hoteles. " +
  'Devolvé SOLO JSON: {"candidates":[{"name":string,"url":string (home del producto, no la nota),' +
  '"summary":string (1-2 líneas: qué es, para quién, señal de novedad),"classification":"new_competitor"|"noise",' +
  '"confidence":"high"|"medium"|"low","tractionSignals":string[]}]}. ' +
  "Máximo 8 candidatos. `noise` = salió en la búsqueda pero no es un software competidor (incluilo igual: sirve para no volver a mostrarlo).";

function asStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeCandidates(json: any, sourceLabel: string): RadarCandidate[] {
  const list = Array.isArray(json?.candidates) ? json.candidates : [];
  const out: RadarCandidate[] = [];
  for (const c of list.slice(0, 12)) {
    const url = asStr(c?.url, 2_000);
    const name = asStr(c?.name, 160);
    if (!url || !name) continue;
    const classification = c?.classification === "noise" ? "noise" : "new_competitor";
    const confidence: Confidence =
      typeof c?.confidence === "string" && (CONFIDENCES as readonly string[]).includes(c.confidence)
        ? (c.confidence as Confidence)
        : "medium";
    const tractionSignals = Array.isArray(c?.tractionSignals)
      ? c.tractionSignals.map((s: unknown) => asStr(s, 200)).filter(Boolean).slice(0, 8)
      : [];
    out.push({
      name,
      url,
      summary: asStr(c?.summary, 500),
      classification,
      confidence,
      tractionSignals,
      sourceLabel,
    });
  }
  return out;
}

export const webSearchConnector: RadarConnector = {
  id: "web_search",
  async search(query: RadarQuery, ctx: RadarConnectorContext): Promise<RadarConnectorResult> {
    const skip = Array.from(new Set([...ctx.excludedDomains, ...ctx.ourDomains]));
    const user =
      `Query de búsqueda: ${query.text}\n\n` +
      `No repitas dominios de esta lista (ya conocidos o excluidos): ${skip.join(", ") || "(ninguno)"}\n\n` +
      "Devolvé el JSON.";
    try {
      const r = await callJson({
        model: radarModel(),
        system: RADAR_SYSTEM,
        user,
        webSearch: { maxUses: Math.max(1, ctx.maxSearches) },
        maxTokens: 2_000,
        timeoutMs: 120_000,
      });
      if (!r.json) {
        return { candidates: [], usage: r.usage, error: "parse_failed" };
      }
      return { candidates: sanitizeCandidates(r.json, query.text), usage: r.usage };
    } catch (err) {
      return {
        candidates: [],
        usage: emptyUsage(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
