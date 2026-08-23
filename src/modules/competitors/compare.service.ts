import { ImprovementTicket } from "../tickets/tickets.model";
import {
  CiSignal,
  Competitor,
  FEATURE_CATALOG,
  PRODUCT_TYPES,
  sanitizeDoc,
  WEAKNESS_THEMES,
} from "./competitors.model";
import { CiError } from "./competitors.service";
import { ensureV2 } from "./migration";
import { getSettings } from "./settings.service";

/**
 * Comparador lado a lado (v2.1): 2-4 competidores contra bookfer en una sola
 * tabla, más la serie histórica de precio normalizado. Todo se arma de lo ya
 * cargado; no consulta fuentes externas.
 */

const DAY_MS = 86_400_000;

export interface CompareInput {
  ids: string[];
  /** Días de historia de precio a devolver. */
  historyDays?: number;
}

export async function compareCompetitors(input: CompareInput) {
  const ids = Array.from(new Set(input.ids)).slice(0, 4);
  if (ids.length < 2) throw new CiError(400, "Elegí al menos dos competidores para comparar", "compare_needs_two");
  const docs = await Competitor.find({ competitorId: { $in: ids } });
  if (docs.length !== ids.length) throw new CiError(404, "Alguno de los competidores no existe", "not_found");
  for (const d of docs) ensureV2(d);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comps: any[] = ids.map((id) => docs.find((d) => d.competitorId === id)!.toObject());
  const settings = await getSettings();
  const since = new Date(Date.now() - (input.historyDays ?? 365) * DAY_MS);

  const ourFeatures = settings.ourFeatures ?? {};
  const ticketIds = Array.from(new Set(Object.values(ourFeatures).map((v) => v?.ticketId).filter((t): t is string => Boolean(t))));
  const tickets = ticketIds.length ? await ImprovementTicket.find({ ticketId: { $in: ticketIds } }).select("ticketId title status priorityScore").lean() : [];
  const ticketMap = new Map(tickets.map((t) => [String(t.ticketId), { ticketId: t.ticketId, title: t.title, status: t.status, priorityScore: t.priorityScore ?? 0 }]));

  // --- columnas -------------------------------------------------------------
  const columns = comps.map((c) => ({
    competitorId: c.competitorId,
    name: c.name,
    website: c.website,
    segment: c.segment,
    priority: c.priority,
    quality: c.quality?.score ?? null,
    overlapScore: c.overlapScore ?? null,
    isUs: false,
  }));
  const us = {
    competitorId: "__us__",
    name: "bookfer",
    website: "",
    segment: "latam",
    priority: null,
    quality: null,
    overlapScore: 100,
    isUs: true,
  };

  // --- pricing --------------------------------------------------------------
  const pricing = {
    basisRooms: settings.referenceHotel?.rooms ?? 15,
    rows: comps.map((c) => ({
      competitorId: c.competitorId,
      visibility: c.pricing?.visibility ?? "unknown",
      minMonthlyUsd: c.pricing?.normalized?.minMonthlyUsd ?? null,
      maxMonthlyUsd: c.pricing?.normalized?.maxMonthlyUsd ?? null,
      unit: c.pricing?.unit ?? "unknown",
      plans: (c.pricing?.plans ?? []).map((p: { name: string; priceMonthly: number | null; currency: string; unit: string }) => ({ name: p.name, priceMonthly: p.priceMonthly, currency: p.currency, unit: p.unit })),
      fxNote: c.pricing?.normalized?.fxNote ?? "",
    })),
    ours: settings.ourPricing,
  };

  // --- features (fila por feature del catálogo, celda por competidor) --------
  const features = FEATURE_CATALOG.map((f) => {
    const cells = comps.map((c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (c.featureMatrix ?? []).find((x: any) => x.key === f.key);
      const has = m?.has === "yes" ? "native" : m?.has ?? "unknown";
      return { competitorId: c.competitorId, has, evidenceUrl: m?.evidenceUrl ?? "", verified: Boolean(m?.verifiedAt) };
    });
    const ours = ourFeatures[f.key] ?? null;
    const theyHave = cells.filter((x) => x.has === "native" || x.has === "addon").length;
    const weLack = !ours || ours.coverage === "no" || ours.coverage === "roadmap" || ours.coverage === "partial";
    return {
      key: f.key,
      label: f.label,
      cells,
      ours: { coverage: ours?.coverage ?? "unknown", ticket: ours?.ticketId ? ticketMap.get(ours.ticketId) ?? null : null },
      /** Lo tienen todos y nosotros no: es lo primero que hay que mirar. */
      gapForUs: theyHave === comps.length && weLack,
    };
  });

  // --- productos ------------------------------------------------------------
  const productCategories = PRODUCT_TYPES.map((cat) => ({
    category: cat,
    cells: comps.map((c) => ({
      competitorId: c.competitorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      products: (c.products ?? []).filter((p: any) => p.category === cat).map((p: any) => ({ productId: p.productId, name: p.name, status: p.status, isCore: p.isCore, url: p.url })),
    })),
  })).filter((row) => row.cells.some((c) => c.products.length > 0));
  const productTotals = comps.map((c) => ({
    competitorId: c.competitorId,
    total: (c.products ?? []).length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    live: (c.products ?? []).filter((p: any) => p.status === "live").length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    announced: (c.products ?? []).filter((p: any) => p.status === "announced" || p.status === "beta").length,
  }));

  // --- debilidades / ángulo -------------------------------------------------
  const weaknesses = WEAKNESS_THEMES.map((theme) => ({
    theme,
    cells: comps.map((c) => ({
      competitorId: c.competitorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: (c.weaknesses ?? []).filter((w: any) => w.theme === theme).map((w: any) => ({ note: w.note, evidenceUrl: w.evidenceUrl })),
    })),
  })).filter((row) => row.cells.some((c) => c.items.length > 0));
  const angles = comps.map((c) => ({ competitorId: c.competitorId, ourAngle: c.ourAngle ?? "", statedPositioning: c.statedPositioning ?? "" }));

  // --- señales sociales y anuncios ------------------------------------------
  const socialSignals = await CiSignal.find({ competitorId: { $in: ids }, metric: { $in: ["followers", "subscribers"] } }).sort({ observedAt: -1 }).lean();
  const social = comps.map((c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profiles = (c.socialProfiles ?? []).filter((p: any) => p.status === "confirmed");
    const seen = new Set<string>();
    let total = 0;
    let approx = false;
    for (const s of socialSignals) {
      if (String(s.competitorId) !== c.competitorId) continue;
      const key = String(s.profileId ?? s.network);
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof s.value === "number") {
        total += s.value;
        if (s.approx) approx = true;
      }
    }
    return {
      competitorId: c.competitorId,
      profiles: profiles.map((p: { network: string; handle: string; url: string }) => ({ network: p.network, handle: p.handle, url: p.url })),
      followersTotal: seen.size ? total : null,
      approx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activeAds: (c.ads ?? []).filter((a: any) => a.status === "active").length,
    };
  });

  // --- serie de precio normalizado ------------------------------------------
  const priceSignals = await CiSignal.find({ competitorId: { $in: ids }, metric: "priceMonthlyUsd", observedAt: { $gte: since } }).sort({ observedAt: 1 }).lean();
  const priceHistory = comps.map((c) => ({
    competitorId: c.competitorId,
    points: priceSignals
      .filter((s) => String(s.competitorId) === c.competitorId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((s) => ({ at: s.observedAt, min: (s.value as any)?.min ?? null, max: (s.value as any)?.max ?? null, basisRooms: (s.value as any)?.basisRooms ?? null })),
  }));

  return { columns, us, pricing, features, products: { rows: productCategories, totals: productTotals }, weaknesses, angles, social, priceHistory, basisRooms: settings.referenceHotel?.rooms ?? 15 };
}

/** Lista mínima para el selector del comparador. */
export async function compareOptions() {
  const docs = await Competitor.find({ stage: "tracked", status: "active" }).select("competitorId name priority segment quality.score").sort({ priority: 1, name: 1 }).lean();
  return { data: docs.map((d) => sanitizeDoc(d)) };
}
