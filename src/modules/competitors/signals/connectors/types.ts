import type {
  Confidence,
  LlmUsageRecord,
  ProfileStatus,
  Severity,
  SignalConnectorId,
  SignalEventKind,
  SocialNetwork,
  SocialProfile,
  WatchedPage,
  WatchedPageKind,
} from "../../competitors.model";
import type { CiSettingsRecord } from "../../settings.service";

/**
 * Contrato de connector de senales (spec v2 §5). Como el radar y el
 * intelligence-hub: el connector NO toca la base; devuelve senales, eventos,
 * sugerencias y actualizaciones de perfiles/paginas, y el motor
 * (signals.service) es el unico que persiste.
 */

export interface CompetitorLite {
  competitorId: string;
  name: string;
  aliases: string[];
  website: string;
  websiteDomain: string;
  extraDomains: string[];
  priority: "A" | "B" | "C";
}

export interface SignalDraft {
  profileId?: string | null;
  pageId?: string | null;
  network?: SocialNetwork | null;
  metric: string;
  value: unknown;
  unit?: string;
  approx?: boolean;
  sourceUrl?: string;
  observedAt?: Date;
}

export interface SignalEventDraft {
  kind: SignalEventKind;
  severity: Severity;
  title: string;
  summary: string;
  sourceUrl: string;
  network?: string | null;
  evidence?: unknown;
  featureKeys?: string[];
  /** Si falta, el motor lo arma con competitorId + kind + sourceUrl. */
  dedupeKey?: string;
  observedAt?: Date;
}

export interface SuggestionDraft {
  field: string;
  proposedValue: unknown;
  currentValue?: unknown;
  reason: string;
  evidenceUrl?: string;
  quote?: string;
  confidence?: Confidence;
}

export interface ProfileUpdate {
  profileId: string;
  status?: ProfileStatus;
  latest?: Record<string, unknown>;
  lastOkAt?: Date;
  externalId?: string;
  handle?: string;
  url?: string;
}

export interface PageUpdate {
  pageId: string;
  status?: "active" | "paused" | "unavailable";
  lastHash?: string | null;
  lastCheckedAt?: Date;
  lastChangedAt?: Date;
  feedUrl?: string | null;
}

export interface NewProfileDraft {
  network: SocialNetwork;
  handle: string;
  url: string;
  externalId?: string;
  latest?: Record<string, unknown>;
}

export interface SignalLookup {
  value: unknown;
  observedAt: Date;
  approx: boolean;
}

export interface SignalContext {
  competitor: CompetitorLite;
  profiles: SocialProfile[];
  pages: WatchedPage[];
  /** Ultimo valor persistido de una metrica (para deltas). */
  previous: (metric: string, opts?: { profileId?: string | null; pageId?: string | null; network?: string | null }) => Promise<SignalLookup | null>;
  /** Serie corta (para medias moviles). */
  history: (metric: string, days: number, opts?: { profileId?: string | null; pageId?: string | null }) => Promise<SignalLookup[]>;
  settings: CiSettingsRecord;
  runId: string;
  /** Si false, los connectors pagos (LLM / web_search) deben saltearse. */
  allowPaid: boolean;
  /**
   * Corrida manual sobre competidores puntuales ("revisar ahora"): ignora las
   * cadencias internas (p. ej. la de cada página vigilada) y mide igual.
   */
  forced: boolean;
}

/**
 * Una publicacion del competidor (v2.1). A diferencia de un evento, acá entra
 * TODO lo publicado, sea material o no: es el pulso de qué comunica y cada
 * cuánto. Sólo lo llenan las fuentes con contenido real (YouTube, RSS, Reddit,
 * Product Hunt); las redes sin API aportan conteos, no publicaciones.
 */
export interface ContentDraft {
  network: SocialNetwork;
  profileId?: string | null;
  pageId?: string | null;
  externalId?: string;
  title: string;
  excerpt?: string;
  url: string;
  publishedAt: Date;
  kind?: "post" | "video" | "release" | "case_study" | "campaign" | "other";
  featureKeys?: string[];
  engagement?: Record<string, unknown> | null;
}

export interface SignalConnectorResult {
  signals: SignalDraft[];
  events: SignalEventDraft[];
  content?: ContentDraft[];
  suggestions?: SuggestionDraft[];
  profileUpdates?: ProfileUpdate[];
  pageUpdates?: PageUpdate[];
  newProfiles?: NewProfileDraft[];
  usage: LlmUsageRecord;
  error?: string;
  /** Motivo por el que no hizo nada (sin perfiles, sin key, presupuesto). */
  skipped?: string;
}

export interface SignalConnector {
  id: SignalConnectorId;
  label: string;
  /** Usa LLM o busqueda web (cuesta USD): respeta el presupuesto. */
  paid: boolean;
  accepts: { networks?: SocialNetwork[]; pageKinds?: WatchedPageKind[]; perCompetitor?: boolean };
  /**
   * Pausa minima entre competidores para este connector. Default del motor:
   * 1 s (pagos) / 400 ms (gratis). GDELT pide 1 request cada 5 s y Reddit 10
   * por minuto: sin esto, la segunda consulta vuelve 429.
   */
  minDelayMs?: number;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  run(ctx: SignalContext): Promise<SignalConnectorResult>;
}

export const emptyResult = (usage: LlmUsageRecord, extra: Partial<SignalConnectorResult> = {}): SignalConnectorResult => ({
  signals: [],
  events: [],
  content: [],
  suggestions: [],
  profileUpdates: [],
  pageUpdates: [],
  newProfiles: [],
  usage,
  ...extra,
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON publico con UA identificado y timeout (sin evasion). Lee el
 * cuerpo como texto antes de parsear: varias APIs gratuitas (GDELT) devuelven
 * texto plano cuando limitan, y asi el error dice QUE paso en vez de un
 * "fetch failed" generico. `retries` reintenta con backoff los fallos de red.
 */
export async function fetchJsonPublic<T = unknown>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; retries?: number; retryDelayMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: T | null; error?: string }> {
  const attempts = Math.max(1, (opts.retries ?? 0) + 1);
  let last: { ok: boolean; status: number; json: T | null; error?: string } = { ok: false, status: 0, json: null, error: "not_attempted" };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.retryDelayMs ?? 6_000);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": "bookfer-internal/1.0 (+https://bookfer.com; competitive-intel)", accept: "application/json", ...(opts.headers ?? {}) },
      });
      const body = await res.text();
      if (!res.ok) {
        last = { ok: false, status: res.status, json: null, error: `http_${res.status}: ${body.slice(0, 120).replace(/\s+/g, " ")}` };
        // 4xx que no sea rate limit no mejora reintentando.
        if (res.status !== 429 && res.status < 500) return last;
        continue;
      }
      try {
        return { ok: true, status: res.status, json: JSON.parse(body) as T };
      } catch {
        last = { ok: false, status: res.status, json: null, error: `not_json: ${body.slice(0, 120).replace(/\s+/g, " ")}` };
        continue;
      }
    } catch (err) {
      const e = err as Error & { name?: string; cause?: { code?: string } };
      last = { ok: false, status: 0, json: null, error: e?.name === "AbortError" ? "timeout" : `${e?.message ?? "fetch_failed"}${e?.cause?.code ? ` (${e.cause.code})` : ""}` };
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

export function pctChange(prev: number, curr: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

export function daysBetween(a: Date | string, b: Date | string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}
