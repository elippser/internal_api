import { makeId } from "../../../shared/utils/ids";
import { fetchPage, textHash } from "../../../shared/web/fetchPage";
import { domainOf } from "../../crm/crm.model";
import { addUsage, aiAvailable, callJson, draftModel, emptyUsage } from "../ciLlm";
import {
  Competitor,
  PageSnapshot,
  RadarItem,
  RadarRun,
  sanitizeDoc,
  type CompetitorSegment,
  type LlmUsageRecord,
  type PromotionReason,
  type RadarRunMode,
  type SnapshotPage,
} from "../competitors.model";
import { CiError, competitorsService } from "../competitors.service";
import { recomputeDerived } from "../quality.service";
import { getSettings, type CiSettingsRecord } from "../settings.service";
import { actOnSuggestion } from "../signals/suggestions.service";
import { CiSignalEvent } from "../competitors.model";
import type { RadarConnector, RadarConnectorContext } from "./connectors/types";
import { webSearchConnector } from "./connectors/webSearch.connector";

/**
 * Orquestador del radar (spec §7.4-7.5): corre los connectors, dedupea por
 * dominio contra Tier 1 y contra la propia cola, persiste items y corridas.
 * El change watch compara snapshots de texto (home + pricing) y solo llama a
 * Haiku cuando el hash cambio.
 */

const CONNECTORS: Record<string, RadarConnector> = {
  web_search: webSearchConnector,
};

function getConnector(id: string): RadarConnector {
  const c = CONNECTORS[id];
  if (!c) throw new CiError(501, `Connector de radar "${id}" no implementado`, "not_implemented");
  return c;
}

const STALE_RUN_MS = 30 * 60_000;
const SNAPSHOT_TEXT_CAP = 30_000;
const CHANGE_TEXT_CAP = 12_000;
const MIN_TEXT_CHARS = 800;

const CHANGE_SYSTEM =
  "Sos un analista de competencia. Te paso dos versiones del texto de una misma página de un software hotelero competidor " +
  "(antes y después). Decidí si el cambio es MATERIAL para pricing, planes, features o posicionamiento, o si es ruido " +
  "(blog, fechas, cookies, testimonios rotativos, textos legales). " +
  'Devolvé SOLO JSON: {"material":boolean,"summary":string (1-3 líneas, qué cambió; vacío si no es material),' +
  '"area":"pricing"|"features"|"positioning"|"other"}';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface QueryStat {
  queryId: string;
  text: string;
  status: "ok" | "error";
  error?: string;
  candidates: number;
  created: number;
  seenAgain: number;
  alreadyTier1: number;
  noise: number;
  webSearches: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ChangeStats {
  checked: number;
  changed: number;
  unavailable: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunRadarInput {
  mode: RadarRunMode;
  trigger: "cron" | "manual";
  userId?: string | null;
  competitorIds?: string[];
}

async function guardRunningRun() {
  const running = await RadarRun.findOne({ status: "running" });
  if (!running) return;
  const started = new Date(running.startedAt).getTime();
  if (Date.now() - started > STALE_RUN_MS) {
    running.status = "error";
    running.finishedAt = new Date();
    running.errors.push("stale_run: marcada como error por la corrida siguiente");
    await running.save();
    return;
  }
  throw new CiError(409, "Ya hay una corrida del radar en curso", "run_in_progress", { runId: running.runId });
}

/**
 * Arranca una corrida y devuelve ENSEGUIDA el documento en `running`: una
 * corrida completa (5 queries con web_search, ~40 s cada una) supera cualquier
 * timeout razonable de un request. La UI hace polling de GET /radar/runs.
 */
export async function runRadar(input: RunRadarInput) {
  if (!aiAvailable()) {
    throw new CiError(503, "IA no disponible: falta ANTHROPIC_API_KEY", "ai_unavailable");
  }
  await guardRunningRun();
  const settings = await getSettings();

  const run = await RadarRun.create({
    runId: makeId("radrun"),
    mode: input.mode,
    trigger: input.trigger,
    triggeredByUserId: input.userId ?? null,
    scopeCompetitorIds: input.competitorIds ?? [],
    startedAt: new Date(),
    status: "running",
    queries: [],
    changes: null,
    totals: {},
    errors: [],
  });

  void executeRun(run, input, settings).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[competitors] corrida ${run.runId} falló:`, msg);
    await RadarRun.updateOne(
      { runId: run.runId },
      { $set: { status: "error", finishedAt: new Date() }, $push: { errors: msg } },
    ).catch(() => undefined);
  });

  return sanitizeDoc(run);
}

/** Espera a que una corrida termine (tests / scripts). */
export async function waitForRun(runId: string, timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const run = await RadarRun.findOne({ runId }).lean();
    if (!run) throw new CiError(404, "Corrida no encontrada", "not_found");
    if (run.status !== "running") return sanitizeDoc(run);
    if (Date.now() - t0 > timeoutMs) return sanitizeDoc(run);
    await sleep(2_000);
  }
}

async function executeRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: any,
  input: RunRadarInput,
  settings: CiSettingsRecord,
) {
  const errors: string[] = [];
  const queryStats: QueryStat[] = [];
  let changeStats: ChangeStats | null = null;
  let totalCost = 0;

  try {
    if (input.mode === "search" || input.mode === "both") {
      if (!settings.radar.enabled) {
        errors.push("radar.disabled: la búsqueda está apagada en la configuración");
      } else {
        const connector = getConnector("web_search");
        const ctx: RadarConnectorContext = {
          excludedDomains: settings.radar.excludedDomains,
          ourDomains: settings.radar.ourDomains,
          maxSearches: settings.radar.maxSearchesPerQuery,
        };
        const excluded = new Set([...settings.radar.excludedDomains, ...settings.radar.ourDomains]);
        // Dominio principal + extraDomains (v2): un alias de dominio no es un entrante.
        const tier1 = await competitorsService.allKnownDomains();
        // Secuencial a proposito: no disparar rate limits de la busqueda web.
        for (const q of settings.radar.queries.filter((x) => x.enabled)) {
          const stat: QueryStat = {
            queryId: q.queryId,
            text: q.text,
            status: "ok",
            candidates: 0,
            created: 0,
            seenAgain: 0,
            alreadyTier1: 0,
            noise: 0,
            webSearches: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          };
          try {
            const out = await connector.search({ queryId: q.queryId, text: q.text }, ctx);
            stat.webSearches = out.usage.webSearches;
            stat.inputTokens = out.usage.inputTokens;
            stat.outputTokens = out.usage.outputTokens;
            stat.costUsd = out.usage.costUsd;
            totalCost += out.usage.costUsd;
            if (out.error) {
              stat.status = "error";
              stat.error = out.error;
              errors.push(`query "${q.text}": ${out.error}`);
            }
            stat.candidates = out.candidates.length;
            const now = new Date();
            for (const c of out.candidates) {
              const domain = domainOf(c.url);
              if (!domain || excluded.has(domain)) continue;
              if (tier1.has(domain)) {
                stat.alreadyTier1++;
                continue;
              }
              // v2.2: una sola lista. El entrante ES un competidor en etapa
              // "detected"; ya no hay cola aparte que haya que reconciliar.
              const existing = await Competitor.findOne({ websiteDomain: domain });
              if (existing) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const det: any = existing.detection ?? {};
                const queries: string[] = Array.isArray(det.foundByQueryIds) ? det.foundByQueryIds : [];
                if (!queries.includes(q.queryId)) queries.push(q.queryId);
                existing.set("detection", { ...det, seenCount: (det.seenCount ?? 1) + 1, lastSeenAt: now, foundByQueryIds: queries });
                existing.markModified("detection");
                await existing.save();
                stat.seenAgain++;
                continue;
              }
              const isNoise = c.classification === "noise";
              const fresh = new Competitor({
                competitorId: makeId("comp"),
                schemaVersion: 2,
                name: (c.name || domain).slice(0, 160),
                website: c.url || `https://${domain}`,
                websiteDomain: domain,
                // Sin curar: el segmento se define al pasarlo a seguimiento.
                segment: "latam",
                priority: "C",
                status: "active",
                stage: isNoise ? "discarded" : "detected",
                detection: {
                  source: connector.id,
                  sourceLabel: c.sourceLabel,
                  foundByQueryIds: [q.queryId],
                  aiSummary: c.summary,
                  aiConfidence: c.confidence,
                  aiClassification: c.classification,
                  tractionSignals: c.tractionSignals,
                  seenCount: 1,
                  firstSeenAt: now,
                  lastSeenAt: now,
                  runId: run.runId,
                  discardReason: isNoise ? "ai_noise" : "",
                  decidedBy: isNoise ? "ai" : null,
                },
                evidence: c.url ? [{ evidenceId: makeId("ev"), kind: "radar", url: c.url, note: c.summary, addedAt: now, addedByUserId: null }] : [],
                lastReviewedAt: now,
              });
              recomputeDerived(fresh, settings);
              await fresh.save();
              if (isNoise) stat.noise++;
              else stat.created++;
            }
          } catch (err) {
            stat.status = "error";
            stat.error = err instanceof Error ? err.message : String(err);
            errors.push(`query "${q.text}": ${stat.error}`);
          }
          queryStats.push(stat);
          run.set("queries", queryStats);
          await run.save();
        }
      }
    }

    if (input.mode === "changes" || input.mode === "both") {
      const res = await runChangeWatch(run.runId, input.competitorIds);
      changeStats = res.stats;
      totalCost += res.stats.costUsd;
      if (res.errorsList.length) errors.push(...res.errorsList);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const created = queryStats.reduce((a, q) => a + q.created, 0);
  const seenAgain = queryStats.reduce((a, q) => a + q.seenAgain, 0);
  const noise = queryStats.reduce((a, q) => a + q.noise, 0);
  run.set("queries", queryStats);
  run.set("changes", changeStats);
  run.set("totals", {
    created,
    seenAgain,
    noise,
    changed: changeStats?.changed ?? 0,
    costUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
  });
  run.set("errors", errors);
  run.finishedAt = new Date();
  const anyOk = queryStats.some((q) => q.status === "ok") || (changeStats && changeStats.errors === 0);
  run.status = errors.length === 0 ? "ok" : anyOk ? "partial" : "error";
  await run.save();
  return run;
}

// ---------------------------------------------------------------------------
// Change watch
// ---------------------------------------------------------------------------

export async function runChangeWatch(runId: string | null, competitorIds?: string[]) {
  const stats: ChangeStats = {
    checked: 0,
    changed: 0,
    unavailable: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const errorsList: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [];
  let usage: LlmUsageRecord = emptyUsage();

  const filter: Record<string, unknown> = { status: "active" };
  if (competitorIds?.length) filter.competitorId = { $in: competitorIds };
  const comps = await Competitor.find({ ...filter, stage: "tracked" }).select("competitorId name website pricing").lean();

  for (const comp of comps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pricingUrl: string = (comp.pricing as any)?.pricingUrl ?? "";
    const pages: { page: SnapshotPage; url: string }[] = [{ page: "home", url: comp.website }];
    if (pricingUrl) pages.push({ page: "pricing", url: pricingUrl });

    for (const { page, url } of pages) {
      stats.checked++;
      try {
        const res = await fetchPage(url);
        const prev = await PageSnapshot.findOne({ competitorId: comp.competitorId, page });
        if (!res.ok || res.text.length < MIN_TEXT_CHARS) {
          stats.unavailable++;
          // No pisa el texto anterior: si la pagina vuelve, se compara contra el.
          await PageSnapshot.updateOne(
            { competitorId: comp.competitorId, page },
            {
              $set: { url, status: "unavailable", error: res.error ?? "short_text", fetchedAt: new Date() },
              $setOnInsert: { snapshotId: makeId("snap"), competitorId: comp.competitorId, page, text: "", textHash: null },
            },
            { upsert: true },
          );
          continue;
        }
        const hash = textHash(res.text);
        if (prev && prev.status === "ok" && prev.textHash && prev.textHash !== hash) {
          const r = await callJson({
            model: draftModel(),
            system: CHANGE_SYSTEM,
            user:
              `Competidor: ${comp.name}\nPágina: ${page} (${url})\n\n=== ANTES ===\n${(prev.text ?? "").slice(0, CHANGE_TEXT_CAP)}\n\n` +
              `=== DESPUÉS ===\n${res.text.slice(0, CHANGE_TEXT_CAP)}\n\nDevolvé el JSON.`,
            maxTokens: 500,
            timeoutMs: 60_000,
          });
          usage = addUsage(usage, r.usage);
          if (r.json?.material) {
            const item = await RadarItem.create({
              radarId: makeId("radar"),
              kind: "tracked_change",
              competitorId: comp.competitorId,
              changedPage: page,
              changeSummary: typeof r.json.summary === "string" ? r.json.summary.slice(0, 1_000) : "",
              changeArea: typeof r.json.area === "string" ? r.json.area : "other",
              before: { textHash: prev.textHash, fetchedAt: prev.fetchedAt },
              after: { textHash: hash, fetchedAt: new Date() },
              url,
              domain: null,
              source: "web_search",
              sourceLabel: "change_watch",
              aiSummary: "",
              status: "pending",
              lastSeenAt: new Date(),
              firstSeenAt: new Date(),
              runId,
            });
            stats.changed++;
            items.push(sanitizeDoc(item));
          }
        }
        await PageSnapshot.updateOne(
          { competitorId: comp.competitorId, page },
          {
            $set: {
              url,
              text: res.text.slice(0, SNAPSHOT_TEXT_CAP),
              textHash: hash,
              fetchedAt: new Date(),
              status: "ok",
              error: null,
            },
            $setOnInsert: { snapshotId: makeId("snap"), competitorId: comp.competitorId, page },
          },
          { upsert: true },
        );
      } catch (err) {
        stats.errors++;
        errorsList.push(`${comp.name} ${page}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(1_000);
    }
  }

  stats.inputTokens = usage.inputTokens;
  stats.outputTokens = usage.outputTokens;
  stats.costUsd = usage.costUsd;
  return { stats, errorsList, items };
}

/** Check puntual desde el detalle: corre el watch solo para ese competidor y deja su corrida. */
export async function checkCompetitorChanges(competitorId: string, userId: string | null) {
  if (!aiAvailable()) {
    throw new CiError(503, "IA no disponible: falta ANTHROPIC_API_KEY", "ai_unavailable");
  }
  const comp = await Competitor.findOne({ competitorId }).lean();
  if (!comp) throw new CiError(404, "Competidor no encontrado", "not_found");
  const run = await RadarRun.create({
    runId: makeId("radrun"),
    mode: "changes",
    trigger: "manual",
    triggeredByUserId: userId,
    scopeCompetitorIds: [competitorId],
    startedAt: new Date(),
    status: "running",
  });
  const res = await runChangeWatch(run.runId, [competitorId]);
  run.set("changes", res.stats);
  run.set("totals", { created: 0, seenAgain: 0, noise: 0, changed: res.stats.changed, costUsd: res.stats.costUsd });
  run.set("errors", res.errorsList);
  run.finishedAt = new Date();
  run.status = res.errorsList.length ? "partial" : "ok";
  await run.save();
  return { changed: res.stats.changed, items: res.items, run: sanitizeDoc(run) };
}

// ---------------------------------------------------------------------------
// Cola: listado y triage
// ---------------------------------------------------------------------------

export interface ListRadarInput {
  status?: string;
  kind?: string;
  page: number;
  limit: number;
}

export async function listRadarItems(opts: ListRadarInput) {
  const filter: Record<string, unknown> = {};
  if (opts.status && opts.status !== "all") filter.status = opts.status;
  if (opts.kind) filter.kind = opts.kind;
  const skip = (opts.page - 1) * opts.limit;
  const [docs, total] = await Promise.all([
    RadarItem.find(filter).sort({ lastSeenAt: -1 }).skip(skip).limit(opts.limit).lean(),
    RadarItem.countDocuments(filter),
  ]);

  const domains = docs.filter((d) => d.kind === "new_entrant" && d.domain).map((d) => String(d.domain));
  const compIds = docs.filter((d) => d.kind === "tracked_change" && d.competitorId).map((d) => String(d.competitorId));
  const [byDomain, byId] = await Promise.all([
    domains.length
      ? Competitor.find({ websiteDomain: { $in: domains } }).select("competitorId name websiteDomain").lean()
      : [],
    compIds.length ? Competitor.find({ competitorId: { $in: compIds } }).select("competitorId name").lean() : [],
  ]);
  const domainMap = new Map(byDomain.map((c) => [String(c.websiteDomain), { competitorId: c.competitorId, name: c.name }]));
  const idMap = new Map(byId.map((c) => [String(c.competitorId), c.name]));

  const data = docs.map((d) => {
    const obj = sanitizeDoc(d);
    if (d.kind === "new_entrant" && d.domain && domainMap.has(String(d.domain))) {
      obj.alreadyTier1 = domainMap.get(String(d.domain));
    }
    if (d.kind === "tracked_change" && d.competitorId) {
      obj.competitorName = idMap.get(String(d.competitorId)) ?? null;
    }
    return obj;
  });
  return { data, total, page: opts.page, limit: opts.limit };
}

export async function listRadarRuns(limit = 20) {
  const docs = await RadarRun.find({}).sort({ startedAt: -1 }).limit(limit).lean();
  return { data: docs.map((d) => sanitizeDoc(d)) };
}

export interface RadarActionInput {
  action: "discard" | "restore" | "acknowledge" | "promote" | "link" | "accept";
  reason?: string;
  segment?: CompetitorSegment;
  promotionReasons?: PromotionReason[];
  promotionNote?: string;
}

export async function actOnRadarItem(radarId: string, input: RadarActionInput, userId: string | null) {
  const item = await RadarItem.findOne({ radarId });
  if (!item) throw new CiError(404, "Item del radar no encontrado", "not_found");
  const now = new Date();

  switch (input.action) {
    case "discard": {
      item.status = "discarded";
      item.decidedAt = now;
      item.decidedByUserId = userId;
      item.decidedBy = "user";
      item.discardReason = input.reason ?? "";
      await item.save();
      // Mencion descartada = sugerencia rechazada; senal descartada = evento archivado.
      if (item.suggestionId) await actOnSuggestion(item.suggestionId, "reject", userId).catch(() => undefined);
      if (item.eventId) await CiSignalEvent.updateOne({ eventId: item.eventId }, { $set: { status: "archived" } });
      return { item: sanitizeDoc(item) };
    }
    case "restore": {
      item.status = "pending";
      item.decidedAt = null;
      item.decidedByUserId = null;
      item.decidedBy = null;
      item.discardReason = "";
      await item.save();
      return { item: sanitizeDoc(item) };
    }
    case "acknowledge": {
      if (item.kind !== "tracked_change" && item.kind !== "signal" && item.kind !== "mention") {
        throw new CiError(400, "Sólo los cambios, señales y menciones se marcan como vistos", "invalid_action");
      }
      item.status = "acknowledged";
      item.decidedAt = now;
      item.decidedByUserId = userId;
      item.decidedBy = "user";
      await item.save();
      if (item.eventId) await CiSignalEvent.updateOne({ eventId: item.eventId, status: "new" }, { $set: { status: "seen" } });
      return { item: sanitizeDoc(item) };
    }
    case "accept": {
      // Mencion detectada: aplicar la sugerencia asociada (agrega mentions[] con source auto).
      if (item.kind !== "mention" || !item.suggestionId) {
        throw new CiError(400, "Sólo las menciones detectadas se aceptan", "invalid_action");
      }
      const res = await actOnSuggestion(item.suggestionId, "apply", userId);
      const fresh = await RadarItem.findOne({ radarId });
      return { item: sanitizeDoc(fresh ?? item), competitorId: item.competitorId ?? undefined, suggestion: res.suggestion };
    }
    case "link": {
      if (item.kind !== "new_entrant" || !item.domain) {
        throw new CiError(400, "Sólo los entrantes se vinculan a un competidor", "invalid_action");
      }
      const existing = await competitorsService.findByDomain(item.domain);
      if (!existing) throw new CiError(404, "No hay un competidor Tier 1 con ese dominio", "no_tier1_match");
      item.status = "promoted";
      item.decidedAt = now;
      item.decidedByUserId = userId;
      item.decidedBy = "user";
      item.promotedCompetitorId = existing.competitorId;
      await item.save();
      return { item: sanitizeDoc(item), competitorId: existing.competitorId };
    }
    case "promote": {
      if (item.kind !== "new_entrant") {
        throw new CiError(400, "Sólo los entrantes se promueven", "invalid_action");
      }
      if (!input.segment || !input.promotionReasons?.length) {
        throw new CiError(400, "Elegí segmento y al menos un motivo de promoción", "promotion_reason_required");
      }
      const created = await competitorsService.create(
        {
          name: item.detectedName || item.domain || "Competidor",
          website: item.url || `https://${item.domain}`,
          segment: input.segment,
          priority: "C",
        },
        userId,
        {
          promotion: {
            reasons: input.promotionReasons,
            note: input.promotionNote ?? "",
            fromRadarId: item.radarId,
            at: now,
            byUserId: userId,
          },
          evidence: [
            {
              kind: "radar",
              url: item.url,
              note: item.aiSummary ? `Radar: ${item.aiSummary}` : "Detectado por el radar",
            },
          ],
          source: "radar_promote",
        },
      );
      item.status = "promoted";
      item.decidedAt = now;
      item.decidedByUserId = userId;
      item.decidedBy = "user";
      item.promotedCompetitorId = created.competitorId;
      await item.save();
      return { item: sanitizeDoc(item), competitorId: created.competitorId };
    }
    default:
      throw new CiError(400, "Acción inválida", "invalid_action");
  }
}
