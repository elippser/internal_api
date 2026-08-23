import { makeId } from "../../shared/utils/ids";
import { SCHEMA_VERSION } from "./competitors.model";
import { getMeta, makeMeta, setMeta } from "./fieldMeta";

/**
 * Migracion lazy v1 -> v2 (spec v2 §8.4). Se aplica en memoria al leer y se
 * persiste en el proximo guardado (o con `npm run migrate:competitors-v2`).
 * Idempotente: un doc ya en v2 no se toca.
 *
 *   featureMatrix.has "yes" -> "native" (source legacy, confidence low)
 *   weaknessThemes[]        -> weaknesses[] sin evidencia (source legacy)
 *   pricing.visibility      -> "public" si habia min/max, si no "unknown"
 *   watchedPages            -> [home, pricing?] si estaba vacio
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureV2(doc: any): boolean {
  if ((doc.schemaVersion ?? 1) >= SCHEMA_VERSION) return false;
  const meta = getMeta(doc);

  // featureMatrix: yes -> native
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matrix: any[] = Array.isArray(doc.featureMatrix) ? doc.featureMatrix : [];
  const nextMatrix = matrix.map((it) => {
    const obj = typeof it?.toObject === "function" ? it.toObject() : { ...it };
    if (obj.has === "yes") obj.has = "native";
    if (!obj.source) obj.source = "legacy";
    const path = `featureMatrix.${obj.key}`;
    if (!meta[path]) setMeta(doc, path, makeMeta("legacy", { confidence: "low" }));
    return obj;
  });
  doc.set("featureMatrix", nextMatrix);

  // weaknessThemes -> weaknesses
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const weaknesses: any[] = Array.isArray(doc.weaknesses) ? doc.weaknesses : [];
  if (weaknesses.length === 0 && Array.isArray(doc.weaknessThemes) && doc.weaknessThemes.length > 0) {
    const note = typeof doc.detectedWeakness === "string" ? doc.detectedWeakness : "";
    doc.set(
      "weaknesses",
      doc.weaknessThemes.map((theme: string, i: number) => ({
        weaknessId: makeId("weak"),
        theme,
        note: i === 0 ? note : "",
        evidenceUrl: "",
        source: "legacy",
        addedAt: doc.updatedAt ?? new Date(),
        addedByUserId: null,
      })),
    );
  }

  // pricing.visibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pricing: any = doc.pricing ?? {};
  if (!pricing.visibility || pricing.visibility === "unknown") {
    const hasNumbers = pricing.minMonthlyUsd != null || pricing.maxMonthlyUsd != null;
    doc.set("pricing.visibility", hasNumbers ? "public" : "unknown");
    if (hasNumbers) setMeta(doc, "pricing.visibility", makeMeta("legacy", { confidence: "low" }));
  }
  if (!Array.isArray(pricing.plans)) doc.set("pricing.plans", []);

  // watchedPages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pages: any[] = Array.isArray(doc.watchedPages) ? doc.watchedPages : [];
  if (pages.length === 0) {
    const next = [
      { pageId: makeId("wp"), kind: "home", url: doc.website, feedUrl: null, cadence: "monthly", status: "active", lastHash: null, lastCheckedAt: null, lastChangedAt: null },
    ];
    if (pricing.pricingUrl) {
      next.push({ pageId: makeId("wp"), kind: "pricing", url: pricing.pricingUrl, feedUrl: null, cadence: "weekly", status: "active", lastHash: null, lastCheckedAt: null, lastChangedAt: null });
    }
    doc.set("watchedPages", next);
  }

  for (const k of ["aliases", "extraDomains", "productTypes", "targetSizes", "geoFocus", "socialProfiles"]) {
    if (!Array.isArray(doc[k])) doc.set(k, []);
  }
  if (!doc.meta || typeof doc.meta !== "object") doc.set("meta", {});

  doc.set("schemaVersion", SCHEMA_VERSION);
  return true;
}
