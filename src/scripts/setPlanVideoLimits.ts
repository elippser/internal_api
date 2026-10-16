/**
 * Carga el cupo mensual de VIDEOS de Roombir IA en los planes que no lo tienen.
 *
 *   npm run set:plan-video-limits              # dry-run
 *   npm run set:plan-video-limits -- --apply   # escribe
 *
 * Sólo completa `limits.iaMonthlyVideos` donde está vacío: si alguien ya puso
 * un número desde el panel interno, este script no lo pisa.
 *
 * Los números son una PROPUESTA de arranque, no una decisión de precio: se
 * editan en /plans → el plan → "Videos de IA / mes" y aplican al instante.
 * Con el modelo actual (google/veo-3.1-lite a 720p) un video cuesta entre
 * USD 0,12 (4 s sin sonido) y USD 0,40 (8 s con sonido); lo típico, 6 s sin
 * sonido, USD 0,18. Peor caso (todos de 0,40):
 *
 *   Inicial       (gratis, 30 días)    2 / mes  → USD 0,80 por cuenta
 *   Profesional   (USD 79)            10 / mes  → USD 4,00  (5,1 % del precio)
 *   Full System   (USD 199)           30 / mes  → USD 12,00 (6,0 % del precio)
 *
 * Un plan que no esté en la tabla (planes a medida) queda en null = 0 videos.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Plan } from "../modules/plans/plans.model";

const PROPOSED: Record<string, number> = {
  inicial: 2,
  profesional: 10,
  "full-system": 30,
};

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDB();

  const plans = await Plan.find({}, { planId: 1, name: 1, slug: 1, limits: 1 }).lean();
  let changed = 0;
  for (const p of plans) {
    const current = p.limits?.iaMonthlyVideos;
    const proposed = PROPOSED[p.slug];
    if (current != null) {
      console.log(`= ${p.name} (${p.slug}): ya tiene ${current}, no se toca`);
      continue;
    }
    if (proposed == null) {
      console.log(`· ${p.name} (${p.slug}): sin propuesta, queda en 0`);
      continue;
    }
    console.log(`${apply ? "✓" : "→"} ${p.name} (${p.slug}): ${proposed} videos / mes`);
    if (apply) {
      await Plan.updateOne(
        { planId: p.planId, "limits.iaMonthlyVideos": { $in: [null] } },
        { $set: { "limits.iaMonthlyVideos": proposed } },
      );
    }
    changed++;
  }
  console.log(
    apply
      ? `\n${changed} plan(es) actualizados.`
      : `\nDry-run: ${changed} plan(es) a actualizar. Correr con --apply para escribir.`,
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
