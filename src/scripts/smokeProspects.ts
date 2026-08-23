import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { prospectsService } from "../modules/prospects/prospects.service";
import { Prospect, ProspectActivity } from "../modules/prospects/prospects.model";
import { MktAccount } from "../modules/crm/crm.model";

/**
 * Verificacion del modulo de prospectos: el ciclo completo de una ficha, desde
 * el alta hasta la conversion en cuenta del CRM, mas los agregados del tablero.
 *
 * Trabaja sobre un handle propio (`smoke.prospect.test`) y limpia lo que crea,
 * asi que se puede correr contra la base real las veces que haga falta.
 *
 *   npm run smoke:prospects
 */

const HANDLE = "smoke.prospect.test";

async function cleanup() {
  const doc = await Prospect.findOne({ handle: HANDLE }).lean();
  if (doc) {
    await ProspectActivity.deleteMany({ prospectId: doc.prospectId });
    await Prospect.deleteOne({ prospectId: doc.prospectId });
    if (doc.accountId) await MktAccount.deleteOne({ accountId: doc.accountId });
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  await connectDB();
  await cleanup();

  console.log("=== 1. Alta con normalizacion ===");
  const created = await prospectsService.create({
    name: "Hotel Smoke Prospecto",
    handle: `@${HANDLE}`,
    lodgingType: "apart hotel",
    location: "Villa Carlos Paz, Cordoba, Argentina",
    phone: "3541 422222",
    website: "hotel-smoke-prospecto.example",
    source: "manual",
  });
  console.log(
    `  ${created.prospectId} · tipo ${created.lodgingType} · pais ${created.country}` +
      ` · region ${created.region} · tel ${created.contact?.phone}` +
      ` · score ${created.score} · contactabilidad ${created.contactability}`,
  );
  if (created.lodgingType !== "apart_hotel") throw new Error("no mapeo el tipo");
  if (!created.contact?.phone?.startsWith("+54")) throw new Error("no normalizo el telefono");
  if (created.status !== "new" || created.outcome !== "open") {
    throw new Error("no arranco en new/open");
  }

  console.log("\n=== 2. Duplicado por handle ===");
  try {
    await prospectsService.create({ name: "Duplicado", handle: HANDLE });
    throw new Error("acepto un handle duplicado");
  } catch (err: any) {
    if (err?.code !== "duplicate_handle") throw err;
    console.log(`  rechazado como corresponde: ${err.message}`);
  }

  console.log("\n=== 3. Primer intento: no atiende ===");
  const first = await prospectsService.logActivity(
    created.prospectId,
    { type: "call", outcome: "no_answer", notes: "Sono y corto" },
    { userId: "smoke", email: "smoke@bookfer.com" },
  );
  console.log(
    `  intentos ${first.prospect.attempts} · etapa ${first.prospect.status}` +
      ` · ultimo ${first.prospect.lastOutcome}`,
  );
  if (first.prospect.status !== "attempting") throw new Error("no paso a attempting");
  if (first.prospect.attempts !== 1) throw new Error("no conto el intento");

  console.log("\n=== 4. Segundo intento: atiende y agenda seguimiento ===");
  const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const second = await prospectsService.logActivity(
    created.prospectId,
    {
      type: "call",
      outcome: "connected",
      notes: "Hablamos con la duenia, pidio que llame manana",
      durationSec: 240,
      nextActionAt: manana,
      nextActionNote: "Volver a llamar a la manana",
    },
    { userId: "smoke", email: "smoke@bookfer.com" },
  );
  console.log(
    `  intentos ${second.prospect.attempts} · etapa ${second.prospect.status}` +
      ` · primer contacto ${second.prospect.firstReachedAt ? "si" : "no"}` +
      ` · proxima ${second.prospect.nextActionAt}`,
  );
  if (second.prospect.status !== "contacted") throw new Error("no paso a contacted");
  if (!second.prospect.firstReachedAt) throw new Error("no marco el primer contacto");

  console.log("\n=== 5. Avance manual a interesado y despues a perdido ===");
  await prospectsService.update(created.prospectId, { status: "interested" });
  const lost = await prospectsService.update(created.prospectId, {
    status: "lost",
    lostReason: "price",
    lostNote: "Le parecio caro contra lo que paga hoy",
  });
  console.log(
    `  etapa ${lost.status} · resultado ${lost.outcome} · motivo ${lost.lostReason}` +
      ` · seguimiento ${lost.nextActionAt ?? "limpio"}`,
  );
  if (lost.outcome !== "lost") throw new Error("no derivo el outcome a lost");
  if (lost.nextActionAt) throw new Error("dejo un seguimiento agendado en un cerrado");

  console.log("\n=== 6. Reapertura: el motivo de perdida tiene que irse ===");
  const reopened = await prospectsService.update(created.prospectId, { status: "demo" });
  console.log(`  etapa ${reopened.status} · motivo ${reopened.lostReason ?? "limpio"}`);
  if (reopened.lostReason) throw new Error("quedo colgado el motivo de perdida");

  console.log("\n=== 7. Conversion a cuenta del CRM ===");
  const conv = await prospectsService.convert(created.prospectId, { lifecycle: "customer" });
  console.log(
    `  etapa ${conv.prospect.status} · cuenta ${conv.accountId}` +
      ` · creada ${conv.accountCreated ? "si" : "ya existia"}`,
  );
  if (conv.prospect.status !== "won") throw new Error("no quedo en won");
  try {
    await prospectsService.convert(created.prospectId);
    throw new Error("dejo convertir dos veces");
  } catch (err: any) {
    if (err?.code !== "already_converted") throw err;
    console.log("  la segunda conversion se rechaza como corresponde");
  }

  console.log("\n=== 8. Timeline de la ficha ===");
  const detail = await prospectsService.get(created.prospectId);
  console.log(`  ${detail.activities.length} actividades registradas`);
  for (const a of detail.activities as any[]) {
    console.log(
      `    ${new Date(a.occurredAt).toISOString().slice(0, 16)} · ${String(a.type).padEnd(12)}` +
        ` · ${String(a.outcome).padEnd(14)} · ${a.statusFrom} -> ${a.statusTo}`,
    );
  }
  if (detail.activities.length !== 2) throw new Error("faltan actividades en el timeline");

  console.log("\n=== 9. Import idempotente ===");
  const rows = [
    {
      name: "Cabanias Smoke Import",
      handle: `${HANDLE}.import`,
      lodgingType: "cabanias",
      location: "Villa General Belgrano, Cordoba",
      phone: "3546 452117",
    },
  ];
  const imp1 = await prospectsService.importRows(rows, { sourceBatch: "smoke" });
  const imp2 = await prospectsService.importRows(rows, { sourceBatch: "smoke" });
  console.log(
    `  primera pasada: creados ${imp1.created} actualizados ${imp1.updated} · ` +
      `segunda: creados ${imp2.created} actualizados ${imp2.updated}`,
  );
  if (imp1.created !== 1 || imp2.created !== 0) throw new Error("el import no es idempotente");
  await Prospect.deleteOne({ handle: `${HANDLE}.import` });

  console.log("\n=== 10. Cola de llamadas ===");
  const queue = await prospectsService.queue({ limit: 5 });
  console.log(
    `  abiertos contactables ${queue.counts.open} · vencidos ${queue.counts.due}` +
      ` · sin tocar ${queue.counts.fresh}`,
  );
  for (const item of queue.items as any[]) {
    console.log(
      `    [${String(item.queueBucket).padEnd(5)}] ${String(item.name).slice(0, 34).padEnd(36)}` +
        ` score ${String(item.score).padStart(3)} · ${item.contact?.phone ?? item.contact?.phoneRaw ?? "—"}`,
    );
  }

  console.log("\n=== 11. Tablero ===");
  const dash = await prospectsService.dashboard({ days: 30 });
  const t = dash.totals;
  console.log(
    `  total ${t.total} · abiertos ${t.open} · ganados ${t.won} · perdidos ${t.lost}` +
      ` · sin tocar ${t.untouched} · con telefono ${t.withPhone}`,
  );
  console.log(
    `  contacto ${pct(dash.rates.contactRate)} · interes ${pct(dash.rates.interestRate)}` +
      ` · cierre ${pct(dash.rates.winRate)} · intentos por contacto ${dash.rates.attemptsPerReach.toFixed(1)}`,
  );
  console.log(`  embudo: ${dash.funnel.map((f) => `${f.status} ${f.count}`).join(" · ")}`);
  console.log(
    `  top tipos: ${dash.byLodgingType.slice(0, 5).map((r) => `${r.lodgingType} ${r.count}`).join(" · ")}`,
  );
  console.log(
    `  top paises: ${dash.byCountry.slice(0, 5).map((r) => `${r.country ?? "?"} ${r.count}`).join(" · ")}`,
  );

  console.log("\n=== 12. Limpieza ===");
  await cleanup();
  console.log("  ficha de prueba y su cuenta borradas");

  console.log("\nOK");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n[smoke:prospects] fallo:", err?.message ?? err);
  try {
    await cleanup();
    await mongoose.disconnect();
  } catch {
    // Ya estaba desconectado o nunca conecto.
  }
  process.exit(1);
});
