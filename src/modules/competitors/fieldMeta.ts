import type { Confidence, FieldMeta, FieldSource } from "./competitors.model";

/**
 * Procedencia por campo (spec v2 §8.1): `competitor.meta[path] = FieldMeta`.
 * Mapa plano por path ("pricing.plans", "featureMatrix.whatsapp",
 * "weaknesses.<id>", "socialProfiles.<id>") para no romper filtros ni el
 * front v1. Se escribe siempre entero (Mixed) y se marca modificado.
 */

export function makeMeta(
  source: FieldSource,
  opts: {
    confidence?: Confidence;
    sourceUrl?: string | null;
    quote?: string | null;
    verified?: boolean;
    userId?: string | null;
    observedAt?: Date;
  } = {},
): FieldMeta {
  const now = opts.observedAt ?? new Date();
  const confidence: Confidence =
    opts.confidence ?? (source === "manual" ? (opts.sourceUrl ? "high" : "medium") : source === "legacy" ? "low" : "medium");
  return {
    source,
    confidence,
    sourceUrl: opts.sourceUrl ?? "",
    quote: (opts.quote ?? "").slice(0, 300),
    observedAt: now,
    verifiedAt: opts.verified ? now : null,
    verifiedByUserId: opts.verified ? opts.userId ?? null : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getMeta(doc: any): Record<string, FieldMeta> {
  const m = doc?.meta;
  return m && typeof m === "object" ? (m as Record<string, FieldMeta>) : {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setMeta(doc: any, path: string, meta: FieldMeta): void {
  const next = { ...getMeta(doc), [path]: meta };
  if (typeof doc.set === "function") {
    doc.set("meta", next);
    doc.markModified?.("meta");
  } else {
    doc.meta = next;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function removeMeta(doc: any, path: string): void {
  const current = getMeta(doc);
  if (!(path in current)) return;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [path]: _gone, ...rest } = current;
  if (typeof doc.set === "function") {
    doc.set("meta", rest);
    doc.markModified?.("meta");
  } else {
    doc.meta = rest;
  }
}

/** Marca verificados los paths dados; si no tenian meta, la crea como manual. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function markVerified(doc: any, paths: string[], userId: string | null): string[] {
  const current = getMeta(doc);
  const next: Record<string, FieldMeta> = { ...current };
  const now = new Date();
  const touched: string[] = [];
  for (const raw of paths) {
    const path = String(raw).trim();
    if (!path) continue;
    const prev = next[path];
    next[path] = prev
      ? { ...prev, verifiedAt: now, verifiedByUserId: userId }
      : makeMeta("manual", { verified: true, userId, observedAt: now });
    touched.push(path);
  }
  if (typeof doc.set === "function") {
    doc.set("meta", next);
    doc.markModified?.("meta");
  } else {
    doc.meta = next;
  }
  return touched;
}

/** Paths "clave" que cuentan para el quality score (spec v2 §8.2). */
export const KEY_FIELD_PATHS = [
  "website",
  "segment",
  "productTypes",
  "targetSizes",
  "geoFocus",
  "pricing.visibility",
  "pricing.plans",
  "featureMatrix",
  "statedPositioning",
  "weaknesses",
  "ourAngle",
  "socialProfiles",
] as const;
