import { capabilitiesFor } from "../../engine/llm/catalog";
import { getAnthropic } from "../conversations/services/anthropicClient";
import { computeCostUsd } from "../usage/usage.pricing";
import type { LlmUsageRecord } from "./competitors.model";

/**
 * Llamadas LLM del modulo de competencia: una sola funcion que pide JSON,
 * opcionalmente con la server tool web_search, maneja `pause_turn` y devuelve
 * el consumo ya costeado. El costo NO va a usage_records (ledger por company):
 * se guarda en los documentos del modulo (ci_radar_runs, aiDraft.usage).
 */

export const radarModel = () => process.env.CI_RADAR_MODEL ?? "claude-sonnet-4-6";
export const draftModel = () => process.env.CI_DRAFT_MODEL ?? "claude-haiku-4-5-20251001";
export const evidenceModel = () => process.env.CI_EVIDENCE_MODEL ?? "claude-sonnet-4-6";
const webSearchUsdPer1000 = () => Number(process.env.CI_WEB_SEARCH_USD_PER_1000 ?? 10);

export function aiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Variante de la server tool web_search. Default: la "vieja" (20250305), que
 * para un job batch resulta mas rapida y estable que la 20260209 (filtrado
 * dinamico con ejecucion de codigo por debajo; medida en 25-30 s y con
 * "busqueda temporalmente no disponible" vs. 7 s con resultados). Con
 * CI_WEB_SEARCH_TOOL_TYPE=catalog se usa la variante que declara el catalogo
 * del modelo (engine/llm/catalog.ts).
 */
export function webSearchToolType(model: string): string {
  const v = (process.env.CI_WEB_SEARCH_TOOL_TYPE ?? "").trim();
  if (!v) return "web_search_20250305";
  if (v === "catalog") return capabilitiesFor(model).webSearchToolType;
  return v;
}

export function emptyUsage(): LlmUsageRecord {
  return { inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, latencyMs: 0 };
}

export function addUsage(a: LlmUsageRecord, b: LlmUsageRecord): LlmUsageRecord {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    webSearches: a.webSearches + b.webSearches,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1_000_000) / 1_000_000,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

/**
 * Extrae el primer objeto JSON del texto aunque venga con fences ```json o
 * con prosa alrededor. Devuelve null si no hay nada parseable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonStrict<T = any>(text: string): T | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  // Primer objeto balanceado (ignora llaves dentro de strings).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface CallJsonOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  webSearch?: { maxUses: number } | null;
  timeoutMs?: number;
}

export interface CallJsonResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any | null;
  text: string;
  usage: LlmUsageRecord;
  stopReason: string;
}

interface MessageLike {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
}

export async function callJson(opts: CallJsonOptions): Promise<CallJsonResult> {
  const client = getAnthropic();
  const model = opts.model;
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 1_500,
    system: opts.system,
  };
  if (opts.webSearch) {
    // El SDK 0.27 no tipa las server tools: se manda la bolsa tal cual, igual
    // que en conversationRunner. La variante la decide el catalogo del modelo.
    body.tools = [
      {
        type: webSearchToolType(model),
        name: "web_search",
        max_uses: opts.webSearch.maxUses,
      },
    ];
  }
  // Con busqueda web no se reintenta: un timeout ya es largo y el reintento
  // duplica la corrida (se vio 2 x 120 s). Sin busqueda, un reintento es barato.
  const maxRetries = opts.webSearch ? 0 : 1;

  const messages: Array<Record<string, unknown>> = [{ role: "user", content: opts.user }];
  const usage = emptyUsage();
  const t0 = Date.now();
  let text = "";
  let stopReason = "";

  // pause_turn: el loop server-side de web_search llego a su limite; se
  // reenvia el assistant tal cual y el servidor continua donde quedo.
  for (let i = 0; i < 4; i++) {
    const res = (await client.messages.create(
      { ...body, messages } as never,
      { timeout: opts.timeoutMs ?? 90_000, maxRetries },
    )) as unknown as MessageLike;
    usage.inputTokens += res.usage?.input_tokens ?? 0;
    usage.outputTokens += res.usage?.output_tokens ?? 0;
    usage.webSearches += res.usage?.server_tool_use?.web_search_requests ?? 0;
    stopReason = res.stop_reason ?? "";
    if (stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content ?? [] });
      continue;
    }
    text = (res.content ?? [])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    break;
  }

  usage.latencyMs = Date.now() - t0;
  const tokensCost = computeCostUsd(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  const searchCost = (usage.webSearches * webSearchUsdPer1000()) / 1000;
  usage.costUsd = Math.round((tokensCost + searchCost) * 1_000_000) / 1_000_000;

  // Si la respuesta se cortó por `max_tokens`, el JSON queda abierto: se
  // intenta cerrar para no perder todo lo que sí vino.
  const json = parseJsonStrict(text) ?? (stopReason === "max_tokens" ? repairTruncatedJson(text) : null);
  return { json, text, usage, stopReason };
}

/**
 * Cierra un JSON truncado: descarta la última propiedad incompleta y agrega
 * los `]`/`}` que falten. Devuelve null si no queda nada aprovechable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function repairTruncatedJson<T = any>(text: string): T | null {
  const cleaned = (text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1; // final de la última propiedad completa del nivel raíz
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === "," && stack.length === 1) lastSafe = i;
  }
  const base = lastSafe > 0 ? cleaned.slice(start, lastSafe) : cleaned.slice(start);
  // Recalcular qué falta cerrar sobre el trozo recortado.
  const closers: string[] = [];
  inStr = false;
  esc = false;
  for (const ch of base) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  const candidate = (inStr ? `${base}"` : base) + closers.reverse().join("");
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout (${ms} ms)`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
