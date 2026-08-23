import { fxRateNote, toUsd } from "./ciFx";
import type {
  CompetitorPriority,
  CompetitorQuality,
  PricingNormalized,
  PrioritySuggested,
} from "./competitors.model";
import { getMeta, KEY_FIELD_PATHS } from "./fieldMeta";
import type { CiSettingsRecord } from "./settings.service";

/**
 * Derivados v2 (spec v2 §8): precio normalizado al hotel de referencia,
 * overlap con el ICP, prioridad sugerida, quality score y temas derivados.
 * Todo puro (sin DB); `recomputeDerived` lo aplica sobre el doc.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Pricing normalizado
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizePricing(pricing: any, ref: { rooms: number; currency: string }): PricingNormalized | null {
  const rooms = Math.max(1, Number(ref?.rooms) || 15);
  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plans: any[] = Array.isArray(pricing?.plans) ? pricing.plans : [];
  const notes: string[] = [];

  if (plans.length === 0) {
    if (pricing?.visibility === "quote_only") return null;
    const min = pricing?.minMonthlyUsd ?? null;
    const max = pricing?.maxMonthlyUsd ?? null;
    if (min == null && max == null) return null;
    const unit = pricing?.unit ?? "unknown";
    const factor = unit === "per_room" ? rooms : 1;
    notes.push(unit === "per_room" ? `valores v1 por habitación × ${rooms}` : "valores v1 sin planes (se toman como mensuales)");
    return {
      minMonthlyUsd: min == null ? null : Math.round(min * factor * 100) / 100,
      maxMonthlyUsd: max == null ? null : Math.round(max * factor * 100) / 100,
      basisRooms: rooms,
      fxNote: notes.join(" · "),
      computedAt: now,
    };
  }

  const inRange = plans.filter((p) => {
    const min = p.minRooms ?? null;
    const max = p.maxRooms ?? null;
    if (min != null && rooms < min) return false;
    if (max != null && rooms > max) return false;
    return true;
  });
  const candidates = inRange.length ? inRange : plans;
  if (!inRange.length) notes.push(`ningún plan cubre ${rooms} hab.: se usan todos`);

  const values: number[] = [];
  for (const p of candidates) {
    const price = p.priceMonthly ?? p.priceAnnualMonthly ?? null;
    if (price == null) continue;
    const usd = toUsd(price, p.currency);
    if (usd == null) {
      notes.push(`${p.name || "plan"}: ${fxRateNote(p.currency)}`);
      continue;
    }
    const fx = fxRateNote(p.currency);
    if (fx && !notes.includes(fx)) notes.push(fx);
    switch (p.unit) {
      case "per_room": {
        const included = p.includesRooms ?? 0;
        values.push(usd * Math.max(rooms - included, 0) + (included ? usd * 0 : 0));
        if (included) notes.push(`${p.name || "plan"}: incluye ${included} hab.`);
        break;
      }
      case "per_property":
      case "flat":
        values.push(usd);
        break;
      case "freemium":
        values.push(0);
        break;
      case "commission":
        notes.push(`${p.name || "plan"}: comisión sobre reservas, no comparable a un fijo`);
        break;
      default:
        notes.push(`${p.name || "plan"}: unidad desconocida, no se normaliza`);
    }
  }
  if (!values.length) {
    return { minMonthlyUsd: null, maxMonthlyUsd: null, basisRooms: rooms, fxNote: notes.join(" · ") || "sin planes normalizables", computedAt: now };
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    minMonthlyUsd: round(Math.min(...values)),
    maxMonthlyUsd: round(Math.max(...values)),
    basisRooms: rooms,
    fxNote: notes.join(" · "),
    computedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Overlap con el ICP y prioridad sugerida
// ---------------------------------------------------------------------------

function share(a: string[] | undefined, b: string[] | undefined): number {
  const A = new Set((a ?? []).map(String));
  const B = (b ?? []).map(String);
  if (!B.length) return 0;
  let hit = 0;
  for (const x of B) if (A.has(x)) hit++;
  return hit / B.length;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeOverlap(comp: any, icp: { productTypes: string[]; targetSizes: string[]; geoFocus: string[] }): number | null {
  const hasTax = (comp.productTypes?.length ?? 0) + (comp.targetSizes?.length ?? 0) + (comp.geoFocus?.length ?? 0) > 0;
  if (!hasTax) return null;
  const product = share(comp.productTypes, icp.productTypes);
  const size = share(comp.targetSizes, icp.targetSizes);
  const geo = new Set((comp.geoFocus ?? []).map((g: string) => String(g).toLowerCase()));
  const icpGeo = (icp.geoFocus ?? []).map((g) => String(g).toLowerCase());
  let geoMatch = 0;
  if (icpGeo.some((g) => geo.has(g))) geoMatch = 1;
  else if (geo.has("global")) geoMatch = 0.5;
  else if (icpGeo.includes("latam") && ["ar", "mx", "co", "br", "cl", "pe", "uy", "py", "bo", "ec", "do", "cr", "gt", "pa", "hn", "sv", "ni", "ve"].some((c) => geo.has(c))) geoMatch = 1;
  return Math.round(45 * product + 35 * size + 20 * geoMatch);
}

export interface TractionInput {
  mentions90d: number;
  events90d: number;
  reviewCount: number | null;
  phLaunch: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mentionsLast90d(comp: any): number {
  const since = Date.now() - 90 * DAY_MS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (comp.mentions ?? []).filter((m: any) => m?.at && new Date(m.at).getTime() >= since).length;
}

export function computeTraction(input: TractionInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const mentions = Math.min(input.mentions90d * 25, 50);
  if (input.mentions90d) reasons.push(`${input.mentions90d} mención(es) en 90 d`);
  const events = Math.min(input.events90d * 10, 30);
  if (input.events90d) reasons.push(`${input.events90d} señal(es) de tracción en 90 d`);
  let extra = 0;
  if ((input.reviewCount ?? 0) >= 50) {
    extra = 20;
    reasons.push(`${input.reviewCount} reviews`);
  } else if (input.phLaunch) {
    extra = 20;
    reasons.push("lanzamiento en Product Hunt");
  }
  return { score: Math.min(100, mentions + events + extra), reasons };
}

export function computePrioritySuggested(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  comp: any,
  overlap: number | null,
  traction: { score: number; reasons: string[] },
  mentions90d: number,
): PrioritySuggested {
  const reasons: string[] = [...traction.reasons];
  let value: CompetitorPriority = "C";
  if (mentions90d >= 2) {
    value = "A";
  } else if (overlap != null && overlap >= 70 && traction.score >= 40) {
    value = "A";
    reasons.push(`overlap ${overlap}: mismo producto/tamaño/geo`);
  } else if (overlap != null && overlap >= 40) {
    value = "B";
    reasons.push(`overlap ${overlap}`);
  } else if (overlap == null) {
    reasons.push("sin taxonomía cargada: no se puede medir el solapamiento");
  } else {
    reasons.push(`overlap ${overlap}: poco solapamiento con el ICP`);
  }
  if (!traction.reasons.length) reasons.push("sin tracción externa registrada");
  const score = Math.round((overlap ?? 0) * 0.6 + traction.score * 0.4);
  return { value, score, reasons, computedAt: new Date() };
}

// ---------------------------------------------------------------------------
// Quality score
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeQuality(comp: any, staleDays: number): CompetitorQuality {
  const meta = getMeta(comp);
  const missing: string[] = [];
  const pricing = comp.pricing ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matrix: any[] = comp.featureMatrix ?? [];
  const matrixKnown = matrix.filter((m) => m.has && m.has !== "unknown");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const weaknesses: any[] = comp.weaknesses ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profiles: any[] = (comp.socialProfiles ?? []).filter((p: any) => p.status === "confirmed");

  const loaded: Record<string, boolean> = {
    website: Boolean(comp.website),
    segment: Boolean(comp.segment),
    productTypes: (comp.productTypes?.length ?? 0) > 0,
    targetSizes: (comp.targetSizes?.length ?? 0) > 0,
    geoFocus: (comp.geoFocus?.length ?? 0) > 0,
    "pricing.visibility": Boolean(pricing.visibility && pricing.visibility !== "unknown"),
    "pricing.plans":
      pricing.visibility === "quote_only" ||
      (Array.isArray(pricing.plans) && pricing.plans.length > 0) ||
      pricing.minMonthlyUsd != null ||
      pricing.maxMonthlyUsd != null,
    featureMatrix: matrixKnown.length >= 5,
    statedPositioning: Boolean((comp.statedPositioning ?? "").trim()),
    weaknesses: weaknesses.length > 0,
    ourAngle: Boolean((comp.ourAngle ?? "").trim()),
    socialProfiles: profiles.length > 0,
  };
  const labels: Record<string, string> = {
    productTypes: "qué vende (productTypes)",
    targetSizes: "tamaño objetivo",
    geoFocus: "foco geográfico",
    "pricing.visibility": "visibilidad de precio",
    "pricing.plans": "planes o precio (o marcar 'a cotizar')",
    featureMatrix: "matriz de features (≥ 5 features definidas)",
    statedPositioning: "posicionamiento declarado",
    weaknesses: "al menos una debilidad",
    ourAngle: "nuestro ángulo",
    socialProfiles: "un perfil social confirmado",
    website: "sitio",
    segment: "segmento",
  };
  const keys = KEY_FIELD_PATHS as readonly string[];
  const loadedCount = keys.filter((k) => loaded[k]).length;
  for (const k of keys) if (!loaded[k]) missing.push(`falta ${labels[k] ?? k}`);
  const completeness = loadedCount / keys.length;

  // verificados: meta[path].verifiedAt (featureMatrix cuenta si ≥ 1 item verificado; weaknesses / socialProfiles idem por id)
  const verifiedPaths = keys.filter((k) => {
    if (!loaded[k]) return false;
    if (k === "featureMatrix") return matrixKnown.some((m) => m.verifiedAt || meta[`featureMatrix.${m.key}`]?.verifiedAt);
    if (k === "weaknesses") return weaknesses.some((w) => meta[`weaknesses.${w.weaknessId}`]?.verifiedAt || w.source === "manual");
    if (k === "socialProfiles") return profiles.length > 0; // confirmar = verificar
    return Boolean(meta[k]?.verifiedAt);
  }).length;
  const verified = loadedCount ? verifiedPaths / loadedCount : 0;
  const unverified = loadedCount - verifiedPaths;
  if (unverified > 0) missing.push(`${unverified} campo(s) cargado(s) sin verificar`);

  const reviewed = comp.lastReviewedAt ? new Date(comp.lastReviewedAt).getTime() : 0;
  const ageDays = (Date.now() - reviewed) / DAY_MS;
  const freshness = ageDays <= staleDays ? 1 : Math.max(0, 1 - (ageDays - staleDays) / staleDays);
  if (freshness < 1) missing.push(`sin revisar hace ${Math.round(ageDays)} días`);

  const wEv = weaknesses.length ? weaknesses.filter((w) => w.evidenceUrl).length / weaknesses.length : 0;
  const fEv = matrixKnown.length ? matrixKnown.filter((m) => m.evidenceUrl).length / matrixKnown.length : 0;
  const evidence = weaknesses.length || matrixKnown.length ? wEv * 0.5 + fEv * 0.5 : 0;
  const wNoEv = weaknesses.filter((w) => !w.evidenceUrl).length;
  if (wNoEv) missing.push(`${wNoEv} debilidad(es) sin evidencia`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = (comp.socialProfiles ?? []).filter((p: any) => p.status === "candidate").length;
  if (candidates) missing.push(`${candidates} perfil(es) social(es) sin confirmar`);

  const score = Math.round(completeness * 40 + verified * 30 + freshness * 15 + evidence * 15);
  return {
    score,
    completeness: Math.round(completeness * 100),
    verified: Math.round(verified * 100),
    freshness: Math.round(freshness * 100),
    evidence: Math.round(evidence * 100),
    missing,
    computedAt: new Date(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function derivedWeaknessThemes(comp: any): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const weaknesses: any[] = comp.weaknesses ?? [];
  if (!weaknesses.length) return Array.isArray(comp.weaknessThemes) ? comp.weaknessThemes : [];
  return Array.from(new Set(weaknesses.map((w) => String(w.theme))));
}

// ---------------------------------------------------------------------------
// Aplicar sobre el doc
// ---------------------------------------------------------------------------

/** Recalcula pricing.normalized, overlapScore, prioritySuggested, quality y weaknessThemes. */
export function recomputeDerived(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  settings: CiSettingsRecord,
  extra: Partial<TractionInput> = {},
): void {
  const ref = settings.referenceHotel ?? { rooms: 15, currency: "USD" };
  const normalized = normalizePricing(doc.pricing, ref);
  doc.set("pricing.normalized", normalized);

  const overlap = computeOverlap(doc, settings.icp);
  doc.set("overlapScore", overlap);

  const m90 = mentionsLast90d(doc);
  const traction = computeTraction({
    mentions90d: m90,
    events90d: extra.events90d ?? 0,
    reviewCount: extra.reviewCount ?? null,
    phLaunch: extra.phLaunch ?? false,
  });
  doc.set("prioritySuggested", computePrioritySuggested(doc, overlap, traction, m90));
  doc.markModified?.("prioritySuggested");

  doc.set("weaknessThemes", derivedWeaknessThemes(doc));
  doc.set("quality", computeQuality(doc, settings.staleDays || 30));
  doc.markModified?.("quality");
}
