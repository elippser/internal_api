/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Por qué una cuenta puede (o no) usar Roombir IA. SÓLO LECTURA.
 *
 *   npm run diagnose:ia-credits              # todas las companies
 *   npm run diagnose:ia-credits -- <companyId>
 *
 * El portón de créditos bloquea con un mensaje corto ("esta cuenta no tiene un
 * plan asignado") que no dice CUÁL de los cuatro motivos posibles se dio ni
 * dónde está el dato que falta. Este script recorre la cadena entera y señala
 * el eslabón exacto:
 *
 *   company.selectedPlan → planId → plans.productKeys → limits.iaMonthlyCredits
 *
 * No escribe nada. Se puede correr contra producción.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { getCompanyModel } from "../modules/hotels/pmsModels";
import { Plan } from "../modules/plans/plans.model";
import {
  IA_PRODUCT_KEY,
  IA_PRODUCT_KEYS,
  includesIaProduct,
  iaEnforcementOn,
  planCreditsService,
  creditsMessage,
} from "../modules/plans/planCredits.service";

const only = process.argv[2];

function mark(ok: boolean) {
  return ok ? "✓" : "✗";
}

async function main() {
  await connectDB();

  console.log(
    `\nFlag de enforcement: IA_CREDITS_ENFORCEMENT=${process.env.IA_CREDITS_ENFORCEMENT ?? "(sin setear)"} → ` +
      `el portón está ${iaEnforcementOn() ? "ENCENDIDO (bloquea)" : "APAGADO (deja pasar todo)"}`,
  );
  console.log(`Clave de producto que busca el código: "${IA_PRODUCT_KEY}"\n`);

  // 1. Los planes del catálogo: qué producto incluyen y cuánto cupo dan.
  const plans = await Plan.find({}).lean();
  console.log(`${"─".repeat(74)}\nPLANES (${plans.length})\n${"─".repeat(74)}`);
  for (const p of plans as any[]) {
    const keys: string[] = p.productKeys ?? [];
    const hasIa = includesIaProduct(keys);
    const credits = p.limits?.iaMonthlyCredits ?? 0;
    console.log(
      `${mark(hasIa && credits > 0)} ${p.name ?? p.planId}  (${p.planId})`,
    );
    console.log(
      `    producto "${IA_PRODUCT_KEY}": ${hasIa ? "incluido" : "NO INCLUIDO"}` +
        ` · cupo mensual: ${credits.toLocaleString("es-AR")}` +
        ` · reset día ${p.limits?.iaResetDayUTC ?? 1}`,
    );
    console.log(`    productKeys: ${keys.length ? keys.join(", ") : "(vacío)"}`);
    // El código acepta las dos claves, así que esto ya no bloquea. Se marca
    // igual porque cada company que elija este plan se lleva un snapshot con
    // el nombre viejo, y la deuda se propaga sola.
    const legacy = keys.filter((k) => /bookfer/i.test(k));
    if (legacy.length) {
      console.log(
        `    ⚠ clave con el nombre VIEJO: ${legacy.join(", ")} — funciona por alias, pero conviene` +
          ` migrar el plan (npm run migrate:ia-product-key) para que los snapshots nuevos nazcan bien`,
      );
    }
  }

  // 2. Las companies: qué plan tienen guardado y qué decide el portón.
  const Company = await getCompanyModel();
  const filter = only ? { companyId: only } : {};
  const companies = (await Company.collection
    .find(filter, { projection: { companyId: 1, name: 1, selectedPlan: 1 } })
    .limit(60)
    .toArray()) as any[];

  console.log(
    `\n${"─".repeat(74)}\nCOMPANIES (${companies.length})\n${"─".repeat(74)}`,
  );

  const byReason = new Map<string, number>();
  for (const c of companies) {
    const credits = await planCreditsService.getCompanyCredits(c.companyId);
    byReason.set(credits.reason, (byReason.get(credits.reason) ?? 0) + 1);

    const puede = credits.reason === "ok";
    console.log(`\n${mark(puede)} ${c.name ?? "(sin nombre)"}  ${c.companyId}`);

    const snap = c.selectedPlan;
    if (!snap?.planId) {
      console.log(`    selectedPlan: AUSENTE ← acá se corta`);
    } else {
      console.log(
        `    selectedPlan: ${snap.name ?? snap.planId} (${snap.planId})`,
      );
      const keys: string[] = snap.productKeys ?? [];
      console.log(
        `      productKeys del snapshot: ${keys.length ? keys.join(", ") : "(vacío → cae al plan vivo)"}`,
      );
      if (!includesIaProduct(keys) && keys.length) {
        const legacy = keys.filter((k) => /bookfer/i.test(k));
        console.log(
          `      ✗ no incluye "${IA_PRODUCT_KEY}"` +
            (legacy.length ? ` pero SÍ "${legacy.join(", ")}" (nombre viejo)` : ""),
        );
      }
    }
    console.log(
      `    → ${credits.reason}` +
        (credits.reason === "ok"
          ? ` · ${credits.consumed.toLocaleString("es-AR")}/${credits.monthlyCredits.toLocaleString("es-AR")} tokens usados`
          : ` · "${creditsMessage(credits)}"`),
    );
  }

  console.log(`\n${"─".repeat(74)}\nRESUMEN\n${"─".repeat(74)}`);
  for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${reason}`);
  }
  console.log(
    `\nPara habilitar una cuenta: panel interno → /plans → el plan → incluir` +
      ` el producto "${IA_PRODUCT_KEY}" y poner "Créditos de IA / mes" > 0.` +
      `\nY la company tiene que tener ESE plan seleccionado (selectedPlan).`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
