/**
 * Carga el cupo mensual de IMÁGENES de Roombir IA en los planes que no lo tienen.
 *
 *   npm run set:plan-image-limits              # dry-run
 *   npm run set:plan-image-limits -- --apply   # escribe
 *
 * Sólo completa `limits.iaMonthlyImages` donde está vacío: si alguien ya puso
 * un número desde el panel interno, este script no lo pisa.
 *
 * Los números son una PROPUESTA de arranque, no una decisión de precio: se
 * editan en /plans → el plan → "Imágenes de IA / mes" y aplican al instante.
 * Con el modelo actual (gemini-3.1-flash-lite-image, ~USD 0,034 por imagen):
 *
 *   Inicial       (gratis, 30 días)   10 / mes  → USD 0,34 por cuenta
 *   Profesional   (USD 79)            60 / mes  → USD 2,04  (2,6 % del precio)
 *   Full System   (USD 199)          200 / mes  → USD 6,80  (3,4 % del precio)
 *
 * Un plan que no esté en la tabla (planes a medida) queda en null = 0 imágenes.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Plan } from "../modules/plans/plans.model";

const PROPOSED: Record<string, number> = {
  inicial: 10,
  profesional: 60,
  "full-system": 200,
};

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDB();

  const plans = await Plan.find({}, { planId: 1, name: 1, slug: 1, limits: 1 }).lean();
  let changed = 0;
  for (const p of plans) {
    const current = p.limits?.iaMonthlyImages;
    const proposed = PROPOSED[p.slug];
    if (current != null) {
      console.log(`= ${p.name} (${p.slug}): ya tiene ${current}, no se toca`);
      continue;
    }
    if (proposed == null) {
      console.log(`· ${p.name} (${p.slug}): sin propuesta, queda en 0`);
      continue;
    }
    console.log(`${apply ? "✓" : "→"} ${p.name} (${p.slug}): ${proposed} imágenes / mes`);
    if (apply) {
      await Plan.updateOne(
        { planId: p.planId, "limits.iaMonthlyImages": { $in: [null] } },
        { $set: { "limits.iaMonthlyImages": proposed } },
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
