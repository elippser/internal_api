import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { crmService } from "../modules/crm/crm.service";
import { MktAccount, MktContact, MktEvent } from "../modules/crm/crm.model";

/**
 * Verificacion de la Fase 1 del hub de marketing (ver MKT-HUB-SPEC.md §6).
 * Corre el backfill, las stats, un import y el ciclo completo de un evento.
 *
 * Es idempotente: se puede correr las veces que haga falta.
 */
async function main() {
  await connectDB();

  console.log("=== 1. Backfill desde companies del PMS ===");
  const backfill = await crmService.backfillFromPms();
  console.log(
    `  escaneadas ${backfill.scanned} · creadas ${backfill.created} · actualizadas ${backfill.updated}`,
  );

  console.log("\n=== 2. Recalculo de stats ===");
  const stats = await crmService.refreshStats();
  console.log(`  ${stats.refreshed} cuentas recalculadas`);

  console.log("\n=== 3. Cuentas con su adopcion ===");
  const list = await crmService.listAccounts({ page: 1, limit: 10, skip: 0 });
  console.log(`  total: ${list.total}`);
  for (const a of list.data as any[]) {
    console.log(
      `  ${(a.name ?? "").slice(0, 26).padEnd(26)} | ${String(a.lifecycle).padEnd(9)}` +
        ` | props ${String(a.stats?.propertiesCount ?? 0).padStart(2)}` +
        ` | units ${String(a.stats?.unitsCount ?? 0).padStart(3)}` +
        ` | IA ${String(a.stats?.iaCreditsUsed ?? 0).padStart(8)}` +
        ` | inactiva ${a.stats?.daysInactive ?? "—"}d`,
    );
  }

  console.log("\n=== 4. Import de prospectos (CSV ya parseado) ===");
  const imported = await crmService.importAccounts([
    {
      name: "Hotel Smoke Test",
      website: "https://hotel-smoke-test.example",
      country: "AR",
      city: "Bariloche",
      email: "contacto@hotel-smoke-test.example",
      firstName: "Ana",
    },
  ]);
  console.log(
    `  recibidas ${imported.received} · creadas ${imported.created} · contactos ${imported.contactsCreated} · salteadas ${imported.skipped.length}`,
  );
  if (imported.skipped.length) console.log("  ", imported.skipped);

  console.log("\n=== 5. Ciclo de un evento (ingesta -> outbox -> efecto) ===");
  const target = (await MktAccount.findOne({ source: "import" }).lean()) as any;
  if (!target) {
    console.log("  sin cuenta de prueba, se saltea");
  } else {
    const corr = `smoke-${Date.now()}`;
    const first = await crmService.ingestEvent({
      type: "demo.requested",
      correlationId: corr,
      accountId: target.accountId,
      payload: { note: "smoke" },
    });
    console.log(`  ingesta: duplicate=${first.duplicate}`);

    const again = await crmService.ingestEvent({
      type: "demo.requested",
      correlationId: corr,
      accountId: target.accountId,
    });
    console.log(`  reingesta mismo correlationId: duplicate=${again.duplicate} (debe ser true)`);

    const drained = await crmService.drainOutbox();
    console.log(
      `  drenado: procesados ${drained.processed} · entregados ${drained.delivered} · sin cuenta ${drained.skipped} · con error ${drained.failed}`,
    );

    const after = (await MktAccount.findOne({ accountId: target.accountId }).lean()) as any;
    console.log(
      `  lifecycle: ${target.lifecycle} -> ${after?.lifecycle} (demo.requested debe dejarla en "demo")`,
    );
  }

  console.log("\n=== 6. Totales ===");
  console.log(`  cuentas:   ${await MktAccount.countDocuments()}`);
  console.log(`  contactos: ${await MktContact.countDocuments()}`);
  console.log(`  eventos:   ${await MktEvent.countDocuments()}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("smokeCrm fallo:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
