import "dotenv/config";
import mongoose from "mongoose";
import { makeId } from "../shared/utils/ids";
import { normalizeUrl } from "../shared/web/fetchPage";
import { domainOf } from "../modules/crm/crm.model";
import { Competitor, RadarItem } from "../modules/competitors/competitors.model";
import { recomputeDerived } from "../modules/competitors/quality.service";
import { getSettings } from "../modules/competitors/settings.service";

/**
 * Unifica el radar y el battle set en UNA sola lista de competidores (v2.2).
 *
 * Cada item `new_entrant` de `ci_radar_items` pasa a ser un competidor con
 * `stage`:
 *   pending    -> detected
 *   discarded  -> discarded
 *   promoted   -> ya existe como competidor (se saltea)
 *
 * Los items de senal, cambio y mencion NO se tocan: esos siguen siendo cola de
 * triage del radar, que es otra cosa. Idempotente: se puede correr de nuevo.
 *
 *   npm run unify:competitors
 */

const STAGE_BY_STATUS: Record<string, "detected" | "discarded" | null> = {
  pending: "detected",
  discarded: "discarded",
  promoted: null,
  acknowledged: null,
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI no configurada");
  await mongoose.connect(uri);
  const settings = await getSettings();

  // Los que ya existen: por dominio principal y por dominios alternos.
  const known = new Set<string>();
  for (const c of await Competitor.find({}).select("websiteDomain extraDomains").lean()) {
    if (c.websiteDomain) known.add(String(c.websiteDomain));
    for (const d of c.extraDomains ?? []) known.add(String(d));
  }

  const items = await RadarItem.find({ kind: "new_entrant" }).lean();
  let created = 0;
  let skipped = 0;
  let removed = 0;

  for (const item of items) {
    const domain = item.domain ? String(item.domain) : domainOf(item.url ?? "");
    const stage = STAGE_BY_STATUS[String(item.status)] ?? null;
    if (!domain || stage === null || known.has(domain)) {
      skipped++;
      // El item ya está representado como competidor: se retira de la cola.
      await RadarItem.deleteOne({ radarId: item.radarId });
      removed++;
      continue;
    }
    const website = normalizeUrl(item.url ?? `https://${domain}`) ?? `https://${domain}`;
    const now = new Date();
    const doc = new Competitor({
      competitorId: makeId("comp"),
      schemaVersion: 2,
      name: (item.detectedName || domain).slice(0, 160),
      website,
      websiteDomain: domain,
      // Sin curar todavía: el segmento se completa al pasarlo a seguimiento.
      segment: "latam",
      priority: "C",
      status: "active",
      stage,
      detection: {
        source: item.source ?? "web_search",
        sourceLabel: item.sourceLabel ?? "",
        foundByQueryIds: item.foundByQueryIds ?? [],
        aiSummary: item.aiSummary ?? "",
        aiConfidence: item.aiConfidence ?? "medium",
        tractionSignals: item.tractionSignals ?? [],
        seenCount: item.seenCount ?? 1,
        firstSeenAt: item.firstSeenAt ?? now,
        lastSeenAt: item.lastSeenAt ?? now,
        runId: item.runId ?? null,
        discardReason: item.discardReason ?? "",
        decidedBy: item.decidedBy ?? null,
      },
      evidence: item.url
        ? [{ evidenceId: makeId("ev"), kind: "radar", url: item.url, note: item.aiSummary ?? "Detectado por el radar", addedAt: now, addedByUserId: null }]
        : [],
      lastReviewedAt: item.lastSeenAt ?? now,
      createdByUserId: null,
      updatedByUserId: null,
    });
    recomputeDerived(doc, settings);
    await doc.save();
    known.add(domain);
    created++;
    await RadarItem.deleteOne({ radarId: item.radarId });
    removed++;
  }

  // Los competidores que ya existían quedan en la etapa de seguimiento.
  const fixed = await Competitor.updateMany({ stage: { $exists: false } }, { $set: { stage: "tracked" } });

  const byStage = await Competitor.aggregate([{ $group: { _id: "$stage", n: { $sum: 1 } } }]);
  console.log(`[unify:competitors] items del radar: ${items.length} · creados: ${created} · ya existían: ${skipped} · items retirados de la cola: ${removed}`);
  console.log(`[unify:competitors] competidores sin etapa corregidos: ${fixed.modifiedCount}`);
  console.log(`[unify:competitors] por etapa: ${JSON.stringify(byStage)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[unify:competitors] falló:", err?.message ?? err);
  process.exit(1);
});
