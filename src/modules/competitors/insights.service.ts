import { ImprovementTicket } from "../tickets/tickets.model";
import {
  CiDecision,
  CiSignal,
  CiSignalEvent,
  CiSuggestion,
  Competitor,
  FEATURE_CATALOG,
  PRODUCT_TYPES,
  WEAKNESS_THEMES,
  sanitizeDoc,
} from "./competitors.model";
import { ensureV2 } from "./migration";
import { getSettings } from "./settings.service";

/**
 * Vista "¿Qué decisión soporta esto?" (spec v1 §8 + v2 §13). Se computa
 * on-demand sobre Tier 1 activo; el volumen (≤ 20 competidores) no justifica
 * rollups. v2 suma calidad, pricing normalizado, social / share of voice,
 * timeline de lanzamientos, tracción y menciones.
 */

const DAY_MS = 86_400_000;
const SOCIAL_NETWORKS_FOR_SOV = ["instagram", "linkedin", "x", "facebook", "tiktok", "youtube"] as const;

export async function computeInsights() {
  const settings = await getSettings();
  const [compDocs, allCount, firstComp] = await Promise.all([
    Competitor.find({ stage: "tracked", status: "active" }),
    Competitor.countDocuments({}),
    Competitor.findOne({}).sort({ createdAt: 1 }).select("createdAt").lean(),
  ]);
  for (const d of compDocs) ensureV2(d);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comps: any[] = compDocs.map((d) => d.toObject());
  const now = Date.now();
  const staleCutoff = now - settings.staleDays * DAY_MS;
  const since90 = new Date(now - 90 * DAY_MS);
  const since30 = new Date(now - 30 * DAY_MS);
  const compIds = comps.map((c) => String(c.competitorId));

  // --- scope -----------------------------------------------------------------
  const scope = {
    activeCompetitors: comps.length,
    totalCompetitors: allCount,
    withPricingData: comps.filter((c) => c.pricing?.normalized?.minMonthlyUsd != null || c.pricing?.normalized?.maxMonthlyUsd != null || c.pricing?.minMonthlyUsd != null || c.pricing?.maxMonthlyUsd != null).length,
    withFeatureMatrix: comps.filter((c) => (c.featureMatrix ?? []).length > 0).length,
    staleCount: comps.filter((c) => !c.lastReviewedAt || new Date(c.lastReviewedAt).getTime() < staleCutoff).length,
    staleDays: settings.staleDays,
  };

  // --- pricing (v1, ahora con normalizado cuando existe) --------------------
  const pricingRows = comps.map((c) => {
    const n = c.pricing?.normalized;
    return {
      competitorId: c.competitorId,
      name: c.name,
      segment: c.segment,
      priority: c.priority,
      unit: c.pricing?.unit ?? "unknown",
      visibility: c.pricing?.visibility ?? "unknown",
      minMonthlyUsd: n?.minMonthlyUsd ?? c.pricing?.minMonthlyUsd ?? null,
      maxMonthlyUsd: n?.maxMonthlyUsd ?? c.pricing?.maxMonthlyUsd ?? null,
      normalized: Boolean(n && (n.minMonthlyUsd != null || n.maxMonthlyUsd != null)),
      plans: (c.pricing?.plans ?? []).length,
      range: c.pricing?.range ?? "",
    };
  });
  const hasData = (r: { minMonthlyUsd: number | null; maxMonthlyUsd: number | null }) => r.minMonthlyUsd != null || r.maxMonthlyUsd != null;
  pricingRows.sort((a, b) => {
    const da = hasData(a) ? 0 : 1;
    const db = hasData(b) ? 0 : 1;
    if (da !== db) return da - db;
    const ka = a.minMonthlyUsd ?? a.maxMonthlyUsd ?? Number.MAX_SAFE_INTEGER;
    const kb = b.minMonthlyUsd ?? b.maxMonthlyUsd ?? Number.MAX_SAFE_INTEGER;
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });
  const unitDistribution: Record<string, number> = {};
  const visibilityDistribution: Record<string, number> = {};
  for (const r of pricingRows) {
    unitDistribution[r.unit] = (unitDistribution[r.unit] ?? 0) + 1;
    visibilityDistribution[r.visibility] = (visibilityDistribution[r.visibility] ?? 0) + 1;
  }

  // --- positioning -----------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const themeMap = new Map<string, any[]>();
  for (const t of WEAKNESS_THEMES) themeMap.set(t, []);
  for (const c of comps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weaknesses: any[] = c.weaknesses ?? [];
    const themes: string[] = weaknesses.length ? Array.from(new Set(weaknesses.map((w) => String(w.theme)))) : c.weaknessThemes ?? [];
    for (const t of themes) {
      if (!themeMap.has(t)) themeMap.set(t, []);
      const withEvidence = weaknesses.filter((w) => w.theme === t && w.evidenceUrl).length;
      themeMap.get(t)!.push({
        competitorId: c.competitorId,
        name: c.name,
        priority: c.priority,
        detectedWeakness: c.detectedWeakness ?? "",
        ourAngle: c.ourAngle ?? "",
        notes: weaknesses.filter((w) => w.theme === t).map((w) => w.note).filter(Boolean),
        evidenceCount: withEvidence,
      });
    }
  }
  const themes = Array.from(themeMap.entries())
    .map(([theme, list]) => ({ theme, count: list.length, withEvidence: list.filter((x) => x.evidenceCount > 0).length, competitors: list }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  const anglesInUse = comps.filter((c) => (c.ourAngle ?? "").trim()).map((c) => ({ competitorId: c.competitorId, name: c.name, priority: c.priority, ourAngle: c.ourAngle }));
  const missing = comps.filter((c) => !(c.detectedWeakness ?? "").trim() && (c.weaknesses ?? []).length === 0 && (c.weaknessThemes ?? []).length === 0).map((c) => ({ competitorId: c.competitorId, name: c.name }));

  // --- roadmap (+ anunciado en 90 d) -----------------------------------------
  const ourFeatures = settings.ourFeatures ?? {};
  const ticketIds = Array.from(new Set(Object.values(ourFeatures).map((v) => v?.ticketId).filter((t): t is string => Boolean(t))));
  const tickets = ticketIds.length ? await ImprovementTicket.find({ ticketId: { $in: ticketIds } }).select("ticketId title status priority priorityScore impact").lean() : [];
  const ticketMap = new Map(
    tickets.map((t) => [
      String(t.ticketId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ticketId: t.ticketId, title: t.title, status: t.status, priority: t.priority, priorityScore: t.priorityScore ?? 0, requestCount: (t.impact as any)?.requestCount ?? 0 },
    ]),
  );
  const announceEvents = compIds.length
    ? await CiSignalEvent.find({ competitorId: { $in: compIds }, observedAt: { $gte: since90 }, featureKeys: { $exists: true, $ne: [] } }).sort({ observedAt: -1 }).lean()
    : [];
  const nameOf = new Map(comps.map((c) => [String(c.competitorId), c.name as string]));
  const announcedByFeature = new Map<string, Array<{ competitorId: string; name: string; observedAt: Date; eventId: string; title: string }>>();
  for (const e of announceEvents) {
    for (const k of e.featureKeys ?? []) {
      const list = announcedByFeature.get(k) ?? [];
      if (!list.some((x) => x.competitorId === String(e.competitorId))) {
        list.push({ competitorId: String(e.competitorId), name: nameOf.get(String(e.competitorId)) ?? "", observedAt: e.observedAt, eventId: e.eventId, title: e.title });
      }
      announcedByFeature.set(k, list);
    }
  }
  const roadmapRows = FEATURE_CATALOG.map((f) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withIt = comps.filter((c) => (c.featureMatrix ?? []).some((m: any) => m.key === f.key && (m.has === "native" || m.has === "yes" || m.has === "addon")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viaIntegration = comps.filter((c) => (c.featureMatrix ?? []).some((m: any) => m.key === f.key && m.has === "integration"));
    const announced = announcedByFeature.get(f.key) ?? [];
    const ours = ourFeatures[f.key] ?? null;
    const coverage = ours?.coverage ?? "unknown";
    const ticket = ours?.ticketId ? ticketMap.get(ours.ticketId) ?? null : null;
    const gap = coverage === "no" || coverage === "partial" || coverage === "roadmap";
    const pressure = withIt.length + (announced.length ? 1 : 0);
    let verdict: "real_gap" | "nice_to_have" | "covered" | "unknown" = "unknown";
    if (coverage === "yes") verdict = "covered";
    else if (gap && pressure >= 2 && (ticket?.requestCount ?? 0) >= 1) verdict = "real_gap";
    else if (gap && (withIt.length >= 1 || announced.length >= 1)) verdict = "nice_to_have";
    return {
      key: f.key,
      label: f.label,
      competitorsWithIt: { count: withIt.length, names: withIt.map((c) => c.name), viaIntegration: viaIntegration.map((c) => c.name) },
      announced90d: announced,
      ours: { coverage, ticketId: ours?.ticketId ?? null, note: ours?.note ?? "", ticket },
      verdict,
    };
  });
  const verdictRank = { real_gap: 0, nice_to_have: 1, unknown: 2, covered: 3 } as const;
  roadmapRows.sort((a, b) => verdictRank[a.verdict] - verdictRank[b.verdict] || b.competitorsWithIt.count - a.competitorsWithIt.count || a.label.localeCompare(b.label));

  // --- decisiones ------------------------------------------------------------
  const since60 = new Date(now - 60 * DAY_MS);
  const [decisionsTotal, decisionsLast60d, latestDecisions] = await Promise.all([
    CiDecision.countDocuments({}),
    CiDecision.countDocuments({ decidedAt: { $gte: since60 } }),
    CiDecision.find({}).sort({ decidedAt: -1 }).limit(5).lean(),
  ]);

  // --- v2: calidad -------------------------------------------------------------
  const qualityRows = comps.map((c) => ({ competitorId: c.competitorId, name: c.name, priority: c.priority, score: c.quality?.score ?? null, missing: c.quality?.missing ?? [] }));
  const scored = qualityRows.filter((r) => typeof r.score === "number");
  const missingCount = new Map<string, number>();
  for (const r of qualityRows) for (const m of r.missing) missingCount.set(m, (missingCount.get(m) ?? 0) + 1);
  const quality = {
    avgScore: scored.length ? Math.round(scored.reduce((a, r) => a + (r.score as number), 0) / scored.length) : null,
    byCompetitor: qualityRows.sort((a, b) => (a.score ?? -1) - (b.score ?? -1)),
    topMissing: Array.from(missingCount.entries()).map(([item, count]) => ({ item, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };

  // --- v2: pricing normalizado ---------------------------------------------------
  const pricingNormalized = {
    basisRooms: settings.referenceHotel?.rooms ?? 15,
    rows: comps
      .map((c) => ({ competitorId: c.competitorId, name: c.name, priority: c.priority, visibility: c.pricing?.visibility ?? "unknown", minMonthlyUsd: c.pricing?.normalized?.minMonthlyUsd ?? null, maxMonthlyUsd: c.pricing?.normalized?.maxMonthlyUsd ?? null, fxNote: c.pricing?.normalized?.fxNote ?? "", plans: (c.pricing?.plans ?? []).length }))
      .sort((a, b) => (a.minMonthlyUsd ?? a.maxMonthlyUsd ?? 9e9) - (b.minMonthlyUsd ?? b.maxMonthlyUsd ?? 9e9)),
    ours: settings.ourPricing,
    visibilityDistribution,
  };

  // --- v2: social + share of voice --------------------------------------------
  const followerSignals = compIds.length
    ? await CiSignal.find({ competitorId: { $in: compIds }, metric: { $in: ["followers", "subscribers", "posts", "postsLast30d", "lastPostAt"] } }).sort({ observedAt: -1 }).lean()
    : [];
  // ultimo valor por (competitorId, profileId, metric) y valor ~30 d atras
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestBy = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monthAgoBy = new Map<string, any>();
  for (const s of followerSignals) {
    const key = `${s.competitorId}|${s.profileId ?? s.network}|${s.metric}`;
    if (!latestBy.has(key)) latestBy.set(key, s);
    else if (!monthAgoBy.has(key) && new Date(s.observedAt).getTime() <= since30.getTime()) monthAgoBy.set(key, s);
  }
  const byNetwork: Array<{ network: string; rows: Array<Record<string, unknown>> }> = [];
  const sovRows: Array<{ network: string; rows: Array<{ competitorId: string; name: string; sharePct: number; approx: boolean }> }> = [];
  const activity = new Map<string, number>();
  for (const network of SOCIAL_NETWORKS_FOR_SOV) {
    const rows: Array<Record<string, unknown>> = [];
    for (const c of comps) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profiles: any[] = (c.socialProfiles ?? []).filter((p: any) => p.network === network && p.status === "confirmed");
      for (const p of profiles) {
        const metric = network === "youtube" ? "subscribers" : "followers";
        const last = latestBy.get(`${c.competitorId}|${p.profileId}|${metric}`);
        const prev = monthAgoBy.get(`${c.competitorId}|${p.profileId}|${metric}`);
        const followers = typeof last?.value === "number" ? last.value : typeof p.latest?.followers === "number" ? p.latest.followers : typeof p.latest?.subscribers === "number" ? p.latest.subscribers : null;
        const delta30dPct = typeof last?.value === "number" && typeof prev?.value === "number" && prev.value > 0 ? Math.round(((last.value - prev.value) / prev.value) * 1000) / 10 : null;
        const posts30 = latestBy.get(`${c.competitorId}|${p.profileId}|postsLast30d`);
        const lastPost = latestBy.get(`${c.competitorId}|${p.profileId}|lastPostAt`);
        rows.push({
          competitorId: c.competitorId,
          name: c.name,
          priority: c.priority,
          handle: p.handle || p.url,
          url: p.url,
          followers,
          approx: Boolean(last?.approx ?? p.latest?.followersApprox),
          delta30dPct,
          postsLast30d: typeof posts30?.value === "number" ? posts30.value : null,
          lastPostAt: lastPost?.value ?? p.latest?.lastPostAt ?? null,
          asOf: last?.observedAt ?? p.latest?.asOf ?? p.lastOkAt ?? null,
        });
        if (typeof posts30?.value === "number") activity.set(c.competitorId, (activity.get(c.competitorId) ?? 0) + posts30.value);
      }
    }
    if (!rows.length) continue;
    byNetwork.push({ network, rows: rows.sort((a, b) => ((b.followers as number) ?? -1) - ((a.followers as number) ?? -1)) });
    const withFollowers = rows.filter((r) => typeof r.followers === "number");
    const total = withFollowers.reduce((a, r) => a + (r.followers as number), 0);
    if (total > 0) {
      sovRows.push({
        network,
        rows: withFollowers.map((r) => ({ competitorId: r.competitorId as string, name: r.name as string, sharePct: Math.round(((r.followers as number) / total) * 1000) / 10, approx: Boolean(r.approx) })).sort((a, b) => b.sharePct - a.sharePct),
      });
    }
  }
  const mostActive30d = Array.from(activity.entries()).map(([competitorId, score]) => ({ competitorId, name: nameOf.get(competitorId) ?? "", score })).sort((a, b) => b.score - a.score).slice(0, 10);

  // --- v2: lanzamientos (timeline 90 d) ------------------------------------------
  const launchEvents = compIds.length
    ? await CiSignalEvent.find({ competitorId: { $in: compIds }, observedAt: { $gte: since90 }, kind: { $in: ["launch", "feature_announce", "app_release", "pricing_change", "funding", "ph_launch", "campaign"] } }).sort({ observedAt: -1 }).limit(200).lean()
    : [];
  const launches = {
    timeline: launchEvents.map((e) => ({ eventId: e.eventId, competitorId: e.competitorId, name: nameOf.get(String(e.competitorId)) ?? "", kind: e.kind, severity: e.severity, title: e.title, summary: e.summary, sourceUrl: e.sourceUrl, observedAt: e.observedAt, featureKeys: e.featureKeys ?? [] })),
    byFeature: FEATURE_CATALOG.map((f) => ({ key: f.key, label: f.label, announcedBy: announcedByFeature.get(f.key) ?? [] })).filter((x) => x.announcedBy.length > 0),
  };

  // --- v2: traccion ----------------------------------------------------------------
  const eventCounts = compIds.length
    ? await CiSignalEvent.aggregate([{ $match: { competitorId: { $in: compIds }, observedAt: { $gte: since90 } } }, { $group: { _id: "$competitorId", n: { $sum: 1 } } }])
    : [];
  const eventsByComp = new Map((eventCounts as Array<{ _id: string; n: number }>).map((r) => [String(r._id), r.n]));
  const latestMetric = (competitorId: string, metric: string) => {
    for (const [key, s] of latestBy.entries()) if (key.startsWith(`${competitorId}|`) && key.endsWith(`|${metric}`)) return s;
    return null;
  };
  const otherSignals = compIds.length
    ? await CiSignal.find({ competitorId: { $in: compIds }, metric: { $in: ["rating", "reviewCount", "openRoles", "searchInterest"] } }).sort({ observedAt: -1 }).lean()
    : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestOther = new Map<string, any>();
  for (const s of otherSignals) {
    const key = `${s.competitorId}|${s.metric}`;
    if (!latestOther.has(key)) latestOther.set(key, s);
  }
  const searchInterestAvg = new Map<string, number[]>();
  for (const s of otherSignals) {
    if (s.metric !== "searchInterest") continue;
    const list = searchInterestAvg.get(String(s.competitorId)) ?? [];
    if (list.length < 7) list.push(Number(s.value) || 0);
    searchInterestAvg.set(String(s.competitorId), list);
  }
  const traction = comps
    .map((c) => {
      let followersTotal = 0;
      let anyFollowers = false;
      for (const [key, s] of latestBy.entries()) {
        if (!key.startsWith(`${c.competitorId}|`)) continue;
        if (!key.endsWith("|followers") && !key.endsWith("|subscribers")) continue;
        if (typeof s.value === "number") {
          followersTotal += s.value;
          anyFollowers = true;
        }
      }
      const si = searchInterestAvg.get(String(c.competitorId));
      return {
        competitorId: c.competitorId,
        name: c.name,
        priority: c.priority,
        prioritySuggested: c.prioritySuggested?.value ?? null,
        overlapScore: c.overlapScore ?? null,
        tractionScore: c.prioritySuggested?.score ?? null,
        mentionsLast90d: (c.mentions ?? []).filter((m: { at?: Date }) => m?.at && new Date(m.at).getTime() >= since90.getTime()).length,
        events90d: eventsByComp.get(String(c.competitorId)) ?? 0,
        signals: {
          followersTotal: anyFollowers ? followersTotal : null,
          rating: latestOther.get(`${c.competitorId}|rating`)?.value ?? null,
          reviewCount: latestOther.get(`${c.competitorId}|reviewCount`)?.value ?? null,
          openRoles: latestOther.get(`${c.competitorId}|openRoles`)?.value ?? null,
          searchInterestAvg: si && si.length ? Math.round((si.reduce((a, b) => a + b, 0) / si.length) * 10) / 10 : null,
          lastFollowerSignalAt: latestMetric(String(c.competitorId), "followers")?.observedAt ?? null,
        },
      };
    })
    .sort((a, b) => (b.tractionScore ?? -1) - (a.tractionScore ?? -1));

  // --- v2: menciones -------------------------------------------------------------
  let mentionsTotal = 0;
  let mentionsAuto = 0;
  const byContext: Record<string, number> = {};
  const mentionsByComp: Array<{ competitorId: string; name: string; count: number }> = [];
  for (const c of comps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = (c.mentions ?? []).filter((m: any) => m?.at && new Date(m.at).getTime() >= since90.getTime());
    if (recent.length) mentionsByComp.push({ competitorId: c.competitorId, name: c.name, count: recent.length });
    for (const m of recent) {
      mentionsTotal++;
      if (m.source === "auto") mentionsAuto++;
      byContext[m.context ?? "other"] = (byContext[m.context ?? "other"] ?? 0) + 1;
    }
  }
  // --- v2.1: catalogo de productos y anuncios observados -----------------------
  const productsByCategory = PRODUCT_TYPES.map((category) => ({
    category,
    competitors: comps
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c) => ({ competitorId: c.competitorId, name: c.name, items: (c.products ?? []).filter((p: any) => p.category === category).map((p: any) => ({ productId: p.productId, name: p.name, status: p.status, isCore: p.isCore, url: p.url })) }))
      .filter((c) => c.items.length > 0),
  })).filter((row) => row.competitors.length > 0);
  const products = {
    byCategory: productsByCategory,
    totals: comps
      .map((c) => ({
        competitorId: c.competitorId,
        name: c.name,
        priority: c.priority,
        total: (c.products ?? []).length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        live: (c.products ?? []).filter((p: any) => p.status === "live").length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        announced: (c.products ?? []).filter((p: any) => p.status === "announced" || p.status === "beta").length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        core: (c.products ?? []).filter((p: any) => p.isCore).map((p: any) => p.name),
      }))
      .sort((a, b) => b.total - a.total),
    withoutProducts: comps.filter((c) => (c.products ?? []).length === 0).map((c) => ({ competitorId: c.competitorId, name: c.name })),
  };
  const ads = {
    byCompetitor: comps
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c) => ({ competitorId: c.competitorId, name: c.name, active: (c.ads ?? []).filter((a: any) => a.status === "active").length, total: (c.ads ?? []).length, latest: (c.ads ?? []).slice(-3).map((a: any) => ({ adId: a.adId, network: a.network, headline: a.headline, landingUrl: a.landingUrl, lastSeenAt: a.lastSeenAt })) }))
      .filter((c) => c.total > 0)
      .sort((a, b) => b.active - a.active),
    // Campañas detectadas por búsqueda web (evento `campaign`), que es lo único
    // automatizable: las bibliotecas de anuncios bloquean el acceso programático.
    campaigns: launchEvents
      .filter((e) => e.kind === "campaign")
      .map((e) => ({ eventId: e.eventId, competitorId: e.competitorId, name: nameOf.get(String(e.competitorId)) ?? "", title: e.title, summary: e.summary, sourceUrl: e.sourceUrl, observedAt: e.observedAt })),
  };

  const pendingSuggestions = await CiSuggestion.countDocuments({ status: "pending" });

  return {
    scope,
    pricing: { ours: settings.ourPricing, rows: pricingRows, unitDistribution, basisRooms: settings.referenceHotel?.rooms ?? 15 },
    positioning: { themes, anglesInUse, missing },
    roadmap: { rows: roadmapRows },
    decisions: {
      total: decisionsTotal,
      last60d: decisionsLast60d,
      latest: latestDecisions.map((d) => sanitizeDoc(d)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      firstCompetitorAt: (firstComp as any)?.createdAt ?? null,
    },
    // v2
    quality,
    pricingNormalized,
    social: { byNetwork, shareOfVoice: sovRows, mostActive30d },
    launches,
    traction,
    products,
    ads,
    mentions: { last90d: mentionsTotal, auto: mentionsAuto, manual: mentionsTotal - mentionsAuto, byContext, byCompetitor: mentionsByComp.sort((a, b) => b.count - a.count) },
    pendingSuggestions,
  };
}
