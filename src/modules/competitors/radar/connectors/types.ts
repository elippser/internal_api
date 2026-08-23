import type { Confidence, LlmUsageRecord, RadarSource } from "../../competitors.model";

/**
 * Contrato de connector del radar (spec §7.2). Mismo espiritu que el
 * intelligence-hub: el connector NO toca la base; devuelve candidatos y el
 * orquestador (radar.service) es el unico que persiste.
 */

export interface RadarQuery {
  queryId: string;
  text: string;
}

export interface RadarCandidate {
  name: string;
  /** Home del producto (no la nota de prensa). */
  url: string;
  /** 1-2 lineas: que es, para quien, senal de novedad. */
  summary: string;
  classification: "new_competitor" | "noise";
  confidence: Confidence;
  tractionSignals: string[];
  /** Texto de la query (o nombre del feed) que lo encontro. */
  sourceLabel: string;
}

export interface RadarConnectorContext {
  excludedDomains: string[];
  ourDomains: string[];
  maxSearches: number;
}

export interface RadarConnectorResult {
  candidates: RadarCandidate[];
  usage: LlmUsageRecord;
  error?: string;
}

export interface RadarConnector {
  id: RadarSource;
  search(query: RadarQuery, ctx: RadarConnectorContext): Promise<RadarConnectorResult>;
}
