import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../shared/db";
import { leadsMailer } from "../modules/leads/leads.mailer";
import { Lead, LeadInvite } from "../modules/leads/leads.model";
import { resetRateLimits, screen } from "../modules/leads/leads.screening";
import { leadsService } from "../modules/leads/leads.service";

/**
 * Verificacion del circuito de alta: formulario -> lead -> invite -> canje.
 *
 * Es el modulo que decide quien puede crear una cuenta en roombir, asi que lo
 * que se prueba no es "anda", es que NO se pueda entrar por los costados: un
 * token usado dos veces, un token canjeado con otro correo, un bot que completa
 * el campo trampa.
 *
 * Trabaja con correos propios (@smoke-leads.test) y limpia lo que crea, asi que
 * se puede correr contra la base real las veces que haga falta.
 *
 *   npm run smoke:leads
 */

const DOMAIN = "smoke-leads.test";
const EMAIL = `alta@${DOMAIN}`;
const OTHER_EMAIL = `otro@${DOMAIN}`;

/** El correo no sale: se intercepta el envio para quedarse con el enlace. */
let lastUrl = "";
let sentCount = 0;
let existingNotices = 0;

function interceptMailer() {
  leadsMailer.sendInvite = async (input) => {
    lastUrl = input.url;
    sentCount++;
  };
  leadsMailer.sendAlreadyRegistered = async () => {
    existingNotices++;
  };
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get("inv") ?? "";
}

async function cleanup() {
  const leads = await Lead.find({ email: { $regex: `@${DOMAIN}$` } })
    .select("leadId")
    .lean();
  for (const lead of leads) await LeadInvite.deleteMany({ leadId: lead.leadId });
  await Lead.deleteMany({ email: { $regex: `@${DOMAIN}$` } });
}

const META = { ip: "203.0.113.7", userAgent: "smoke/1.0" };

const FORM = {
  hotelName: "Hotel Smoke Alta",
  lodgingType: "cabins",
  units: 14,
  countryCode: "AR",
  city: "San Martin de los Andes",
  contactName: "Ana Prueba",
  email: EMAIL,
  locale: "es",
  elapsedMs: 9000,
  interacted: true,
};

async function main() {
  await connectDB();
  await cleanup();
  interceptMailer();
  resetRateLimits();

  console.log("=== 1. El filtro, sin tocar la base ===");
  const bot = screen({
    honeypot: "http://spam.example",
    elapsedMs: 120,
    interacted: false,
    email: "bot@example.com",
    hotelName: "Compra backlinks",
  });
  console.log(`  bot -> score ${bot.score} · drop ${bot.drop} · [${bot.flags.join(", ")}]`);
  if (!bot.drop) throw new Error("el filtro dejo pasar un bot evidente");

  const human = screen({
    honeypot: "",
    elapsedMs: 14000,
    interacted: true,
    email: EMAIL,
    hotelName: FORM.hotelName,
    city: FORM.city,
  });
  console.log(`  persona -> score ${human.score} · drop ${human.drop}`);
  if (human.drop) throw new Error("el filtro descarto un envio normal");

  console.log("\n=== 2. Captura: sale el invite ===");
  const first = await leadsService.capture(FORM, META);
  const lead = await Lead.findOne({ email: EMAIL }).lean();
  console.log(
    `  ${first} · lead ${lead?.leadId} · estado ${lead?.status} · envios ${lead?.invite?.sentCount}`,
  );
  if (first !== "invited") throw new Error("no emitio el invite");
  if (!lastUrl.includes("/register?inv=")) throw new Error("el enlace no apunta al register");
  if (!lastUrl.includes("utm_medium=invite")) throw new Error("el enlace perdio las UTM");
  const token = tokenOf(lastUrl);
  if (token.length < 40) throw new Error("token demasiado corto");

  console.log("\n=== 3. Reenvio dentro del cooldown ===");
  const again = await leadsService.capture(FORM, META);
  console.log(`  ${again} · correos enviados en total: ${sentCount}`);
  if (again !== "throttled") throw new Error("mando un segundo correo dentro del cooldown");
  if (sentCount !== 1) throw new Error("el cooldown no evito el envio");

  console.log("\n=== 4. Verificacion del token ===");
  const verdict = await leadsService.verifyInvite(token);
  if (!verdict.valid) throw new Error(`el token valido no verifico: ${verdict.reason}`);
  console.log(
    `  valido · ${verdict.lead.hotelName} · ${verdict.lead.email} · vence ${verdict.expiresAt.toISOString().slice(0, 10)}`,
  );
  const opened = await Lead.findOne({ email: EMAIL }).lean();
  if (opened?.status !== "opened") throw new Error("verificar no marco el lead como abierto");

  console.log("\n=== 5. Un token no vale para otro correo ===");
  const wrong = await leadsService.consumeInvite(token, { email: OTHER_EMAIL });
  console.log(`  ${wrong.ok ? "CANJEADO" : `rechazado (${wrong.reason})`}`);
  if (wrong.ok || wrong.reason !== "email_mismatch") {
    throw new Error("acepto canjear el invite con otra direccion");
  }

  console.log("\n=== 6. Canje ===");
  const used = await leadsService.consumeInvite(token, {
    email: EMAIL,
    userId: "user-smoke",
    ip: META.ip,
  });
  if (!used.ok) throw new Error(`no pudo canjear: ${used.reason}`);
  const registered = await Lead.findOne({ email: EMAIL }).lean();
  console.log(`  ok · estado ${registered?.status} · usuario ${registered?.registeredUserId}`);
  if (registered?.status !== "registered") throw new Error("el lead no quedo registrado");

  console.log("\n=== 7. Un solo uso ===");
  const reuse = await leadsService.consumeInvite(token, { email: EMAIL });
  console.log(`  ${reuse.ok ? "CANJEADO OTRA VEZ" : `rechazado (${reuse.reason})`}`);
  if (reuse.ok) throw new Error("el token se pudo usar dos veces");

  const reverify = await leadsService.verifyInvite(token);
  if (reverify.valid) throw new Error("un token quemado sigue verificando");
  console.log(`  y ya no verifica (${reverify.reason})`);

  console.log("\n=== 8. Quien ya tiene cuenta no recibe otro invite ===");
  const known = await leadsService.capture(FORM, META);
  console.log(`  ${known} · avisos de cuenta existente: ${existingNotices}`);
  if (known !== "already_registered") throw new Error("volvio a emitir un invite");
  if (sentCount !== 1) throw new Error("mando un invite a alguien que ya tiene cuenta");

  console.log("\n=== 9. El bot llega a la base como spam, sin correo ===");
  const dropped = await leadsService.capture(
    { ...FORM, email: `bot@${DOMAIN}`, hotelName: "Compra backlinks baratos", elapsedMs: 90 },
    META,
  );
  const spam = await Lead.findOne({ email: `bot@${DOMAIN}` }).lean();
  console.log(
    `  ${dropped} · estado ${spam?.status} · flags [${(spam?.screening?.flags ?? []).join(", ")}]`,
  );
  if (dropped !== "dropped" || spam?.status !== "spam") throw new Error("el bot no quedo como spam");
  if (sentCount !== 1) throw new Error("le mando un correo a un bot");

  console.log("\n=== 10. Agregados del panel ===");
  const stats = await leadsService.stats(30);
  console.log(
    `  ${stats.totals.real} reales · ${stats.totals.registered} con cuenta · ` +
      `${stats.totals.spam} spam · conversion ${(stats.totals.conversion * 100).toFixed(1)}%`,
  );

  await cleanup();
  console.log("\nTodo bien. Base limpia.");
}

main()
  .catch((err) => {
    console.error("\nFALLO:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
