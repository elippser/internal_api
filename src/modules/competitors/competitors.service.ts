import { makeId } from "../../shared/utils/ids";
import { adLibraryLinks } from "./adLibraries";
import { normalizeUrl } from "../../shared/web/fetchPage";
import { domainOf } from "../crm/crm.model";
import {
  CiSuggestion,
  Competitor,
  CompetitorRevision,
  PageSnapshot,
  PRUNE_THRESHOLD,
  RadarItem,
  RadarRun,
  sanitizeDoc,
  sanitizeSnapshot,
  type CompetitorPriority,
  type CompetitorPromotion,
  type CompetitorSegment,
  type CompetitorStage,
  type EvidenceKind,
  type FieldSource,
  type MentionContext,
  type RevisionChange,
  type RevisionSource,
  type WeaknessTheme,
  type AdNetwork,
  type ProductStatus,
  type ProductType,
  CiContent,
  CiSignal,
} from "./competitors.model";
import { getMeta, makeMeta, markVerified, removeMeta, setMeta } from "./fieldMeta";
import { ensureV2 } from "./migration";
import { recomputeDerived, type TractionInput } from "./quality.service";
import { getSettings, getStaleDays, type CiSettingsRecord } from "./settings.service";

/** Error tipado del modulo: el controller lo traduce a status + code (+ extra). */
export class CiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Decoracion (isStale, mentionsLast90d, hasDraftReady, pendingSuggestions)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decorateCompetitor(doc: any, staleDays: number, extras: { pendingSuggestions?: number } = {}) {
  const obj = sanitizeDoc(doc);
  if (!obj) return obj;
  const now = Date.now();
  const since90 = now - 90 * DAY_MS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mentions: any[] = Array.isArray(obj.mentions) ? obj.mentions : [];
  const mentionsLast90d = mentions.filter((m) => m?.at && new Date(m.at).getTime() >= since90).length;
  const reviewed = obj.lastReviewedAt ? new Date(obj.lastReviewedAt).getTime() : 0;
  return {
    ...obj,
    isStale: reviewed < now - staleDays * DAY_MS,
    mentionsLast90d,
    hasDraftReady: obj.aiDraft?.status === "ready",
    pendingSuggestions: extras.pendingSuggestions ?? 0,
    // Un click a cada biblioteca pública, ya filtrada (no hay rastreo automático: ver adLibraries.ts).
    adLibraryLinks: adLibraryLinks({ name: obj.name, websiteDomain: obj.websiteDomain, geoFocus: obj.geoFocus }),
  };
}

// ---------------------------------------------------------------------------
// Revisiones (diff simple sobre campos trackeados)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trackedSnapshot(doc: any): Record<string, unknown> {
  const p = doc.pricing ?? {};
  return {
    name: doc.name ?? "",
    website: doc.website ?? "",
    aliases: [...(doc.aliases ?? [])],
    extraDomains: [...(doc.extraDomains ?? [])],
    segment: doc.segment ?? null,
    priority: doc.priority ?? null,
    status: doc.status ?? null,
    productTypes: [...(doc.productTypes ?? [])],
    targetSizes: [...(doc.targetSizes ?? [])],
    geoFocus: [...(doc.geoFocus ?? [])],
    "pricing.model": p.model ?? "",
    "pricing.range": p.range ?? "",
    "pricing.unit": p.unit ?? "unknown",
    "pricing.minMonthlyUsd": p.minMonthlyUsd ?? null,
    "pricing.maxMonthlyUsd": p.maxMonthlyUsd ?? null,
    "pricing.currency": p.currency ?? "",
    "pricing.pricingUrl": p.pricingUrl ?? "",
    "pricing.screenshotUrl": p.screenshotUrl ?? "",
    "pricing.visibility": p.visibility ?? "unknown",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "pricing.plans": (p.plans ?? []).map((x: any) => `${x.name}: ${x.priceMonthly ?? "—"} ${x.currency ?? ""} ${x.unit ?? ""}`),
    keyFeatures: [...(doc.keyFeatures ?? [])],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    featureMatrix: (doc.featureMatrix ?? []).map((f: any) => ({ key: f.key, has: f.has })),
    statedPositioning: doc.statedPositioning ?? "",
    detectedWeakness: doc.detectedWeakness ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    weaknesses: (doc.weaknesses ?? []).map((w: any) => `${w.theme}: ${w.note ?? ""}`),
    ourAngle: doc.ourAngle ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evidence: (doc.evidence ?? []).map((e: any) => `${e.kind}${e.url ? ` ${e.url}` : ""}`),
    mentions: (doc.mentions ?? []).length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socialProfiles: (doc.socialProfiles ?? []).map((s: any) => `${s.network}:${s.handle || s.url} (${s.status})`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    watchedPages: (doc.watchedPages ?? []).map((w: any) => `${w.kind}: ${w.url} (${w.status})`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    products: (doc.products ?? []).map((p: any) => `${p.name} (${p.category}/${p.status})`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ads: (doc.ads ?? []).map((a: any) => `${a.network}: ${a.headline || a.landingUrl} (${a.status})`),
    notes: doc.notes ?? "",
  };
}

/** Foto comparable del precio normalizado (para la serie histórica). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizedPair(doc: any): { min: number | null; max: number | null; basisRooms: number } | null {
  const n = doc.pricing?.normalized;
  if (!n || (n.minMonthlyUsd == null && n.maxMonthlyUsd == null)) return null;
  return { min: n.minMonthlyUsd ?? null, max: n.maxMonthlyUsd ?? null, basisRooms: n.basisRooms ?? 15 };
}

function truncValue(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "string") return v.length > 2_000 ? `${v.slice(0, 2_000)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 2_000 ? `${s.slice(0, 2_000)}…` : v;
}

export function diffTracked(before: Record<string, unknown>, after: Record<string, unknown>): RevisionChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: RevisionChange[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      out.push({ field: k, before: truncValue(before[k]), after: truncValue(after[k]) });
    }
  }
  return out;
}

export async function recordRevision(
  competitorId: string,
  source: RevisionSource,
  byUserId: string | null,
  changes: RevisionChange[],
) {
  return CompetitorRevision.create({
    revisionId: makeId("crev"),
    competitorId,
    at: new Date(),
    byUserId,
    source,
    changes,
  });
}

/**
 * Aplica una mutacion sobre el documento, calcula el diff de los campos
 * trackeados, recalcula derivados (normalizado, overlap, prioridad sugerida,
 * quality), guarda y deja la revision. Toca lastReviewedAt por defecto (editar
 * es revisar).
 */
export async function mutateAndRecord(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  mutate: () => void | Promise<void>,
  opts: { source: RevisionSource; userId: string | null; touchReview?: boolean; settings?: CiSettingsRecord; traction?: Partial<TractionInput> },
): Promise<RevisionChange[]> {
  const migrated = ensureV2(doc);
  const before = trackedSnapshot(doc);
  await mutate();
  const after = trackedSnapshot(doc);
  const changes = diffTracked(before, after);
  if (opts.touchReview !== false) doc.lastReviewedAt = new Date();
  doc.updatedByUserId = opts.userId;
  const settings = opts.settings ?? (await getSettings());
  const normBefore = normalizedPair(doc);
  recomputeDerived(doc, settings, opts.traction);
  const normAfter = normalizedPair(doc);
  await doc.save();
  // Serie de precios: cada cambio del normalizado queda como punto (v2.1).
  if (normAfter && JSON.stringify(normBefore) !== JSON.stringify(normAfter)) {
    await CiSignal.create({
      signalId: makeId("sig"),
      competitorId: doc.competitorId,
      connector: "manual",
      metric: "priceMonthlyUsd",
      value: normAfter,
      unit: `usd_month:${normAfter.basisRooms}`,
      approx: false,
      sourceUrl: doc.pricing?.pricingUrl ?? "",
      observedAt: new Date(),
    }).catch((err) => console.warn("[competitors] serie de precios:", (err as Error)?.message));
  }
  if (changes.length > 0) await recordRevision(doc.competitorId, opts.source, opts.userId, changes);
  else if (migrated) await recordRevision(doc.competitorId, "migration", null, []);
  return changes;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ListInput {
  segment?: CompetitorSegment;
  priority?: CompetitorPriority;
  status?: string;
  /** Etapa del embudo: detected | tracked | discarded | all (default tracked). */
  stage?: string;
  stale?: boolean | string;
  search?: string;
  qualityMax?: number;
  withSuggestions?: boolean | string;
  page: number;
  limit: number;
}

export interface CreateInput {
  name: string;
  website: string;
  segment: CompetitorSegment;
  priority?: CompetitorPriority;
  notes?: string | null;
  aliases?: string[];
}

export interface CreateExtras {
  promotion?: CompetitorPromotion;
  evidence?: { kind: EvidenceKind; url: string; note: string }[];
  source?: RevisionSource;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveWebsite(website: string): { website: string; domain: string } {
  const normalized = normalizeUrl(website);
  const domain = domainOf(website);
  if (!normalized || !domain) {
    throw new CiError(400, "La URL del sitio no es válida", "invalid_domain");
  }
  return { website: normalized, domain };
}

const truthy = (v: unknown) => v === true || v === "1" || v === "true";

/** Carga el doc y aplica la migracion v2 en memoria (se persiste al guardar). */
export async function loadDoc(competitorId: string) {
  const doc = await Competitor.findOne({ competitorId });
  if (!doc) throw new CiError(404, "Competidor no encontrado", "not_found");
  ensureV2(doc);
  return doc;
}

async function pendingSuggestionCounts(competitorIds: string[]): Promise<Map<string, number>> {
  if (!competitorIds.length) return new Map();
  const agg = await CiSuggestion.aggregate([
    { $match: { competitorId: { $in: competitorIds }, status: "pending" } },
    { $group: { _id: "$competitorId", n: { $sum: 1 } } },
  ]);
  return new Map((agg as Array<{ _id: string; n: number }>).map((r) => [r._id, r.n]));
}

async function decorateOne(doc: unknown) {
  const staleDays = await getStaleDays();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (doc as any).competitorId as string;
  const counts = await pendingSuggestionCounts([id]);
  return decorateCompetitor(doc, staleDays, { pendingSuggestions: counts.get(id) ?? 0 });
}

/** Dominio alterno o alias ya usado por OTRO competidor → 409. */
async function assertIdentityFree(competitorId: string | null, domains: string[], aliases: string[]) {
  const or: Record<string, unknown>[] = [];
  if (domains.length) or.push({ websiteDomain: { $in: domains } }, { extraDomains: { $in: domains } });
  if (aliases.length) or.push({ aliases: { $in: aliases } });
  if (!or.length) return;
  const filter: Record<string, unknown> = { $or: or };
  if (competitorId) filter.competitorId = { $ne: competitorId };
  const clash = await Competitor.findOne(filter).select("competitorId name").lean();
  if (clash) {
    throw new CiError(409, `"${clash.name}" ya usa ese dominio o alias`, "duplicate_domain", {
      competitorId: clash.competitorId,
    });
  }
}

export const competitorsService = {
  async list(opts: ListInput) {
    const staleDays = await getStaleDays();
    const filter: Record<string, unknown> = {};
    // Una sola lista: por defecto se muestran los que se siguen, pero el mismo
    // endpoint devuelve los detectados por el radar y los descartados.
    // "open" (default) = la lista de trabajo: lo que se sigue y lo detectado
    // sin mirar. "all" suma los descartados.
    const stage = opts.stage ?? "open";
    if (stage === "open") filter.stage = { $in: ["tracked", "detected"] };
    else if (stage !== "all") filter.stage = stage;
    if (opts.status && opts.status !== "all") filter.status = opts.status;
    if (opts.segment) filter.segment = opts.segment;
    if (opts.priority) filter.priority = opts.priority;
    if (truthy(opts.stale)) filter.lastReviewedAt = { $lt: new Date(Date.now() - staleDays * DAY_MS) };
    if (typeof opts.qualityMax === "number") filter["quality.score"] = { $lte: opts.qualityMax };
    if (opts.search && opts.search.trim()) {
      const re = new RegExp(escapeRegex(opts.search.trim()), "i");
      filter.$or = [{ name: re }, { websiteDomain: re }, { aliases: re }, { extraDomains: re }];
    }
    if (truthy(opts.withSuggestions)) {
      const ids = await CiSuggestion.distinct("competitorId", { status: "pending" });
      filter.competitorId = { $in: ids };
    }
    const skip = (opts.page - 1) * opts.limit;
    const [docs, total] = await Promise.all([
      Competitor.find(filter)
        // stage:-1 deja "tracked" antes que "detected": primero lo que se sigue.
        .sort(stage === "detected" ? { "detection.lastSeenAt": -1, name: 1 } : { stage: -1, priority: 1, name: 1 })
        .skip(skip)
        .limit(opts.limit),
      Competitor.countDocuments(filter),
    ]);
    for (const d of docs) ensureV2(d);
    const counts = await pendingSuggestionCounts(docs.map((d) => d.competitorId));
    return {
      data: docs.map((d) => decorateCompetitor(d, staleDays, { pendingSuggestions: counts.get(d.competitorId) ?? 0 })),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },

  async summary() {
    const staleDays = await getStaleDays();
    const staleCutoff = new Date(Date.now() - staleDays * DAY_MS);
    const [active, archived, stale, byPriorityAgg, bySegmentAgg, radarPending, radarChangesPending, radarSignalsPending, radarMentionsPending, suggestionsPending, lastRun, qualityAgg] =
      await Promise.all([
        Competitor.countDocuments({ stage: "tracked", status: "active" }),
        Competitor.countDocuments({ stage: "tracked", status: "archived" }),
        Competitor.countDocuments({ stage: "tracked", status: "active", lastReviewedAt: { $lt: staleCutoff } }),
        Competitor.aggregate([{ $match: { stage: "tracked", status: "active" } }, { $group: { _id: "$priority", n: { $sum: 1 } } }]),
        Competitor.aggregate([{ $match: { stage: "tracked", status: "active" } }, { $group: { _id: "$segment", n: { $sum: 1 } } }]),
        RadarItem.countDocuments({ status: "pending", kind: "new_entrant" }),
        RadarItem.countDocuments({ status: "pending", kind: "tracked_change" }),
        RadarItem.countDocuments({ status: "pending", kind: "signal" }),
        RadarItem.countDocuments({ status: "pending", kind: "mention" }),
        CiSuggestion.countDocuments({ status: "pending" }),
        RadarRun.findOne({ status: { $ne: "running" } }).sort({ startedAt: -1 }).lean(),
        Competitor.aggregate([
          { $match: { stage: "tracked", status: "active", "quality.score": { $type: "number" } } },
          { $group: { _id: null, avg: { $avg: "$quality.score" }, low: { $sum: { $cond: [{ $lt: ["$quality.score", 50] }, 1, 0] } } } },
        ]),
      ]);
    const byPriority: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (const r of byPriorityAgg as Array<{ _id: string; n: number }>) byPriority[r._id] = r.n;
    const bySegment: Record<string, number> = { global: 0, latam: 0, generic_lodging: 0 };
    for (const r of bySegmentAgg as Array<{ _id: string; n: number }>) bySegment[r._id] = r.n;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (qualityAgg as any[])[0];
    const [detected, discarded] = await Promise.all([
      Competitor.countDocuments({ stage: "detected" }),
      Competitor.countDocuments({ stage: "discarded" }),
    ]);
    return {
      active,
      detected,
      discarded,
      byPriority,
      bySegment,
      stale,
      archived,
      radarPending,
      radarChangesPending,
      radarSignalsPending,
      radarMentionsPending,
      suggestionsPending,
      qualityAvg: q ? Math.round(q.avg) : null,
      qualityLowCount: q ? q.low : 0,
      overPruneThreshold: active > PRUNE_THRESHOLD,
      pruneThreshold: PRUNE_THRESHOLD,
      staleDays,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastRadarRunAt: (lastRun as any)?.finishedAt ?? (lastRun as any)?.startedAt ?? null,
    };
  },

  async findByDomain(domain: string) {
    return Competitor.findOne({ $or: [{ websiteDomain: domain }, { extraDomains: domain }] });
  },

  /** Todos los dominios conocidos (principal + extra), para dedupe del radar. */
  async allKnownDomains(): Promise<Set<string>> {
    const docs = await Competitor.find({}).select("websiteDomain extraDomains").lean();
    const out = new Set<string>();
    for (const d of docs) {
      if (d.websiteDomain) out.add(String(d.websiteDomain));
      for (const x of d.extraDomains ?? []) out.add(String(x));
    }
    return out;
  },

  async create(input: CreateInput, userId: string | null, extras: CreateExtras = {}) {
    const { website, domain } = resolveWebsite(input.website);
    await assertIdentityFree(null, [domain], []);
    const now = new Date();
    const settings = await getSettings();
    const doc = new Competitor({
      competitorId: makeId("comp"),
      schemaVersion: 2,
      name: input.name.trim(),
      website,
      websiteDomain: domain,
      aliases: dedupeStrings(input.aliases ?? []).map((a) => a.toLowerCase()),
      segment: input.segment,
      priority: input.priority ?? "C",
      notes: input.notes ?? "",
      promotion: extras.promotion ?? null,
      evidence: (extras.evidence ?? []).map((e) => ({
        evidenceId: makeId("ev"),
        kind: e.kind,
        url: e.url ?? "",
        note: e.note ?? "",
        addedAt: now,
        addedByUserId: userId,
      })),
      watchedPages: [
        { pageId: makeId("wp"), kind: "home", url: website, feedUrl: null, cadence: "monthly", status: "active", lastHash: null, lastCheckedAt: null, lastChangedAt: null },
      ],
      meta: {
        name: makeMeta("manual", { verified: true, userId }),
        website: makeMeta("manual", { verified: true, userId }),
        segment: makeMeta(extras.source === "radar_promote" ? "radar" : "manual", { verified: extras.source !== "radar_promote", userId }),
      },
      lastReviewedAt: now,
      createdByUserId: userId,
      updatedByUserId: userId,
    });
    recomputeDerived(doc, settings);
    await doc.save();
    await recordRevision(doc.competitorId, extras.source ?? "manual", userId, [
      { field: "created", before: null, after: { name: doc.name, website: doc.website, segment: doc.segment } },
    ]);
    return decorateOne(doc);
  },

  async getById(competitorId: string) {
    const doc = await Competitor.findOne({ competitorId });
    if (!doc) return null;
    ensureV2(doc);
    const staleDays = await getStaleDays();
    const [revisions, snapshots, suggestions] = await Promise.all([
      CompetitorRevision.find({ competitorId }).sort({ at: -1 }).limit(50),
      PageSnapshot.find({ competitorId }).select("-text"),
      CiSuggestion.find({ competitorId, status: "pending" }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    return {
      competitor: decorateCompetitor(doc, staleDays, { pendingSuggestions: suggestions.length }),
      revisions: revisions.map((r) => sanitizeDoc(r)),
      snapshots: snapshots.map((s) => sanitizeSnapshot(s)),
      suggestions: suggestions.map((s) => sanitizeDoc(s)),
    };
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(competitorId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    let websiteChanged = false;
    const sources: Record<string, string> = patch.fieldSources ?? {};
    const manual = (path: string) =>
      setMeta(doc, path, makeMeta("manual", { sourceUrl: sources[path] ?? "", verified: true, userId }));

    await mutateAndRecord(
      doc,
      async () => {
        if (patch.website !== undefined) {
          const { website, domain } = resolveWebsite(patch.website);
          if (domain !== doc.websiteDomain) {
            await assertIdentityFree(competitorId, [domain], []);
            websiteChanged = true;
          }
          doc.website = website;
          doc.websiteDomain = domain;
          manual("website");
        }
        if (patch.extraDomains !== undefined) {
          const domains = dedupeStrings(patch.extraDomains)
            .map((d) => domainOf(d))
            .filter((d): d is string => Boolean(d) && d !== doc.websiteDomain);
          await assertIdentityFree(competitorId, domains, []);
          doc.set("extraDomains", domains);
          manual("extraDomains");
        }
        if (patch.aliases !== undefined) {
          const aliases = dedupeStrings(patch.aliases).map((a) => a.toLowerCase());
          await assertIdentityFree(competitorId, [], aliases);
          doc.set("aliases", aliases);
          manual("aliases");
        }
        for (const k of ["name", "segment", "priority", "status", "statedPositioning", "detectedWeakness", "ourAngle", "notes"] as const) {
          if (patch[k] !== undefined) {
            doc.set(k, patch[k] ?? "");
            if (k !== "notes" && k !== "status" && k !== "detectedWeakness") manual(k);
          }
        }
        for (const k of ["productTypes", "targetSizes", "geoFocus"] as const) {
          if (patch[k] !== undefined) {
            const list = dedupeStrings(patch[k]);
            doc.set(k, k === "geoFocus" ? list.map((g) => g.toLowerCase()) : list);
            manual(k);
          }
        }
        if (patch.pricing) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const current = (doc.pricing as any)?.toObject?.() ?? doc.pricing ?? {};
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { plans, normalized: _n, ...rest } = patch.pricing;
          const next = { ...current, ...rest };
          if (plans !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            next.plans = (plans as any[]).map((p) => ({
              ...p,
              planId: p.planId && String(p.planId).trim() ? String(p.planId).trim() : makeId("plan"),
              observedAt: p.observedAt ? new Date(p.observedAt) : new Date(),
            }));
            manual("pricing.plans");
          }
          doc.set("pricing", next);
          if (rest.visibility !== undefined) manual("pricing.visibility");
          if (rest.minMonthlyUsd !== undefined || rest.maxMonthlyUsd !== undefined || rest.range !== undefined) manual("pricing.range");
        }
        if (patch.keyFeatures !== undefined) {
          doc.set("keyFeatures", dedupeStrings(patch.keyFeatures));
          manual("keyFeatures");
        }
        if (patch.featureMatrix !== undefined) {
          const now = new Date();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prevByKey = new Map<string, any>((doc.featureMatrix as any[]).map((f) => [f.key, typeof f.toObject === "function" ? f.toObject() : { ...f }]));
          const items = dedupeMatrix(patch.featureMatrix).map((it) => {
            const prev = prevByKey.get(it.key);
            const has = it.has === "yes" ? "native" : it.has;
            const changed = !prev || prev.has !== has || (it.evidenceUrl ?? "") !== (prev.evidenceUrl ?? "");
            const item = {
              key: it.key,
              has,
              note: it.note ?? prev?.note ?? "",
              evidenceUrl: it.evidenceUrl ?? prev?.evidenceUrl ?? "",
              verifiedAt: changed ? now : prev?.verifiedAt ?? now,
              source: changed ? "manual" : prev?.source ?? "manual",
            };
            if (changed) setMeta(doc, `featureMatrix.${it.key}`, makeMeta("manual", { sourceUrl: item.evidenceUrl, verified: true, userId }));
            return item;
          });
          const kept = new Set(items.map((i) => i.key));
          for (const key of prevByKey.keys()) if (!kept.has(key)) removeMeta(doc, `featureMatrix.${key}`);
          doc.set("featureMatrix", items);
        }
        if (patch.weaknessThemes !== undefined && (doc.weaknesses as unknown[]).length === 0) {
          // Compat v1: sin debilidades estructuradas, los temas sueltos se vuelven debilidades sin evidencia.
          doc.set(
            "weaknesses",
            dedupeStrings(patch.weaknessThemes).map((theme) => ({
              weaknessId: makeId("weak"),
              theme,
              note: "",
              evidenceUrl: "",
              source: "manual",
              addedAt: new Date(),
              addedByUserId: userId,
            })),
          );
        }
      },
      { source: "manual", userId },
    );
    if (websiteChanged) await PageSnapshot.deleteMany({ competitorId, pageId: null });
    return decorateOne(doc);
  },

  async review(competitorId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    doc.lastReviewedAt = new Date();
    doc.updatedByUserId = userId;
    recomputeDerived(doc, await getSettings());
    await doc.save();
    await recordRevision(competitorId, "review_only", userId, []);
    return decorateOne(doc);
  },

  async verify(competitorId: string, paths: string[], userId: string | null) {
    const doc = await loadDoc(competitorId);
    const touched = markVerified(doc, paths, userId);
    // featureMatrix.<key> tambien marca el item
    const now = new Date();
    for (const p of touched) {
      const m = /^featureMatrix\.(.+)$/.exec(p);
      if (!m) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (doc.featureMatrix as any[]).map((f) => (f.key === m[1] ? { ...(typeof f.toObject === "function" ? f.toObject() : f), verifiedAt: now } : f));
      doc.set("featureMatrix", items);
    }
    doc.lastReviewedAt = now;
    doc.updatedByUserId = userId;
    recomputeDerived(doc, await getSettings());
    await doc.save();
    await recordRevision(competitorId, "review_only", userId, touched.map((p) => ({ field: `verified:${p}`, before: null, after: now })));
    return decorateOne(doc);
  },

  async recompute(competitorId: string, traction?: Partial<TractionInput>) {
    const doc = await loadDoc(competitorId);
    recomputeDerived(doc, await getSettings(), traction);
    await doc.save();
    return decorateOne(doc);
  },

  // --- menciones ------------------------------------------------------------
  async addMention(
    competitorId: string,
    input: { note?: string; at?: Date | string; context?: MentionContext; accountId?: string | null; conversationId?: string | null; source?: "manual" | "auto"; confidence?: "high" | "medium" | "low"; sourceRef?: { kind: string; id: string; excerpt: string } | null },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        doc.mentions.push({
          mentionId: makeId("men"),
          at: input.at ? new Date(input.at) : new Date(),
          note: input.note ?? "",
          context: input.context ?? "other",
          source: input.source ?? "manual",
          confidence: input.confidence ?? "high",
          sourceRef: input.sourceRef ?? null,
          accountId: input.accountId || null,
          conversationId: input.conversationId || null,
          addedByUserId: userId,
        });
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  async removeMention(competitorId: string, mentionId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("mentions", (doc.mentions as any[]).filter((m) => m.mentionId !== mentionId));
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // --- evidencia ------------------------------------------------------------
  async addEvidence(competitorId: string, input: { kind: EvidenceKind; url?: string | null; note?: string }, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        doc.evidence.push({
          evidenceId: makeId("ev"),
          kind: input.kind,
          url: input.url ?? "",
          note: input.note ?? "",
          addedAt: new Date(),
          addedByUserId: userId,
        });
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  async removeEvidence(competitorId: string, evidenceId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("evidence", (doc.evidence as any[]).filter((e) => e.evidenceId !== evidenceId));
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // --- debilidades (v2) -----------------------------------------------------
  async addWeakness(
    competitorId: string,
    input: { theme: WeaknessTheme; note?: string; evidenceUrl?: string | null; source?: FieldSource },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const weaknessId = makeId("weak");
    await mutateAndRecord(
      doc,
      () => {
        doc.weaknesses.push({
          weaknessId,
          theme: input.theme,
          note: input.note ?? "",
          evidenceUrl: input.evidenceUrl ?? "",
          source: input.source ?? "manual",
          addedAt: new Date(),
          addedByUserId: userId,
        });
        setMeta(doc, `weaknesses.${weaknessId}`, makeMeta(input.source ?? "manual", { sourceUrl: input.evidenceUrl ?? "", verified: (input.source ?? "manual") === "manual", userId }));
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateWeakness(competitorId: string, weaknessId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (doc.weaknesses as any[]).map((w) => {
          if (w.weaknessId !== weaknessId) return w;
          const obj = typeof w.toObject === "function" ? w.toObject() : { ...w };
          return { ...obj, ...patch, source: "manual" };
        });
        if (!items.some((w) => w.weaknessId === weaknessId)) throw new CiError(404, "Debilidad no encontrada", "not_found");
        doc.set("weaknesses", items);
        const ev = items.find((w) => w.weaknessId === weaknessId)?.evidenceUrl ?? "";
        setMeta(doc, `weaknesses.${weaknessId}`, makeMeta("manual", { sourceUrl: ev, verified: true, userId }));
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  async removeWeakness(competitorId: string, weaknessId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("weaknesses", (doc.weaknesses as any[]).filter((w) => w.weaknessId !== weaknessId));
        removeMeta(doc, `weaknesses.${weaknessId}`);
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // --- perfiles sociales (v2) ----------------------------------------------
  async addSocialProfile(
    competitorId: string,
    input: { network: string; handle?: string; url?: string | null; externalId?: string; status?: string; discoveredBy?: "ai_draft" | "signal" | "manual" },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const profileId = makeId("sp");
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dup = (doc.socialProfiles as any[]).find(
          (p) => p.network === input.network && ((input.handle && p.handle === input.handle) || (input.url && p.url === input.url)),
        );
        if (dup) throw new CiError(409, "Ese perfil ya está cargado", "duplicate_profile", { profileId: dup.profileId });
        doc.socialProfiles.push({
          profileId,
          network: input.network,
          handle: (input.handle ?? "").replace(/^@/, ""),
          url: input.url ?? "",
          externalId: input.externalId ?? "",
          discoveredBy: input.discoveredBy ?? "manual",
          status: input.status ?? "confirmed",
          lastCheckedAt: null,
          lastOkAt: null,
          latest: {},
        });
        setMeta(doc, `socialProfiles.${profileId}`, makeMeta(input.discoveredBy === "manual" || !input.discoveredBy ? "manual" : "ai_draft", { sourceUrl: input.url ?? "", verified: (input.status ?? "confirmed") === "confirmed", userId }));
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateSocialProfile(competitorId: string, profileId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (doc.socialProfiles as any[]).map((p) => {
          if (p.profileId !== profileId) return p;
          const obj = typeof p.toObject === "function" ? p.toObject() : { ...p };
          const next = { ...obj, ...patch };
          if (typeof next.handle === "string") next.handle = next.handle.replace(/^@/, "");
          return next;
        });
        if (!items.some((p) => p.profileId === profileId)) throw new CiError(404, "Perfil no encontrado", "not_found");
        doc.set("socialProfiles", items);
        const p = items.find((x) => x.profileId === profileId);
        if (patch.status === "confirmed") markVerified(doc, [`socialProfiles.${profileId}`], userId);
        else if (patch.handle !== undefined || patch.url !== undefined) setMeta(doc, `socialProfiles.${profileId}`, makeMeta("manual", { sourceUrl: p?.url ?? "", verified: p?.status === "confirmed", userId }));
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  async removeSocialProfile(competitorId: string, profileId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("socialProfiles", (doc.socialProfiles as any[]).filter((p) => p.profileId !== profileId));
        removeMeta(doc, `socialProfiles.${profileId}`);
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // --- paginas vigiladas (v2) ------------------------------------------------
  async addWatchedPage(
    competitorId: string,
    input: { kind: string; url: string; feedUrl?: string | null; cadence?: "weekly" | "monthly" },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const pageId = makeId("wp");
    const url = normalizeUrl(input.url);
    if (!url) throw new CiError(400, "URL inválida", "invalid_url");
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((doc.watchedPages as any[]).some((p) => p.url === url)) throw new CiError(409, "Esa página ya se vigila", "duplicate_page");
        doc.watchedPages.push({
          pageId,
          kind: input.kind,
          url,
          feedUrl: input.feedUrl || null,
          cadence: input.cadence ?? "weekly",
          status: "active",
          lastHash: null,
          lastCheckedAt: null,
          lastChangedAt: null,
        });
        if (input.kind === "pricing" && !doc.pricing?.pricingUrl) doc.set("pricing.pricingUrl", url);
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateWatchedPage(competitorId: string, pageId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (doc.watchedPages as any[]).map((p) => {
          if (p.pageId !== pageId) return p;
          const obj = typeof p.toObject === "function" ? p.toObject() : { ...p };
          const next = { ...obj, ...patch };
          if (patch.url) {
            const u = normalizeUrl(patch.url);
            if (!u) throw new CiError(400, "URL inválida", "invalid_url");
            next.url = u;
            next.lastHash = null; // otra URL, otra foto
          }
          return next;
        });
        if (!items.some((p) => p.pageId === pageId)) throw new CiError(404, "Página no encontrada", "not_found");
        doc.set("watchedPages", items);
      },
      { source: "manual", userId, touchReview: false },
    );
    if (patch.url) await PageSnapshot.deleteMany({ competitorId, pageId });
    return decorateOne(doc);
  },

  async removeWatchedPage(competitorId: string, pageId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("watchedPages", (doc.watchedPages as any[]).filter((p) => p.pageId !== pageId));
      },
      { source: "manual", userId, touchReview: false },
    );
    await PageSnapshot.deleteMany({ competitorId, pageId });
    return decorateOne(doc);
  },

  /**
   * Mueve un competidor de etapa (v2.2): seguirlo, descartarlo o devolverlo a
   * "detectado". Es lo que antes hacia el triage del radar, ahora sobre la
   * misma lista.
   */
  async setStage(
    competitorId: string,
    input: { stage: CompetitorStage; segment?: CompetitorSegment; priority?: CompetitorPriority; reasons?: string[]; note?: string; reason?: string },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const from = doc.stage ?? "tracked";
    await mutateAndRecord(
      doc,
      () => {
        doc.set("stage", input.stage);
        if (input.segment) doc.set("segment", input.segment);
        if (input.priority) doc.set("priority", input.priority);
        if (input.stage === "tracked") {
          doc.set("status", "active");
          doc.set("promotion", {
            reasons: (input.reasons ?? []) as never,
            note: input.note ?? "",
            fromRadarId: null,
            at: new Date(),
            byUserId: userId,
          });
        }
        if (input.stage === "discarded") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const det: any = doc.detection ?? {};
          doc.set("detection", { ...det, discardReason: input.reason ?? "", decidedBy: "user", decidedAt: new Date() });
          doc.markModified("detection");
        }
      },
      { source: from === "detected" && input.stage === "tracked" ? "radar_promote" : "manual", userId, touchReview: input.stage === "tracked" },
    );
    return decorateOne(doc);
  },

  // --- productos (v2.1) -----------------------------------------------------
  async addProduct(
    competitorId: string,
    input: { name: string; category?: ProductType; description?: string; url?: string | null; pricingNote?: string; status?: ProductStatus; isCore?: boolean; evidenceUrl?: string | null; source?: FieldSource },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const productId = makeId("prod");
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dup = (doc.products as any[]).find((p) => p.name.trim().toLowerCase() === input.name.trim().toLowerCase());
        if (dup) throw new CiError(409, `Ya cargaste un producto llamado "${dup.name}"`, "duplicate_product", { productId: dup.productId });
        doc.products.push({
          productId,
          name: input.name.trim(),
          category: input.category ?? "other",
          description: input.description ?? "",
          url: input.url ?? "",
          pricingNote: input.pricingNote ?? "",
          status: input.status ?? "live",
          isCore: input.isCore ?? false,
          source: input.source ?? "manual",
          evidenceUrl: input.evidenceUrl ?? "",
          addedAt: new Date(),
          addedByUserId: userId,
        });
        setMeta(doc, `products.${productId}`, makeMeta(input.source ?? "manual", { sourceUrl: input.url ?? input.evidenceUrl ?? "", verified: (input.source ?? "manual") === "manual", userId }));
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateProduct(competitorId: string, productId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (doc.products as any[]).map((p) => {
          if (p.productId !== productId) return p;
          const obj = typeof p.toObject === "function" ? p.toObject() : { ...p };
          return { ...obj, ...patch, source: "manual" };
        });
        if (!items.some((p) => p.productId === productId)) throw new CiError(404, "Producto no encontrado", "not_found");
        doc.set("products", items);
        const p = items.find((x) => x.productId === productId);
        setMeta(doc, `products.${productId}`, makeMeta("manual", { sourceUrl: p?.url ?? "", verified: true, userId }));
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  async removeProduct(competitorId: string, productId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("products", (doc.products as any[]).filter((p) => p.productId !== productId));
        removeMeta(doc, `products.${productId}`);
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  // --- anuncios observados (v2.1) --------------------------------------------
  async addAd(
    competitorId: string,
    input: { network?: AdNetwork; headline?: string; copy?: string; landingUrl?: string | null; screenshotUrl?: string | null; note?: string; status?: "active" | "paused" | "unknown"; firstSeenAt?: Date | string },
    userId: string | null,
  ) {
    const doc = await loadDoc(competitorId);
    const adId = makeId("ad");
    await mutateAndRecord(
      doc,
      () => {
        doc.ads.push({
          adId,
          network: input.network ?? "meta",
          headline: input.headline ?? "",
          copy: input.copy ?? "",
          landingUrl: input.landingUrl ?? "",
          screenshotUrl: input.screenshotUrl ?? "",
          note: input.note ?? "",
          status: input.status ?? "active",
          firstSeenAt: input.firstSeenAt ? new Date(input.firstSeenAt) : new Date(),
          lastSeenAt: new Date(),
          source: "manual",
          addedByUserId: userId,
        });
      },
      { source: "manual", userId },
    );
    return decorateOne(doc);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async updateAd(competitorId: string, adId: string, patch: any, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = (doc.ads as any[]).map((a) => {
          if (a.adId !== adId) return a;
          const obj = typeof a.toObject === "function" ? a.toObject() : { ...a };
          // "Sigue activo": confirmar que lo viste hoy mueve lastSeenAt.
          return { ...obj, ...patch, lastSeenAt: patch.lastSeenAt ? new Date(patch.lastSeenAt) : new Date() };
        });
        if (!items.some((a) => a.adId === adId)) throw new CiError(404, "Anuncio no encontrado", "not_found");
        doc.set("ads", items);
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  async removeAd(competitorId: string, adId: string, userId: string | null) {
    const doc = await loadDoc(competitorId);
    await mutateAndRecord(
      doc,
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc.set("ads", (doc.ads as any[]).filter((a) => a.adId !== adId));
      },
      { source: "manual", userId, touchReview: false },
    );
    return decorateOne(doc);
  },

  /** Feed unificado de lo publicado (v2.1). */
  async content(competitorId: string, opts: { network?: string; kind?: string; limit: number }) {
    const filter: Record<string, unknown> = { competitorId };
    if (opts.network) filter.network = opts.network;
    if (opts.kind) filter.kind = opts.kind;
    const docs = await CiContent.find(filter).sort({ publishedAt: -1 }).limit(opts.limit).lean();
    const byNetwork: Record<string, number> = {};
    for (const d of docs) byNetwork[String(d.network)] = (byNetwork[String(d.network)] ?? 0) + 1;
    return { data: docs.map((d) => sanitizeDoc(d)), byNetwork, total: docs.length };
  },

  async remove(competitorId: string) {
    const doc = await Competitor.findOne({ competitorId });
    if (!doc) throw new CiError(404, "Competidor no encontrado", "not_found");
    await Promise.all([
      Competitor.deleteOne({ competitorId }),
      CompetitorRevision.deleteMany({ competitorId }),
      PageSnapshot.deleteMany({ competitorId }),
      CiSuggestion.deleteMany({ competitorId }),
      CiContent.deleteMany({ competitorId }),
    ]);
    return { ok: true };
  },
};

export function dedupeStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dedupeMatrix(list: unknown): any[] {
  if (!Array.isArray(list)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byKey = new Map<string, any>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it = item as any;
    if (!it.key) continue;
    byKey.set(String(it.key), {
      key: String(it.key),
      has: it.has ?? "unknown",
      note: it.note ?? "",
      evidenceUrl: it.evidenceUrl ?? "",
    });
  }
  return Array.from(byKey.values());
}

/** Compat: el getMeta se re-exporta para insights/aiDraft. */
export { getMeta };
