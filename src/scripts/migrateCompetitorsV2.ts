import "dotenv/config";
import mongoose from "mongoose";
import {
  CiDecision,
  CiSettings,
  CiSignal,
  CiSignalEvent,
  CiSuggestion,
  Competitor,
  CompetitorRevision,
  PageSnapshot,
  RadarItem,
  RadarRun,
} from "../modules/competitors/competitors.model";
import { recordRevision } from "../modules/competitors/competitors.service";
import { ensureV2 } from "../modules/competitors/migration";
import { recomputeDerived } from "../modules/competitors/quality.service";
import { getSettings } from "../modules/competitors/settings.service";

/**
 * Migracion v1 -> v2 del battle set (COMPETITIVE-INTEL-SPEC-V2.md §8.4) en
 * lote. Idempotente: los docs ya en v2 solo recalculan derivados.
 *
 *   npm run migrate:competitors-v2
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI no configurada");
  await mongoose.connect(uri);
  const settings = await getSettings();
  const docs = await Competitor.find({});
  let migrated = 0;
  let recomputed = 0;
  for (const doc of docs) {
    const changed = ensureV2(doc);
    recomputeDerived(doc, settings);
    await doc.save();
    if (changed) {
      migrated++;
      await recordRevision(doc.competitorId, "migration", null, [
        { field: "schemaVersion", before: 1, after: 2 },
      ]);
    } else {
      recomputed++;
    }
  }
  console.log(`[migrate:competitors-v2] total=${docs.length} migrados=${migrated} recalculados=${recomputed}`);

  /**
   * Indices: mongoose NO modifica uno que ya existe con otras opciones, y v2
   * cambió dos definiciones de v1 —el unico de snapshots pasó a ser por
   * `pageId` (si no, no se puede vigilar dos páginas del mismo tipo) y el de
   * `domain` del radar pasó a unico parcial—. `syncIndexes` borra los que ya
   * no están declarados y crea los nuevos. Si alguna colección tiene datos
   * duplicados, el índice único falla: se avisa y se sigue.
   */
  const models = [Competitor, CompetitorRevision, RadarItem, RadarRun, PageSnapshot, CiSignal, CiSignalEvent, CiSuggestion, CiSettings, CiDecision];
  for (const model of models) {
    try {
      const dropped = await model.syncIndexes();
      if (dropped.length) console.log(`[migrate:competitors-v2] ${model.collection.name}: índices recreados (${dropped.join(", ")})`);
    } catch (err) {
      console.warn(`[migrate:competitors-v2] ${model.collection.name}: no se pudieron sincronizar los índices — ${(err as Error)?.message}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[migrate:competitors-v2] falló:", err?.message ?? err);
  process.exit(1);
});
