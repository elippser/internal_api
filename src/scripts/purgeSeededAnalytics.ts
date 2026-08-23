import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { AnalyticsEvent } from "../modules/analytics/analytics.model";

/**
 * Borra los eventos sintéticos que dejó `seedAnalytics.ts`.
 *
 *   npx ts-node src/scripts/purgeSeededAnalytics.ts --dry
 *   npx ts-node src/scripts/purgeSeededAnalytics.ts
 *
 * Hasta ahora `analytics_events` no tenía ningún productor real: todo lo que
 * hay en la colección salió del seed. Eso no sólo infla los dashboards de
 * /analytics — también contamina `/hotels`, que usa esta colección para
 * "última actividad" y "eventos 30d" de cada compañía.
 *
 * Correr ANTES de encender la instrumentación real (F1 del spec de métricas),
 * o los primeros números del piloto van a estar mezclados con datos inventados.
 */

/** Companies ficticias del seed (ver seedAnalytics.ts). */
const SEEDED_COMPANIES = [
  "co-001",
  "co-002",
  "co-003",
  "co-004",
  "co-005",
  "co-006",
  "co-007",
  "co-008",
];

const DRY = process.argv.includes("--dry");

async function run(): Promise<void> {
  await connectDB();

  const filter = { companyId: { $in: SEEDED_COMPANIES } };

  const total = await AnalyticsEvent.countDocuments({});
  const seeded = await AnalyticsEvent.countDocuments(filter);
  const real = total - seeded;

  console.log(`[purge] eventos totales:    ${total}`);
  console.log(`[purge] del seed:           ${seeded}`);
  console.log(`[purge] fuera del seed:     ${real}`);

  if (real > 0) {
    // No es necesariamente un problema (puede ser instrumentación real ya
    // encendida), pero conviene mirarlo antes de borrar nada.
    const byCompany = await AnalyticsEvent.aggregate<{
      _id: string;
      n: number;
    }>([
      { $match: { companyId: { $nin: SEEDED_COMPANIES } } },
      { $group: { _id: "$companyId", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]);
    console.log("[purge] compañías con eventos fuera del seed (top 10):");
    for (const c of byCompany) console.log(`    ${c._id} → ${c.n}`);
  }

  if (DRY) {
    console.log("[purge] dry-run: no se borró nada");
  } else if (seeded > 0) {
    const res = await AnalyticsEvent.deleteMany(filter);
    console.log(`[purge] borrados: ${res.deletedCount}`);
  } else {
    console.log("[purge] no hay nada del seed para borrar");
  }

  await mongoose.disconnect();
  console.log("[purge] done");
}

run().catch((err) => {
  console.error("[purge] failed", err);
  process.exit(1);
});
