/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migra la clave del producto de IA en el CATÁLOGO de planes:
 * `bookfer-ia` → `roombir-ia`.
 *
 *   npm run migrate:ia-product-key            # dry-run: muestra qué haría
 *   npm run migrate:ia-product-key -- --apply # escribe
 *
 * QUÉ TOCA Y QUÉ NO:
 *
 * - **Sí**: `plans.productKeys`. Es el catálogo, y de él salen los snapshots
 *   de cada cuenta nueva. Dejarlo con el nombre viejo hace que la deuda se
 *   propague sola a cada company que elija el plan.
 * - **No**: `company.selectedPlan.productKeys`. Eso es un SNAPSHOT — el
 *   registro de lo que esa cuenta contrató el día que lo contrató. Reescribirlo
 *   para que diga el nombre nuevo sería falsificar el registro. El código
 *   acepta las dos claves justamente para no tener que tocarlo (ver
 *   `IA_PRODUCT_KEYS` en planCredits.service.ts).
 *
 * Correr esto NO desbloquea a nadie por sí solo: el alias ya lo hace. Sirve
 * para que lo que nazca de ahora en más nazca bien.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Plan } from "../modules/plans/plans.model";
import { IA_PRODUCT_KEY } from "../modules/plans/planCredits.service";

const LEGACY_KEY = "bookfer-ia";
const APPLY = process.argv.includes("--apply");

async function main() {
  await connectDB();

  const plans = await Plan.find({ productKeys: LEGACY_KEY }).lean();
  if (plans.length === 0) {
    console.log(`Ningún plan usa "${LEGACY_KEY}". No hay nada que migrar.`);
    await mongoose.disconnect();
    return;
  }

  console.log(
    `${plans.length} plan(es) con la clave vieja${APPLY ? "" : "  (dry-run: no se escribe nada)"}\n`,
  );

  for (const p of plans as any[]) {
    const keys: string[] = p.productKeys ?? [];
    // Si el plan ya tiene las dos, la migración es sólo quitar la vieja.
    const next = [...new Set(keys.map((k) => (k === LEGACY_KEY ? IA_PRODUCT_KEY : k)))];
    console.log(`${p.name ?? p.planId}  (${p.planId})`);
    console.log(`  antes:   ${keys.join(", ")}`);
    console.log(`  después: ${next.join(", ")}`);

    if (APPLY) {
      await Plan.updateOne({ planId: p.planId }, { $set: { productKeys: next } });
      console.log(`  ✓ migrado`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("Para escribir: npm run migrate:ia-product-key -- --apply");
  } else {
    console.log(
      "Listo. Los snapshots existentes NO se tocaron (siguen funcionando por alias).\n" +
        "Verificar con: npm run diagnose:ia-credits",
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
