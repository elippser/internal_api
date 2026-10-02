/**
 * Smoke de U6 (USABILIDAD-SPEC.md §6): etiquetado de lo que le preguntan a la IA.
 * Mongo EN MEMORIA. Si hay OPENROUTER_API_KEY, hace UNA corrida real con el
 * modelo barato sobre 8 conversaciones sinteticas (fracciones de centavo).
 *
 *   npm run smoke:usability-ia
 */
import "dotenv/config";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ConversationMessage, ConversationSession } from "../modules/conversations/conversations.model";
import { iaOverview, iaQuestions, questionKey } from "../modules/usability/ia.service";
import { IaMessageLabel } from "../modules/usability/iaLabels.model";
import { detectLang, runIaLabeling, scrub, similarity } from "../modules/usability/iaLabeler.service";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

let n = 0;
const t0 = Date.now() - 3 * 3600_000;
async function convo(sessionId: string, turns: Array<{ user: string; reply: string; tools?: Array<[string, string]>; vote?: "up" | "down"; atSec: number }>) {
  await ConversationSession.create({
    sessionId,
    agentId: "agent-smoke",
    context: { companyId: "co-smoke", userId: `u-${sessionId}`, channel: "pms_app" },
  });
  for (const t of turns) {
    const at = new Date(t0 + t.atSec * 1000);
    await ConversationMessage.create({ messageId: `m${++n}`, sessionId, agentId: "agent-smoke", role: "user", content: t.user, createdAt: at });
    await ConversationMessage.create({
      messageId: `m${++n}`,
      sessionId,
      agentId: "agent-smoke",
      role: "assistant",
      content: t.reply,
      createdAt: new Date(at.getTime() + 4000),
      agentMeta: {
        toolsExecuted: (t.tools ?? []).map(([toolName, outcome]) => ({ toolId: toolName, toolName, outcome })),
      },
      ...(t.vote ? { feedback: { rating: t.vote } } : {}),
    });
  }
}

async function main() {
  // ── Utilidades puras ─────────────────────────────────────────────────────
  check("idioma es", detectLang("como cambio la tarifa de un fin de semana") === "es");
  check("idioma en", detectLang("how do I change the rate for the weekend") === "en");
  check("similitud alta entre reformulaciones", similarity("cuantas reservas tengo hoy", "cuantas reservas tengo para hoy?") >= 0.6);
  check("similitud baja entre preguntas distintas", similarity("cuantas reservas tengo hoy", "como subo fotos al sitio") < 0.3);
  const scrubbed = scrub("llamar a juan@hotel.com o al +54 381 555-1234 por la reserva 98765 codigo AB-12345");
  check("scrub tapa correo, telefono, numero y codigo", !/@|381|98765|12345/.test(scrubbed), scrubbed);
  check("clave de grupo ignora orden y relleno", questionKey("como cambio la tarifa del finde") === questionKey("cambio tarifa finde, como?"));

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  await convo("s1", [
    { user: "cuantas reservas tengo para hoy?", reply: "Tenes 4 reservas que entran hoy.", tools: [["list_reservations", "success"]], vote: "up", atSec: 0 },
  ]);
  await convo("s2", [
    { user: "cambiame la tarifa del sabado a 50000", reply: "No pude actualizar la tarifa.", tools: [["update_rate", "error"]], atSec: 0 },
    { user: "cambiame la tarifa del sabado a 50000 por favor", reply: "Sigue fallando, proba desde Tarifas.", tools: [["update_rate", "error"]], vote: "down", atSec: 40 },
  ]);
  await convo("s3", [
    { user: "como publico mi sitio web?", reply: "Anda a Sitios, abri el proyecto y toca Publicar.", atSec: 0 },
    { user: "gracias!", reply: "De nada.", atSec: 30 },
  ]);
  await convo("s4", [
    { user: "podes mandarle un whatsapp al huesped Juan Perez de la reserva 4471?", reply: "Por ahora no puedo enviar mensajes de WhatsApp.", atSec: 0 },
    { user: "que mal, eso deberia poder hacerlo", reply: "Entiendo, lo dejo anotado.", atSec: 60 },
  ]);
  await convo("s5", [{ user: "how many rooms are available next weekend?", reply: "You have 6 rooms available.", tools: [["check_availability", "success"]], atSec: 0 }]);

  // ── 1. Solo señales (sin modelo) ─────────────────────────────────────────
  const r1 = await runIaLabeling({ llm: false });
  check("sin modelo: 8 mensajes con señales, 0 etiquetados", r1.scanned === 8 && r1.signalsOnly === 8 && r1.labeled === 0, r1);
  const re = await IaMessageLabel.findOne({ sessionId: "s2", rephrase: true }).lean();
  check("reformulacion detectada (s2, 40 s despues)", Boolean(re), re);
  const s2first = await IaMessageLabel.find({ sessionId: "s2" }).sort({ hourUtc: 1 }).lean();
  check("herramienta con error contada", s2first.every((x) => x.toolErrors === 1), s2first.map((x) => x.toolErrors));
  const up = await IaMessageLabel.findOne({ sessionId: "s1" }).lean();
  check("voto 👍 asociado a la pregunta", up?.vote === "up", up?.vote);
  const en = await IaMessageLabel.findOne({ sessionId: "s5" }).lean();
  check("idioma en detectado", en?.lang === "en", en?.lang);
  check("ningun label guarda el texto original", !(await IaMessageLabel.find().lean()).some((x) => JSON.stringify(x).includes("Juan Perez")));

  // ── 2. Corrida real con el modelo barato ──────────────────────────────────
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY) {
    const r2 = await runIaLabeling({ budgetUsd: 0.05, maxMessages: 50 });
    console.log("   corrida real:", JSON.stringify(r2));
    check("modelo: etiqueta los 8 mensajes", r2.labeled === 8, r2);
    check("modelo: costo bajo el tope", r2.costUsd <= 0.05, r2.costUsd);
    const all = await IaMessageLabel.find().lean();
    for (const l of all) console.log(`   [${l.topic}/${l.intent}/${l.resolved}/f${l.frustration}] ${l.question}${l.missingCapability ? `  ⟶ falta: ${l.missingCapability}` : ""}`);
    const wa = all.find((x) => x.sessionId === "s4" && x.missingCapability);
    check("modelo: detecta la capacidad faltante (WhatsApp)", Boolean(wa), all.filter((x) => x.sessionId === "s4"));
    check("pregunta normalizada sin nombre ni numero de reserva", !all.some((x) => /juan|perez|4471|50000/i.test(`${x.question} ${x.missingCapability}`)), all.map((x) => x.question));
    const fail = all.filter((x) => x.sessionId === "s2");
    check("modelo: la tarifa que fallo no quedo resuelta", fail.some((x) => x.resolved === "no" || x.resolved === "parcial"), fail);
    const r3 = await runIaLabeling({ budgetUsd: 0.05 });
    check("segunda corrida no re-etiqueta (0 mensajes)", r3.scanned === 0, r3);
  } else {
    console.log("   (sin OPENROUTER_API_KEY: se salta la corrida real)");
  }

  // ── Lecturas ─────────────────────────────────────────────────────────────
  const day = new Date(t0).toISOString().slice(0, 10);
  const ov = await iaOverview({ from: day, to: new Date().toISOString().slice(0, 10) });
  check("overview: 8 preguntas, 5 sesiones, mapa 7x24", ov.totals.questions === 8 && ov.totals.sessions === 5 && ov.heat.length === 7 && ov.heat[0].length === 24, ov.totals);
  check("overview: reformulaciones 12,5%", ov.totals.rephrasePct === 12.5, ov.totals.rephrasePct);
  const qs = await iaQuestions({ from: day, to: new Date().toISOString().slice(0, 10) });
  check("preguntas frecuentes agrupadas con link a sesiones", qs.groups.every((g) => g.sessions.length > 0), qs.groups);

  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} FALLAS` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
