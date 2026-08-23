import { createHash } from "crypto";
import { makeId } from "../../../shared/utils/ids";
import { aiAvailable } from "../ciLlm";
import {
  CiContent,
  CiSignal,
  CiSignalEvent,
  CiSuggestion,
  Competitor,
  RadarItem,
  RadarRun,
  sanitizeDoc,
  type Cadence,
  type LlmUsageRecord,
  type SignalConnectorId,
} from "../competitors.model";
import { CiError, competitorsService } from "../competitors.service";
import { makeMeta, setMeta } from "../fieldMeta";
import { ensureV2 } from "../migration";
import { recomputeDerived } from "../quality.service";
import { getSettings, type CiSettingsRecord } from "../settings.service";
import { getSignalConnector, SIGNAL_CONNECTOR_REGISTRY } from "./connectors/registry";
import {
  sleep,
  type CompetitorLite,
  type NewProfileDraft,
  type PageUpdate,
  type ProfileUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type SignalLookup,
  type SuggestionDraft,
  type ContentDraft,
} from "./connectors/types";
import { panelLink, postWebhook } from "./webhook";

/**
 * Motor de senales (spec v2 §6): corre los connectors por competidor segun
 * cadencia y presupuesto, persiste ci_signals / ci_signal_events /
 * ci_suggestions, actualiza perfiles/paginas, enruta eventos al radar y al
 * webhook, y recalcula derivados. Asincrono como el radar v1.
 */

const DAY_MS = 86_400_000;
const STALE_RUN_MS = 60 * 60_000;
const CADENCE_DAYS: Record<Cadence, number> = { weekly: 6, biweekly: 13, monthly: 27 };

export interface RunSignalsInput {
  trigger: "cron" | "manual";
  userId?: string | null;
  competitorIds?: string[];
  connectors?: string[];
}

interface ConnectorStat {
  connector: string;
  status: "ok" | "partial" | "skipped" | "error";
  detail?: string;
  competitorsChecked: number;
  competitorsSkipped: number;
  skippedBudget: number;
  signals: number;
  events: number;
  suggestions: number;
  content: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
  errors: string[];
}

function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function spentThisMonthUsd(): Promise<number> {
  const agg = await RadarRun.aggregate([
    { $match: { startedAt: { $gte: monthStart() }, "totals.costUsd": { $type: "number" } } },
    { $group: { _id: null, usd: { $sum: "$totals.costUsd" } } },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Math.round(((agg as any[])[0]?.usd ?? 0) * 1_000_000) / 1_000_000;
}

async function guardRunning() {
  const running = await RadarRun.findOne({ status: "running", mode: "signals" });
  if (!running) return;
  if (Date.now() - new Date(running.startedAt).getTime() > STALE_RUN_MS) {
    running.status = "error";
    running.finishedAt = new Date();
    running.errors.push("stale_run: marcada como error por la corrida siguiente");
    await running.save();
    return;
  }
  throw new CiError(409, "Ya hay una corrida de señales en curso", "run_in_progress", { runId: running.runId });
}

export async function runSignals(input: RunSignalsInput) {
  await guardRunning();
  const settings = await getSettings();
  const run = await RadarRun.create({
    runId: makeId("sigrun"),
    mode: "signals",
    trigger: input.trigger,
    triggeredByUserId: input.userId ?? null,
    scopeCompetitorIds: input.competitorIds ?? [],
    startedAt: new Date(),
    status: "running",
    connectors: [],
    budget: null,
    totals: {},
    errors: [],
  });
  void executeSignals(run, input, settings).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[competitors] señales ${run.runId} falló:`, msg);
    await RadarRun.updateOne({ runId: run.runId }, { $set: { status: "error", finishedAt: new Date() }, $push: { errors: msg } }).catch(() => undefined);
  });
  return sanitizeDoc(run);
}

function lite(doc: { competitorId: string; name: string; aliases?: string[]; website: string; websiteDomain: string; extraDomains?: string[]; priority: "A" | "B" | "C" }): CompetitorLite {
  return {
    competitorId: doc.competitorId,
    name: doc.name,
    aliases: doc.aliases ?? [],
    website: doc.website,
    websiteDomain: doc.websiteDomain,
    extraDomains: doc.extraDomains ?? [],
    priority: doc.priority,
  };
}

async function lastRunAtFor(competitorId: string, connector: string): Promise<Date | null> {
  const last = await CiSignal.findOne({ competitorId, connector }).sort({ observedAt: -1 }).select("observedAt").lean();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (last as any)?.observedAt ?? null;
}

function isDue(lastAt: Date | null, cadence: Cadence): boolean {
  if (!lastAt) return true;
  return (Date.now() - new Date(lastAt).getTime()) / DAY_MS >= CADENCE_DAYS[cadence];
}

function makeLookup(competitorId: string) {
  const previous = async (metric: string, opts: { profileId?: string | null; pageId?: string | null; network?: string | null } = {}): Promise<SignalLookup | null> => {
    const filter: Record<string, unknown> = { competitorId, metric };
    if (opts.profileId) filter.profileId = opts.profileId;
    if (opts.pageId) filter.pageId = opts.pageId;
    if (opts.network) filter.network = opts.network;
    const doc = await CiSignal.findOne(filter).sort({ observedAt: -1 }).lean();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = doc as any;
    return d ? { value: d.value, observedAt: d.observedAt, approx: Boolean(d.approx) } : null;
  };
  const history = async (metric: string, days: number, opts: { profileId?: string | null; pageId?: string | null } = {}): Promise<SignalLookup[]> => {
    const filter: Record<string, unknown> = { competitorId, metric, observedAt: { $gte: new Date(Date.now() - days * DAY_MS) } };
    if (opts.profileId) filter.profileId = opts.profileId;
    if (opts.pageId) filter.pageId = opts.pageId;
    const docs = await CiSignal.find(filter).sort({ observedAt: 1 }).limit(500).lean();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (docs as any[]).map((d) => ({ value: d.value, observedAt: d.observedAt, approx: Boolean(d.approx) }));
  };
  return { previous, history };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeSignals(run: any, input: RunSignalsInput, settings: CiSettingsRecord) {
  const errors: string[] = [];
  const stats: ConnectorStat[] = [];
  // Sólo los que se siguen gastan presupuesto de señales.
  const filter: Record<string, unknown> = { stage: "tracked", status: "active" };
  if (input.competitorIds?.length) filter.competitorId = { $in: input.competitorIds };
  const comps = await Competitor.find(filter).sort({ priority: 1, name: 1 });
  const forced = Boolean(input.competitorIds?.length) && input.trigger === "manual";

  const budgetUsd = settings.signals.monthlyBudgetUsd ?? 0;
  let spent = await spentThisMonthUsd();
  const spentBefore = spent;
  let cutApplied = false;
  const allowPaidNow = () => {
    if (!aiAvailable()) return false;
    if (budgetUsd <= 0) return true;
    return spent < budgetUsd;
  };

  const wanted = new Set((input.connectors?.length ? input.connectors : SIGNAL_CONNECTOR_REGISTRY.map((c) => c.id)) as string[]);
  const touched = new Set<string>();
  const eventsTotals = { created: 0, webhooks: 0, suggestions: 0, signals: 0, content: 0 };

  if (!settings.signals.enabled && input.trigger === "cron") {
    errors.push("signals.disabled: las señales están apagadas en la configuración");
  } else {
    for (const connector of SIGNAL_CONNECTOR_REGISTRY) {
      if (!wanted.has(connector.id)) continue;
      const cfg = settings.signals.connectors?.[connector.id];
      const stat: ConnectorStat = { connector: connector.id, status: "ok", competitorsChecked: 0, competitorsSkipped: 0, skippedBudget: 0, signals: 0, events: 0, suggestions: 0, content: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, errors: [] };
      if (cfg && cfg.enabled === false) {
        stat.status = "skipped";
        stat.detail = "deshabilitado en configuración";
        stats.push(stat);
        continue;
      }
      const health = await connector.healthCheck();
      if (!health.ok) {
        stat.status = "skipped";
        stat.detail = health.detail;
        stats.push(stat);
        run.set("connectors", stats);
        await run.save();
        continue;
      }
      for (const comp of comps) {
        ensureV2(comp);
        const cadence = settings.signals.cadenceByPriority[comp.priority as "A" | "B" | "C"] ?? "monthly";
        if (!forced) {
          const lastAt = await lastRunAtFor(comp.competitorId, connector.id);
          if (!isDue(lastAt, cadence)) {
            stat.competitorsSkipped++;
            continue;
          }
        }
        const allowPaid = allowPaidNow();
        if (connector.paid && !allowPaid) {
          stat.skippedBudget++;
          cutApplied = true;
          continue;
        }
        const lookup = makeLookup(comp.competitorId);
        const ctx: SignalContext = {
          competitor: lite(comp),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          profiles: (comp.socialProfiles as any[]).map((p) => (typeof p.toObject === "function" ? p.toObject() : p)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pages: (comp.watchedPages as any[]).map((p) => (typeof p.toObject === "function" ? p.toObject() : p)),
          previous: lookup.previous,
          history: lookup.history,
          settings,
          runId: run.runId,
          allowPaid,
          forced,
        };
        let out: SignalConnectorResult;
        try {
          out = await connector.run(ctx);
        } catch (err) {
          stat.errors.push(`${comp.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        stat.competitorsChecked++;
        stat.inputTokens += out.usage.inputTokens;
        stat.outputTokens += out.usage.outputTokens;
        stat.webSearches += out.usage.webSearches;
        stat.costUsd = Math.round((stat.costUsd + out.usage.costUsd) * 1_000_000) / 1_000_000;
        spent += out.usage.costUsd;
        if (out.error) stat.errors.push(`${comp.name}: ${out.error}`);
        // Salteo explicable (sin perfiles, sin key, fuente limitada): no es error.
        if (out.skipped) stat.detail = out.skipped;
        const persisted = await persistConnectorResult(comp, connector, out, settings, run.runId);
        stat.signals += persisted.signals;
        stat.events += persisted.events;
        stat.suggestions += persisted.suggestions;
        stat.content += persisted.content;
        eventsTotals.content += persisted.content;
        eventsTotals.created += persisted.events;
        eventsTotals.webhooks += persisted.webhooks;
        eventsTotals.suggestions += persisted.suggestions;
        eventsTotals.signals += persisted.signals;
        if (persisted.signals || persisted.events || persisted.suggestions || persisted.content || persisted.updated) touched.add(comp.competitorId);
        await sleep(connector.minDelayMs ?? (connector.paid ? 1_000 : 400));
      }
      if (stat.errors.length) stat.status = stat.competitorsChecked > stat.errors.length ? "partial" : "error";
      stats.push(stat);
      run.set("connectors", stats);
      run.set("budget", { monthUsd: budgetUsd, spentBeforeUsd: spentBefore, spentRunUsd: Math.round((spent - spentBefore) * 1_000_000) / 1_000_000, cutApplied });
      await run.save();
    }
  }

  // Recalcular derivados (traccion con eventos 90 d) de los competidores tocados.
  for (const id of touched) {
    try {
      const doc = await Competitor.findOne({ competitorId: id });
      if (!doc) continue;
      ensureV2(doc);
      const extra = await tractionExtraFor(id);
      recomputeDerived(doc, settings, extra);
      await doc.save();
    } catch (err) {
      errors.push(`recompute ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const totalCost = Math.round((spent - spentBefore) * 1_000_000) / 1_000_000;
  run.set("connectors", stats);
  run.set("budget", { monthUsd: budgetUsd, spentBeforeUsd: spentBefore, spentRunUsd: totalCost, cutApplied });
  run.set("totals", { ...eventsTotals, competitors: touched.size, costUsd: totalCost });
  run.set("errors", errors.concat(stats.flatMap((s) => s.errors.map((e) => `${s.connector}: ${e}`))));
  run.finishedAt = new Date();
  const anyError = stats.some((s) => s.status === "error") || errors.length > 0;
  const anyOk = stats.some((s) => s.status === "ok" || s.status === "partial");
  run.status = !anyError ? "ok" : anyOk ? "partial" : "error";
  await run.save();
  return run;
}

export async function tractionExtraFor(competitorId: string) {
  const since90 = new Date(Date.now() - 90 * DAY_MS);
  const [events90d, reviewSig, ph] = await Promise.all([
    CiSignalEvent.countDocuments({ competitorId, observedAt: { $gte: since90 }, kind: { $in: ["follower_jump", "activity_spike", "launch", "funding", "ph_launch", "app_release", "feature_announce"] } }),
    CiSignal.findOne({ competitorId, metric: "reviewCount" }).sort({ observedAt: -1 }).lean(),
    CiSignalEvent.exists({ competitorId, kind: "ph_launch" }),
  ]);
  return {
    events90d,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewCount: typeof (reviewSig as any)?.value === "number" ? ((reviewSig as any).value as number) : null,
    phLaunch: Boolean(ph),
  };
}

async function persistConnectorResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  comp: any,
  connector: SignalConnector,
  out: SignalConnectorResult,
  settings: CiSettingsRecord,
  runId: string,
) {
  const now = new Date();
  const competitorId: string = comp.competitorId;
  let updated = false;

  // --- senales (dedupe: misma metrica/valor el mismo dia no se repite)
  const docs: Record<string, unknown>[] = [];
  for (const s of out.signals as SignalDraft[]) {
    const observedAt = s.observedAt ?? now;
    const dup = await CiSignal.findOne({
      competitorId,
      connector: connector.id,
      metric: s.metric,
      profileId: s.profileId ?? null,
      pageId: s.pageId ?? null,
      observedAt: { $gte: new Date(observedAt.getTime() - DAY_MS) },
    }).lean();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (dup && JSON.stringify((dup as any).value) === JSON.stringify(s.value)) continue;
    docs.push({
      signalId: makeId("sig"),
      competitorId,
      profileId: s.profileId ?? null,
      pageId: s.pageId ?? null,
      connector: connector.id,
      network: s.network ?? null,
      metric: s.metric,
      value: s.value,
      unit: s.unit ?? "count",
      approx: Boolean(s.approx),
      sourceUrl: s.sourceUrl ?? "",
      observedAt,
      runId,
    });
  }
  if (docs.length) await CiSignal.insertMany(docs, { ordered: false });

  // --- contenido publicado (v2.1): todo lo que publicaron, material o no
  let newContent = 0;
  for (const c of (out.content ?? []) as ContentDraft[]) {
    const ref = c.url || `${c.network}:${c.externalId ?? c.title}`;
    const dedupeKey = createHash("sha1").update(`${competitorId}|${ref}`).digest("hex");
    const res = await CiContent.updateOne(
      { dedupeKey },
      {
        $set: {
          title: c.title.slice(0, 300),
          excerpt: (c.excerpt ?? "").slice(0, 1_500),
          url: c.url,
          publishedAt: c.publishedAt,
          kind: c.kind ?? "post",
          featureKeys: c.featureKeys ?? [],
          engagement: c.engagement ?? null,
          fetchedAt: now,
        },
        $setOnInsert: {
          contentId: makeId("cont"),
          competitorId,
          network: c.network,
          profileId: c.profileId ?? null,
          pageId: c.pageId ?? null,
          externalId: c.externalId ?? "",
          connector: connector.id,
          dedupeKey,
          runId,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) newContent++;
  }

  // --- eventos (upsert por dedupeKey) + radar + webhook
  let newEvents = 0;
  let webhooks = 0;
  const createdEventIds: string[] = [];
  for (const e of out.events as SignalEventDraft[]) {
    const dedupeKey = (e.dedupeKey ?? `${competitorId}|${e.kind}|${e.sourceUrl}`).slice(0, 500);
    const exists = await CiSignalEvent.findOne({ dedupeKey }).select("eventId").lean();
    if (exists) continue;
    const eventId = makeId("sev");
    const observedAt = e.observedAt ?? now;
    await CiSignalEvent.create({
      eventId,
      competitorId,
      kind: e.kind,
      severity: e.severity,
      title: e.title.slice(0, 300),
      summary: e.summary.slice(0, 2_000),
      sourceUrl: e.sourceUrl,
      connector: connector.id,
      network: e.network ?? null,
      evidence: e.evidence ?? null,
      featureKeys: e.featureKeys ?? [],
      dedupeKey,
      observedAt,
      runId,
      status: "new",
    });
    newEvents++;
    createdEventIds.push(eventId);
    if (e.severity !== "low") {
      const item = await RadarItem.create({
        radarId: makeId("radar"),
        kind: "signal",
        competitorId,
        eventId,
        severity: e.severity,
        detectedName: comp.name,
        url: e.sourceUrl,
        source: "signal",
        sourceLabel: connector.id,
        aiSummary: e.summary.slice(0, 500),
        changeSummary: `${e.title}`,
        changeArea: e.kind,
        status: "pending",
        firstSeenAt: now,
        lastSeenAt: now,
        runId,
      });
      await CiSignalEvent.updateOne({ eventId }, { $set: { radarId: item.radarId } });
    }
    if (settings.signals.webhookUrl && settings.signals.webhookEvents?.includes(e.kind)) {
      const res = await postWebhook(settings.signals.webhookUrl, {
        type: "competitor_event",
        competitor: { competitorId, name: comp.name, priority: comp.priority },
        event: { kind: e.kind, severity: e.severity, title: e.title, summary: e.summary, sourceUrl: e.sourceUrl, observedAt },
        link: panelLink(competitorId),
      });
      if (res.ok) webhooks++;
      else console.warn(`[competitors] webhook falló (${e.kind}):`, res.error);
    }
  }

  // --- sugerencias (una pendiente por campo y competidor)
  let newSuggestions = 0;
  for (const s of (out.suggestions ?? []) as SuggestionDraft[]) {
    const current = currentValueFor(comp, s.field);
    if (JSON.stringify(current) === JSON.stringify(s.proposedValue)) continue;
    const res = await CiSuggestion.updateOne(
      { competitorId, field: s.field, status: "pending" },
      {
        $set: { proposedValue: s.proposedValue, currentValue: current, reason: s.reason, evidenceUrl: s.evidenceUrl ?? "", quote: (s.quote ?? "").slice(0, 300), confidence: s.confidence ?? "medium", source: "signal", eventId: createdEventIds[0] ?? null },
        $setOnInsert: { suggestionId: makeId("sug"), competitorId, field: s.field, status: "pending" },
      },
      { upsert: true },
    );
    if (res.upsertedCount) newSuggestions++;
  }

  // --- actualizaciones de perfiles / paginas / perfiles nuevos
  if (out.profileUpdates?.length || out.newProfiles?.length || out.pageUpdates?.length) {
    const doc = await Competitor.findOne({ competitorId });
    if (doc) {
      ensureV2(doc);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profiles: any[] = (doc.socialProfiles as any[]).map((p) => (typeof p.toObject === "function" ? p.toObject() : { ...p }));
      for (const u of (out.profileUpdates ?? []) as ProfileUpdate[]) {
        const p = profiles.find((x) => x.profileId === u.profileId);
        if (!p) continue;
        if (u.status) p.status = u.status;
        if (u.latest) p.latest = u.latest;
        if (u.lastOkAt) p.lastOkAt = u.lastOkAt;
        if (u.externalId) p.externalId = u.externalId;
        if (u.handle) p.handle = u.handle;
        if (u.url) p.url = u.url;
        p.lastCheckedAt = now;
      }
      for (const n of (out.newProfiles ?? []) as NewProfileDraft[]) {
        const key = `${n.network}:${(n.handle || n.url).toLowerCase()}`;
        if (profiles.some((p) => `${p.network}:${(p.handle || p.url || "").toLowerCase()}` === key || (n.url && p.url && p.url.toLowerCase() === n.url.toLowerCase()))) continue;
        const profileId = makeId("sp");
        profiles.push({ profileId, network: n.network, handle: n.handle ?? "", url: n.url, externalId: n.externalId ?? "", discoveredBy: "signal", status: "candidate", lastCheckedAt: now, lastOkAt: null, latest: n.latest ?? {} });
        setMeta(doc, `socialProfiles.${profileId}`, makeMeta("signal", { confidence: "medium", sourceUrl: n.url }));
      }
      doc.set("socialProfiles", profiles);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages: any[] = (doc.watchedPages as any[]).map((p) => (typeof p.toObject === "function" ? p.toObject() : { ...p }));
      for (const u of (out.pageUpdates ?? []) as PageUpdate[]) {
        const p = pages.find((x) => x.pageId === u.pageId);
        if (!p) continue;
        if (u.status) p.status = u.status;
        if (u.lastHash !== undefined) p.lastHash = u.lastHash;
        if (u.lastCheckedAt) p.lastCheckedAt = u.lastCheckedAt;
        if (u.lastChangedAt) p.lastChangedAt = u.lastChangedAt;
        if (u.feedUrl !== undefined) p.feedUrl = u.feedUrl;
      }
      doc.set("watchedPages", pages);
      await doc.save();
      updated = true;
    }
  }

  return { signals: docs.length, events: newEvents, webhooks, suggestions: newSuggestions, content: newContent, updated };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function currentValueFor(comp: any, field: string): unknown {
  const m = /^featureMatrix\.(.+)$/.exec(field);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (m) return (comp.featureMatrix as any[]).find((f) => f.key === m[1])?.has ?? "unknown";
  if (field === "priority") return comp.priority;
  return null;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

/**
 * Check inmediato al confirmar un perfil (spec v2 §10): corre en background el
 * connector GRATUITO que atiende esa red, para que la ficha muestre datos sin
 * esperar al martes. Los perfiles de redes sin API (search_snippets, pago) no
 * disparan nada: se miden en la corrida semanal.
 */
export function triggerProfileCheck(competitorId: string, network: string): void {
  const connector = SIGNAL_CONNECTOR_REGISTRY.find((c) => !c.paid && c.accepts.networks?.includes(network as never));
  if (!connector) return;
  void runSignals({ trigger: "manual", competitorIds: [competitorId], connectors: [connector.id] }).catch((err) => {
    // 409 (otra corrida en curso) es esperable: el perfil se mide en la próxima.
    if (err instanceof CiError && err.code === "run_in_progress") return;
    console.warn(`[competitors] check inmediato de ${network} falló:`, (err as Error)?.message ?? err);
  });
}

export async function connectorsHealth() {
  const settings = await getSettings();
  const out = [];
  for (const c of SIGNAL_CONNECTOR_REGISTRY) {
    const h = await c.healthCheck();
    const last = await CiSignal.findOne({ connector: c.id }).sort({ observedAt: -1 }).select("observedAt").lean();
    out.push({
      id: c.id,
      label: c.label,
      paid: c.paid,
      enabled: settings.signals.connectors?.[c.id]?.enabled !== false,
      ok: h.ok,
      detail: h.detail,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastSignalAt: (last as any)?.observedAt ?? null,
    });
  }
  const spent = await spentThisMonthUsd();
  return { connectors: out, budget: { monthUsd: settings.signals.monthlyBudgetUsd, spentUsd: spent } };
}

export async function listSignals(q: { competitorId: string; metric?: string; network?: string; from?: Date; to?: Date; limit: number }) {
  const filter: Record<string, unknown> = { competitorId: q.competitorId };
  if (q.metric) filter.metric = q.metric;
  if (q.network) filter.network = q.network;
  if (q.from || q.to) filter.observedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const docs = await CiSignal.find(filter).sort({ observedAt: 1 }).limit(q.limit).lean();
  return { data: docs.map((d) => sanitizeDoc(d)) };
}

export async function listEvents(q: { competitorId?: string; kind?: string; status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (q.competitorId) filter.competitorId = q.competitorId;
  if (q.kind) filter.kind = q.kind;
  if (q.status && q.status !== "all") filter.status = q.status;
  const skip = (q.page - 1) * q.limit;
  const [docs, total] = await Promise.all([
    CiSignalEvent.find(filter).sort({ observedAt: -1 }).skip(skip).limit(q.limit).lean(),
    CiSignalEvent.countDocuments(filter),
  ]);
  const ids = Array.from(new Set(docs.map((d) => String(d.competitorId))));
  const names = new Map((await Competitor.find({ competitorId: { $in: ids } }).select("competitorId name").lean()).map((c) => [String(c.competitorId), c.name]));
  return { data: docs.map((d) => ({ ...sanitizeDoc(d), competitorName: names.get(String(d.competitorId)) ?? null })), total, page: q.page, limit: q.limit };
}

export async function patchEvent(eventId: string, status: "new" | "seen" | "archived") {
  const doc = await CiSignalEvent.findOneAndUpdate({ eventId }, { $set: { status } }, { new: true });
  if (!doc) throw new CiError(404, "Evento no encontrado", "not_found");
  if (status !== "new" && doc.radarId) {
    await RadarItem.updateOne({ radarId: doc.radarId, status: "pending" }, { $set: { status: "acknowledged", decidedAt: new Date(), decidedBy: "user" } });
  }
  return sanitizeDoc(doc);
}

/** Resumen de senales de un competidor para la ficha (§10 GET /:id/signals). */
export async function competitorSignalsSummary(competitorId: string) {
  const comp = await Competitor.findOne({ competitorId }).lean();
  if (!comp) throw new CiError(404, "Competidor no encontrado", "not_found");
  const since90 = new Date(Date.now() - 90 * DAY_MS);
  const [latestAgg, events, suggestions, series] = await Promise.all([
    CiSignal.aggregate([
      { $match: { competitorId } },
      { $sort: { observedAt: -1 } },
      { $group: { _id: { metric: "$metric", profileId: "$profileId", pageId: "$pageId", network: "$network", unit: "$unit" }, value: { $first: "$value" }, observedAt: { $first: "$observedAt" }, approx: { $first: "$approx" }, sourceUrl: { $first: "$sourceUrl" } } },
    ]),
    CiSignalEvent.find({ competitorId, observedAt: { $gte: since90 } }).sort({ observedAt: -1 }).limit(100).lean(),
    CiSuggestion.find({ competitorId, status: "pending" }).sort({ createdAt: -1 }).lean(),
    CiSignal.find({ competitorId, metric: { $in: ["followers", "subscribers", "rating", "reviewCount", "openRoles", "searchInterest", "postsLast30d", "newsCount", "redditMentions", "phVotes"] }, observedAt: { $gte: since90 } })
      .sort({ observedAt: 1 })
      .limit(2_000)
      .lean(),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latest = (latestAgg as any[]).map((r) => ({ ...r._id, value: r.value, observedAt: r.observedAt, approx: r.approx, sourceUrl: r.sourceUrl }));
  const seriesByKey: Record<string, Array<{ t: Date; v: unknown; approx: boolean }>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of series as any[]) {
    const key = `${s.metric}|${s.profileId ?? s.pageId ?? s.network ?? ""}|${s.unit ?? ""}`;
    (seriesByKey[key] ??= []).push({ t: s.observedAt, v: s.value, approx: Boolean(s.approx) });
  }
  return {
    competitorId,
    latest,
    events: events.map((e) => sanitizeDoc(e)),
    suggestions: suggestions.map((s) => sanitizeDoc(s)),
    series: seriesByKey,
  };
}

export { SIGNAL_CONNECTOR_REGISTRY, getSignalConnector };
export type { SignalConnectorId, LlmUsageRecord };
