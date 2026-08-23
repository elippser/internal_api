import cron from "node-cron";
import { makeId } from "../../../shared/utils/ids";
import { MktConversation } from "../../campaigns/campaigns.model";
import { MktAccount } from "../../crm/crm.model";
import { addUsage, aiAvailable, callJson, emptyUsage } from "../ciLlm";
import { CiSettings, CiSuggestion, Competitor, MENTION_CONTEXTS, RadarItem, RadarRun, sanitizeDoc, type LlmUsageRecord } from "../competitors.model";
import { CiError } from "../competitors.service";
import { signalsModel } from "../signals/contentClassifier";
import { createSuggestion } from "../signals/suggestions.service";
import { getSettings } from "../settings.service";

/**
 * Deteccion automatica de menciones (spec v2 §9): busca aliases de los
 * competidores en los mensajes ENTRANTES de WhatsApp (mkt_conversations) y en
 * las notas del CRM (mkt_accounts) nuevos desde el ultimo scan; Haiku confirma
 * y clasifica el contexto; se propone como sugerencia `mentions` + item del
 * radar kind `mention`. Nunca escribe la mencion sola.
 */

const GENERIC = new Set(["suite", "cloud", "pms", "hotel", "hoteles", "app", "software", "system", "sistema", "booking", "reservas", "motor"]);
const TZ = "America/Argentina/Buenos_Aires";

const SYSTEM =
  "Sos un analista de ventas de bookfer (software hotelero). Te paso un fragmento de una conversación o nota del CRM " +
  "donde aparece el nombre de un posible competidor. Decidí si el prospecto/cliente está realmente nombrando a ese " +
  'competidor como software que usa, usó, evalúa o compara. Devolvé SOLO JSON: {"isMention":boolean,' +
  '"context":"demo"|"call"|"whatsapp"|"email"|"event"|"web_form"|"other","summary":string (qué dijo, 1 línea, español),' +
  '"competitorConfidence":"high"|"medium"|"low"}';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AliasEntry {
  competitorId: string;
  name: string;
  alias: string;
  re: RegExp;
}

async function aliasIndex(ourAliases: string[]): Promise<AliasEntry[]> {
  const comps = await Competitor.find({ stage: "tracked", status: "active" }).select("competitorId name aliases websiteDomain extraDomains").lean();
  const out: AliasEntry[] = [];
  const ours = new Set(ourAliases.map((a) => a.toLowerCase()));
  for (const c of comps) {
    const candidates = new Set<string>([c.name, ...(c.aliases ?? []), c.websiteDomain, ...(c.extraDomains ?? [])].filter(Boolean).map(String));
    for (const a of candidates) {
      const s = a.trim();
      if (s.length < 4 || GENERIC.has(s.toLowerCase()) || ours.has(s.toLowerCase())) continue;
      out.push({ competitorId: String(c.competitorId), name: c.name, alias: s, re: new RegExp(`(^|[^a-z0-9])${escapeRe(s.toLowerCase())}([^a-z0-9]|$)`, "i") });
    }
  }
  return out;
}

interface Candidate {
  competitorId: string;
  competitorName: string;
  alias: string;
  text: string;
  kind: "mkt_conversation" | "mkt_account_note";
  refId: string;
  accountId: string | null;
  conversationId: string | null;
  at: Date;
}

export async function scanMentions(opts: { trigger: "cron" | "manual"; userId?: string | null }) {
  const settings = await getSettings();
  if (!aiAvailable()) throw new CiError(503, "IA no disponible: falta ANTHROPIC_API_KEY", "ai_unavailable");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const md: any = settings.mentionDetection ?? {};
  if (opts.trigger === "cron" && md.enabled === false) return { skipped: "mentionDetection.enabled=false" };
  const lookbackDays = Number(md.lookbackDays ?? 7);
  const minConf = (md.minConfidence ?? "medium") as "high" | "medium" | "low";
  const lastScanAt: Date = md.lastScanAt ? new Date(md.lastScanAt) : new Date(Date.now() - lookbackDays * 86_400_000);
  const since = new Date(Math.max(lastScanAt.getTime(), Date.now() - 90 * 86_400_000));
  const now = new Date();

  const run = await RadarRun.create({ runId: makeId("menrun"), mode: "mentions", trigger: opts.trigger, triggeredByUserId: opts.userId ?? null, startedAt: now, status: "running", totals: {}, errors: [] });
  const index = await aliasIndex(settings.ourAliases ?? []);
  let usage: LlmUsageRecord = emptyUsage();
  const candidates: Candidate[] = [];

  if (index.length) {
    // WhatsApp: mensajes inbound nuevos
    const convs = await MktConversation.find({ lastMessageAt: { $gte: since } }).select("conversationId accountId messages").lean();
    for (const c of convs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const m of (c.messages as any[]) ?? []) {
        if (m.direction !== "inbound" || !m.content || new Date(m.at).getTime() < since.getTime()) continue;
        const text = String(m.content);
        const low = text.toLowerCase();
        for (const e of index) {
          if (!e.re.test(low)) continue;
          candidates.push({ competitorId: e.competitorId, competitorName: e.name, alias: e.alias, text, kind: "mkt_conversation", refId: `${c.conversationId}:${new Date(m.at).toISOString()}`, accountId: c.accountId ?? null, conversationId: c.conversationId, at: new Date(m.at) });
          break;
        }
      }
    }
    // Notas del CRM modificadas
    const accounts = await MktAccount.find({ updatedAt: { $gte: since }, notes: { $exists: true, $ne: "" } }).select("accountId name notes updatedAt").lean();
    for (const a of accounts) {
      const text = String(a.notes ?? "");
      const low = text.toLowerCase();
      for (const e of index) {
        if (!e.re.test(low)) continue;
        candidates.push({ competitorId: e.competitorId, competitorName: e.name, alias: e.alias, text, kind: "mkt_account_note", refId: `${a.accountId}:${new Date(a.updatedAt as Date).toISOString()}`, accountId: a.accountId, conversationId: null, at: new Date(a.updatedAt as Date) });
        break;
      }
    }
  }

  let suggested = 0;
  let rejected = 0;
  const errors: string[] = [];
  const confRank = { high: 3, medium: 2, low: 1 };
  for (const cand of candidates.slice(0, 60)) {
    // dedupe por referencia
    const exists = await CiSuggestion.findOne({ competitorId: cand.competitorId, field: "mentions", "proposedValue.sourceRef.id": cand.refId }).select("suggestionId").lean();
    if (exists) continue;
    const idx = cand.text.toLowerCase().indexOf(cand.alias.toLowerCase());
    const excerpt = cand.text.slice(Math.max(0, idx - 400), idx + 600);
    try {
      const r = await callJson({
        model: signalsModel(),
        system: SYSTEM,
        user: `Competidor candidato: ${cand.competitorName} (alias detectado: "${cand.alias}")\nFuente: ${cand.kind === "mkt_conversation" ? "WhatsApp entrante" : "nota del CRM"}\n\n=== FRAGMENTO ===\n${excerpt}\n\nDevolvé el JSON.`,
        maxTokens: 300,
        timeoutMs: 45_000,
      });
      usage = addUsage(usage, r.usage);
      const j = r.json;
      const conf = (j?.competitorConfidence ?? "low") as "high" | "medium" | "low";
      if (!j?.isMention || confRank[conf] < confRank[minConf]) {
        rejected++;
        continue;
      }
      const context = (MENTION_CONTEXTS as readonly string[]).includes(j.context) ? j.context : cand.kind === "mkt_conversation" ? "whatsapp" : "other";
      const sug = await createSuggestion({
        competitorId: cand.competitorId,
        field: "mentions",
        proposedValue: { note: String(j.summary ?? "").slice(0, 500), context, at: cand.at, accountId: cand.accountId, conversationId: cand.conversationId, sourceRef: { kind: cand.kind, id: cand.refId, excerpt: excerpt.slice(0, 500) } },
        reason: `Detectado en ${cand.kind === "mkt_conversation" ? "el inbox de WhatsApp" : "una nota del CRM"}: "${String(j.summary ?? "").slice(0, 120)}"`,
        quote: excerpt.slice(0, 300),
        source: "mention_detector",
        confidence: conf,
      });
      await RadarItem.create({
        radarId: makeId("radar"),
        kind: "mention",
        competitorId: cand.competitorId,
        suggestionId: sug.suggestionId,
        detectedName: cand.competitorName,
        source: "mention_detector",
        sourceLabel: cand.kind,
        aiSummary: String(j.summary ?? "").slice(0, 500),
        aiConfidence: conf,
        changeArea: context,
        status: "pending",
        firstSeenAt: now,
        lastSeenAt: now,
        runId: run.runId,
      });
      suggested++;
    } catch (err) {
      errors.push(`${cand.competitorName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await CiSettings.updateOne({ key: "default" }, { $set: { "mentionDetection.lastScanAt": now } });
  run.set("totals", { candidates: candidates.length, suggested, rejected, costUsd: usage.costUsd });
  run.set("errors", errors);
  run.finishedAt = new Date();
  run.status = errors.length ? "partial" : "ok";
  await run.save();
  return { candidates: candidates.length, suggested, rejected, costUsd: usage.costUsd, run: sanitizeDoc(run) };
}

let started = false;
export function startMentionDetectorCron() {
  if (started) return;
  started = true;
  if (process.env.CI_MENTION_DETECTOR_DISABLED === "1") {
    console.log("[competitors] detector de menciones deshabilitado (CI_MENTION_DETECTOR_DISABLED=1)");
    return;
  }
  cron.schedule(
    "30 3 * * *",
    () => {
      scanMentions({ trigger: "cron" }).catch((err) => console.error("[competitors] detector de menciones (cron) falló:", err?.message ?? err));
    },
    { timezone: TZ },
  );
  console.log("[competitors] detector de menciones programado (03:30 ART)");
}
