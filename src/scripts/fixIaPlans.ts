/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Deja los planes en un estado en el que Roombir IA se puede usar.
 *
 *   npm run fix:ia-plans              # dry-run
 *   npm run fix:ia-plans -- --apply   # escribe
 *
 * Arregla las tres inconsistencias que bloqueaban el chat en produccion:
 *
 * 1. **La clave del rename.** Los planes dicen `bookfer-ia` y el codigo busca
 *    `roombir-ia`. El porton ya acepta las dos (ver IA_PRODUCT_KEYS), asi que
 *    esto no desbloquea a nadie: sirve para que los snapshots de las cuentas
 *    NUEVAS nazcan con el nombre correcto y la deuda deje de propagarse.
 *
 * 2. **`Profesional` tiene cupo de IA pero no incluye el producto.** Tiene
 *    500.000 creditos mensuales configurados y ninguna clave de IA en
 *    `productKeys`, con ningun nombre. El cupo prueba la intencion: nadie
 *    configura un cupo para un producto que no quiere vender. Se agrega la
 *    clave.
 *
 * 3. **Los cupos eran placeholders.** 500.000 tokens al mes con un turno de
 *    chat que consume entre 25.000 y 45.000 son DOCE turnos mensuales: no es un
 *    limite comercial, es un numero que quedo puesto. Se llevan a valores que
 *    permiten usar el producto, escalonados por plan.
 *
 *    Estos numeros NO son una decision de precio cerrada: se editan en el panel
 *    interno (/plans → el plan → "Creditos de IA / mes") y aplican al instante,
 *    sin deploy ni migracion.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Plan } from "../modules/plans/plans.model";
import { getCompanyModel } from "../modules/hotels/pmsModels";
import {
  IA_PRODUCT_KEY,
  includesIaProduct,
} from "../modules/plans/planCredits.service";

const LEGACY_KEY = "bookfer-ia";
const APPLY = process.argv.includes("--apply");

/**
 * Cupo mensual por plan, en tokens. La referencia es el costo medido de un
 * turno del chat: ~25k un turno simple, ~45k uno con herramientas.
 */
const QUOTAS: Record<string, { credits: number; porque: string }> = {
  Inicial: { credits: 3_000_000, porque: "~70-100 turnos/mes" },
  Profesional: { credits: 10_000_000, porque: "~250-350 turnos/mes" },
  "Full System": { credits: 30_000_000, porque: "~700-1000 turnos/mes" },
};

async function main() {
  await connectDB();

  const plans = await Plan.find({}).lean();
  console.log(
    `${plans.length} planes${APPLY ? "" : "  (dry-run: no se escribe nada)"}\n`,
  );

  let changed = 0;

  for (const p of plans as any[]) {
    const before: string[] = p.productKeys ?? [];
    const beforeCredits = p.limits?.iaMonthlyCredits ?? 0;

    // 1 + 2: la clave queda como `roombir-ia`, este el plan como este.
    let keys = [...new Set(before.map((k) => (k === LEGACY_KEY ? IA_PRODUCT_KEY : k)))];
    const teniaIa = includesIaProduct(before);
    const tieneCupo = beforeCredits > 0;
    if (!teniaIa && tieneCupo) {
      keys = [...keys, IA_PRODUCT_KEY];
    }

    // 3: el cupo, si el plan esta en la tabla y da IA.
    const quota = QUOTAS[p.name as string];
    const credits =
      quota && includesIaProduct(keys) ? quota.credits : beforeCredits;

    const cambioKeys = JSON.stringify(keys) !== JSON.stringify(before);
    const cambioCupo = credits !== beforeCredits;
    if (!cambioKeys && !cambioCupo) {
      console.log(`= ${p.name ?? p.planId}: sin cambios`);
      continue;
    }

    changed++;
    console.log(`${p.name ?? p.planId}  (${p.planId})`);
    if (cambioKeys) {
      const agregadas = keys.filter((k) => !before.includes(k));
      const quitadas = before.filter((k) => !keys.includes(k));
      if (quitadas.length) console.log(`  - quita:   ${quitadas.join(", ")}`);
      if (agregadas.length) console.log(`  + agrega:  ${agregadas.join(", ")}`);
      if (!teniaIa && tieneCupo) {
        console.log(
          `    (tenia ${beforeCredits.toLocaleString("es-AR")} creditos configurados y ninguna clave de IA)`,
        );
      }
    }
    if (cambioCupo) {
      console.log(
        `  cupo: ${beforeCredits.toLocaleString("es-AR")} → ${credits.toLocaleString("es-AR")} tokens/mes` +
          (quota ? `  (${quota.porque})` : ""),
      );
    }

    if (APPLY) {
      await Plan.updateOne(
        { planId: p.planId },
        { $set: { productKeys: keys, "limits.iaMonthlyCredits": credits } },
      );
      console.log(`  ✓ aplicado`);
    }
    console.log("");
  }

  // ── Snapshots de las companies ──────────────────────────────────────────
  //
  // Por que SI se tocan, despues de haber argumentado que no:
  //
  // El snapshot registra QUE PRODUCTOS tiene la cuenta. `bookfer-ia` y
  // `roombir-ia` son el MISMO producto — lo unico que cambio fue el nombre de
  // la plataforma. Cambiar el identificador no altera lo que la cuenta
  // contrato; dejarlo viejo, en cambio, la deja bloqueada contra cualquier
  // version del codigo que no conozca el alias.
  //
  // Y eso importa hoy: produccion corre el build ANTERIOR, que solo acepta
  // `roombir-ia` y lee el SNAPSHOT antes que el plan. Migrarlo desbloquea el
  // chat sin esperar un deploy. El alias del codigo sigue siendo necesario para
  // las cuentas que queden sin migrar.
  const snapshots = await migrateCompanySnapshots();

  console.log(
    APPLY
      ? `\n${changed} plan(es) y ${snapshots} snapshot(s) actualizados.\n` +
          `El cupo sale del plan VIVO, asi que el nuevo aplica al mes corriente sin\n` +
          `migrar cuenta por cuenta.\n\n` +
          `Verificar: IA_CREDITS_ENFORCEMENT=on npm run diagnose:ia-credits`
      : `\n${changed} plan(es) y ${snapshots} snapshot(s) cambiarian.\n` +
          `Para escribir: npm run fix:ia-plans -- --apply`,
  );

  await mongoose.disconnect();
}

/**
 * Reemplaza la clave vieja en `company.selectedPlan.productKeys`.
 *
 * Sólo eso: no toca el resto del snapshot, ni los cupos (que salen del plan
 * vivo), ni agrega la IA a cuentas que no la tenían.
 */
async function migrateCompanySnapshots(): Promise<number> {
  const Company = await getCompanyModel();
  const docs = (await Company.collection
    .find(
      { "selectedPlan.productKeys": LEGACY_KEY },
      { projection: { companyId: 1, name: 1, "selectedPlan.productKeys": 1 } },
    )
    .toArray()) as any[];

  if (docs.length === 0) {
    console.log("\nNingún snapshot de company usa la clave vieja.");
    return 0;
  }

  console.log(`\n${docs.length} company(s) con la clave vieja en su snapshot:`);
  for (const c of docs) {
    const before: string[] = c.selectedPlan?.productKeys ?? [];
    const next = [
      ...new Set(before.map((k) => (k === LEGACY_KEY ? IA_PRODUCT_KEY : k))),
    ];
    console.log(`  ${c.name ?? c.companyId}: ${LEGACY_KEY} → ${IA_PRODUCT_KEY}`);
    if (APPLY) {
      await Company.collection.updateOne(
        { companyId: c.companyId },
        { $set: { "selectedPlan.productKeys": next } },
      );
    }
  }
  return docs.length;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
