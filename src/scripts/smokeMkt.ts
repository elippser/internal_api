import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { crmService, registerEventConsumer } from "../modules/crm/crm.service";
import { MktAccount, MktContact } from "../modules/crm/crm.model";
import { segmentsService } from "../modules/crm/segments.service";
import { campaignsService } from "../modules/campaigns/campaigns.service";
import { MktMessage, MktTemplate } from "../modules/campaigns/campaigns.model";
import { mktsiteService } from "../modules/mktsite/mktsite.service";
import { reputationService } from "../modules/reputation/reputation.service";

/** Verificacion de las fases 2-7 del hub. Idempotente. */
async function main() {
  await connectDB();
  registerEventConsumer((evt) => campaignsService.enqueueForEvent(evt));

  console.log("=== 1. Segmentos del sistema ===");
  await segmentsService.ensureSystemSegments();
  for (const s of await segmentsService.list()) {
    console.log(`  ${String((s as any).name).padEnd(28)} -> ${(s as any).count} cuentas`);
  }

  console.log("\n=== 2. Sitio + pagina + publicacion ===");
  let site = (await mktsiteService.listSites()).find((s: any) => s.slug === "bookfer");
  if (!site) {
    site = await mktsiteService.createSite(
      { name: "Bookfer", slug: "bookfer", status: "published" },
      "smoke",
    );
    console.log("  sitio creado");
  } else {
    console.log("  sitio ya existia");
  }
  const full = await mktsiteService.getSite((site as any).siteId);
  const home = (full as any).pages.find((p: any) => p.path === "/");
  await mktsiteService.publishPage(home.pageId);

  const publicHtml = await mktsiteService.renderPage("bookfer", "/");
  console.log(`  render publico: ${publicHtml.length} bytes, <title> presente: ${publicHtml.includes("<title>")}`);
  const previewHtml = await mktsiteService.renderPage("bookfer", "/", true);
  console.log(`  preview lleva noindex: ${previewHtml.includes("noindex")}`);

  console.log("\n=== 3. Captura de lead desde el sitio ===");
  const leadEmail = `lead-${Date.now()}@hotel-demo.example`;
  const lead = await mktsiteService.captureLead({
    email: leadEmail,
    name: "Carla",
    company: "hotel-demo.example",
    message: "Quiero una demo",
    siteId: (site as any).siteId,
    utm: { utm_source: "google", utm_campaign: "brand" },
  });
  console.log(`  cuenta ${lead.accountId} (nueva: ${lead.isNewAccount})`);

  console.log("\n=== 4. Template con trigger + outbox encola el envio ===");
  let tpl = (await campaignsService.listTemplates("email")).find(
    (t: any) => t.name === "Bienvenida smoke",
  );
  if (!tpl) {
    tpl = await campaignsService.createTemplate({
      name: "Bienvenida smoke",
      channel: "email",
      trigger: "lead.captured",
      subject: "Hola {{firstName}}, gracias por escribirnos",
      bodyHtml: "<p>Hola {{firstName}} de {{accountName}}.</p>",
      delayHours: 0,
      active: true,
    });
  }

  const before = await MktMessage.countDocuments();
  const drained = await crmService.drainOutbox();
  const after = await MktMessage.countDocuments();
  console.log(`  outbox: ${drained.delivered} entregados · mensajes encolados: ${after - before}`);

  const queue = await campaignsService.processQueue();
  console.log(`  cola: ${queue.sent} enviados, ${queue.failed} con error (proveedor noop)`);

  // Idempotencia: reprocesar el mismo evento no debe volver a encolar.
  const beforeRe = await MktMessage.countDocuments();
  await crmService.drainOutbox();
  console.log(`  reprocesado -> mensajes nuevos: ${(await MktMessage.countDocuments()) - beforeRe} (debe ser 0)`);

  console.log("\n=== 5. Campaña contra un segmento ===");
  const segs = await segmentsService.list();
  const leadsSeg = segs.find((s: any) => s.name === "Nuevos leads") as any;
  const campaign = await campaignsService.createCampaign(
    {
      name: `Smoke ${Date.now()}`,
      segmentId: leadsSeg.segmentId,
      templateId: (tpl as any).templateId,
    },
    "smoke",
  );
  const sent = await campaignsService.sendCampaign((campaign as any).campaignId);
  console.log(`  destinatarios ${sent.recipients} · encolados ${sent.queued}`);
  const q2 = await campaignsService.processQueue();
  console.log(`  enviados ${q2.sent}`);

  console.log("\n=== 6. NPS con ruteo por score ===");
  const anyAccount = (await MktAccount.findOne({ lifecycle: "customer" }).lean()) as any;
  const invite = await reputationService.createNpsInvite(anyAccount.accountId);
  const promoter = await reputationService.submitNps((invite as any).token, 10, "Excelente");
  console.log(`  score 10 -> ${promoter.category}, pide reseña publica: ${promoter.askForPublicReview}`);

  const invite2 = await reputationService.createNpsInvite(anyAccount.accountId);
  const detractor = await reputationService.submitNps((invite2 as any).token, 3, "Lento");
  console.log(`  score 3  -> ${detractor.category}, pide reseña publica: ${detractor.askForPublicReview} (debe ser false)`);

  const dash = await reputationService.dashboard();
  console.log(`  NPS: ${dash.nps} sobre ${dash.npsResponses} respuestas · rating prom ${dash.averageRating}`);

  console.log("\n=== 7. Tablero del CRM ===");
  const crmDash = await crmService.dashboard();
  console.log(`  cuentas ${crmDash.accounts} · contactos ${crmDash.contacts} · nuevas del mes ${crmDash.newThisMonth}`);
  console.log(`  en riesgo ${crmDash.atRisk} · conversion ${crmDash.conversionRate}% · eventos fallados ${crmDash.failedEvents}`);
  console.log(`  embudo: ${JSON.stringify(crmDash.lifecycle)}`);

  console.log("\n=== 8. Totales ===");
  console.log(`  cuentas ${await MktAccount.countDocuments()} · contactos ${await MktContact.countDocuments()}`);
  console.log(`  templates ${await MktTemplate.countDocuments()} · mensajes ${await MktMessage.countDocuments()}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("smokeMkt fallo:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
