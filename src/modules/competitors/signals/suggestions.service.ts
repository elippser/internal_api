import { makeId } from "../../../shared/utils/ids";
import {
  CiSuggestion,
  COMPETITOR_PRIORITIES,
  Competitor,
  FEATURE_HAS,
  FEATURE_KEYS,
  MENTION_CONTEXTS,
  RadarItem,
  sanitizeDoc,
  WEAKNESS_THEMES,
  type FeatureHas,
} from "../competitors.model";
import { CiError, decorateCompetitor, loadDoc, mutateAndRecord } from "../competitors.service";
import { makeMeta, setMeta } from "../fieldMeta";
import { getStaleDays } from "../settings.service";

/**
 * Sugerencias (spec v2 §4.4 / §10): propuestas de cambio que señales, el
 * borrador o el detector de menciones dejan pendientes. Aplicar escribe el
 * campo con procedencia `suggestion` y deja revision; nunca se aplica solo.
 */

export async function listSuggestions(q: { competitorId?: string; status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = {};
  if (q.competitorId) filter.competitorId = q.competitorId;
  if (q.status && q.status !== "all") filter.status = q.status;
  const skip = (q.page - 1) * q.limit;
  const [docs, total] = await Promise.all([
    CiSuggestion.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit).lean(),
    CiSuggestion.countDocuments(filter),
  ]);
  const ids = Array.from(new Set(docs.map((d) => String(d.competitorId))));
  const names = new Map((await Competitor.find({ competitorId: { $in: ids } }).select("competitorId name").lean()).map((c) => [String(c.competitorId), c.name]));
  return { data: docs.map((d) => ({ ...sanitizeDoc(d), competitorName: names.get(String(d.competitorId)) ?? null })), total, page: q.page, limit: q.limit };
}

export async function createSuggestion(input: {
  competitorId: string;
  field: string;
  proposedValue: unknown;
  currentValue?: unknown;
  reason: string;
  evidenceUrl?: string;
  quote?: string;
  source: "signal" | "ai_draft" | "mention_detector" | "priority_engine";
  confidence?: "high" | "medium" | "low";
  eventId?: string | null;
}) {
  const res = await CiSuggestion.findOneAndUpdate(
    { competitorId: input.competitorId, field: input.field, status: "pending" },
    {
      $set: {
        proposedValue: input.proposedValue,
        currentValue: input.currentValue ?? null,
        reason: input.reason,
        evidenceUrl: input.evidenceUrl ?? "",
        quote: (input.quote ?? "").slice(0, 300),
        source: input.source,
        confidence: input.confidence ?? "medium",
        eventId: input.eventId ?? null,
      },
      $setOnInsert: { suggestionId: makeId("sug"), competitorId: input.competitorId, field: input.field, status: "pending" },
    },
    { upsert: true, new: true },
  );
  return sanitizeDoc(res);
}

function inEnum<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

export async function actOnSuggestion(suggestionId: string, action: "apply" | "reject", userId: string | null, valueOverride?: unknown) {
  const sug = await CiSuggestion.findOne({ suggestionId });
  if (!sug) throw new CiError(404, "Sugerencia no encontrada", "not_found");
  if (sug.status !== "pending") throw new CiError(409, "La sugerencia ya fue resuelta", "suggestion_resolved");

  if (action === "reject") {
    sug.status = "rejected";
    sug.decidedAt = new Date();
    sug.decidedByUserId = userId;
    await sug.save();
    await RadarItem.updateMany({ suggestionId, status: "pending" }, { $set: { status: "discarded", decidedAt: new Date(), decidedBy: "user", decidedByUserId: userId } });
    return { suggestion: sanitizeDoc(sug), competitor: null };
  }

  const doc = await loadDoc(sug.competitorId);
  const value = valueOverride !== undefined ? valueOverride : sug.proposedValue;
  const field = sug.field;
  const meta = (path: string) =>
    setMeta(doc, path, makeMeta("suggestion", { confidence: sug.confidence as "high" | "medium" | "low", sourceUrl: sug.evidenceUrl ?? "", quote: sug.quote ?? "", verified: true, userId }));

  await mutateAndRecord(
    doc,
    () => {
      const fm = /^featureMatrix\.(.+)$/.exec(field);
      if (fm) {
        const key = fm[1];
        if (!FEATURE_KEYS.includes(key)) throw new CiError(400, "Feature desconocida", "invalid_field");
        const has = inEnum(value === "yes" ? "native" : value, FEATURE_HAS) as FeatureHas | null;
        if (!has) throw new CiError(400, "Valor inválido para la matriz", "invalid_value");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: any[] = (doc.featureMatrix as any[]).map((x) => (typeof x.toObject === "function" ? x.toObject() : { ...x }));
        const prev = items.find((x) => x.key === key);
        const now = new Date();
        if (prev) {
          prev.has = has;
          prev.evidenceUrl = sug.evidenceUrl || prev.evidenceUrl;
          prev.verifiedAt = now;
          prev.source = "suggestion";
        } else {
          items.push({ key, has, note: "", evidenceUrl: sug.evidenceUrl ?? "", verifiedAt: now, source: "suggestion" });
        }
        doc.set("featureMatrix", items);
        meta(`featureMatrix.${key}`);
        return;
      }
      if (field === "mentions") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (value ?? {}) as any;
        doc.mentions.push({
          mentionId: makeId("men"),
          at: v.at ? new Date(v.at) : new Date(),
          note: String(v.note ?? sug.reason ?? "").slice(0, 2_000),
          context: inEnum(v.context, MENTION_CONTEXTS) ?? "other",
          source: "auto",
          confidence: sug.confidence ?? "medium",
          sourceRef: v.sourceRef ?? null,
          accountId: v.accountId ?? null,
          conversationId: v.conversationId ?? null,
          addedByUserId: userId,
        });
        return;
      }
      if (field === "priority") {
        const p = inEnum(value, COMPETITOR_PRIORITIES);
        if (!p) throw new CiError(400, "Prioridad inválida", "invalid_value");
        doc.priority = p;
        meta("priority");
        return;
      }
      if (field === "weaknesses") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (value ?? {}) as any;
        const theme = inEnum(v.theme, WEAKNESS_THEMES) ?? "other";
        const weaknessId = makeId("weak");
        doc.weaknesses.push({ weaknessId, theme, note: String(v.note ?? sug.reason ?? "").slice(0, 2_000), evidenceUrl: v.evidenceUrl ?? sug.evidenceUrl ?? "", source: "suggestion", addedAt: new Date(), addedByUserId: userId });
        meta(`weaknesses.${weaknessId}`);
        return;
      }
      if (field === "socialProfiles") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (value ?? {}) as any;
        if (!v.network) throw new CiError(400, "Perfil inválido", "invalid_value");
        const profileId = makeId("sp");
        doc.socialProfiles.push({ profileId, network: v.network, handle: v.handle ?? "", url: v.url ?? "", externalId: v.externalId ?? "", discoveredBy: "signal", status: "confirmed", lastCheckedAt: null, lastOkAt: null, latest: v.latest ?? {} });
        meta(`socialProfiles.${profileId}`);
        return;
      }
      throw new CiError(400, `Campo no aplicable automáticamente: ${field}`, "unsupported_field");
    },
    { source: "suggestion", userId },
  );

  sug.status = "applied";
  sug.decidedAt = new Date();
  sug.decidedByUserId = userId;
  await sug.save();
  await RadarItem.updateMany({ suggestionId, status: "pending" }, { $set: { status: "acknowledged", decidedAt: new Date(), decidedBy: "user", decidedByUserId: userId } });
  const staleDays = await getStaleDays();
  return { suggestion: sanitizeDoc(sug), competitor: decorateCompetitor(doc, staleDays) };
}
