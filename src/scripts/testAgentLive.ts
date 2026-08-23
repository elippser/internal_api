/* eslint-disable @typescript-eslint/no-explicit-any */
// Test REAL a traves del agente (Claude) contra el servicio en vivo :8600.
// Replica lo que hace el chat del PMS: crea sesion con contexto real y manda
// mensajes. Muestra que tools llamo el agente, con que resultado, y la respuesta.
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { AgentDefinition } from "../modules/agents/agents.model";
import { devUserToken } from "./devUserToken";

const BASE = (process.env.E2E_API ?? "http://localhost:8600/api/v1") + "/conversations/sessions";
const SECRET = process.env.PMS_INTERNAL_SECRET!;

// Contexto real: Diplomatic Hotel (17 units), usuario admin con membership.
const CONTEXT = {
  userId: "user-a0d6653c-0397-4ed9-82aa-ea4729ebd05a",
  companyId: "elippser-bd8cd057-c7d9-42ac-8745-72195f5808b8",
  propertyId: "prop-59f127d5-271c-4e24-b025-94d848495482",
  userRole: "admin",
  channel: "pms_app",
};

// Tambien probamos SIN propertyId (caso real: la sesion no trae propiedad)
const CONTEXT_NO_PROP = { ...CONTEXT, propertyId: undefined };

// Token del usuario del contexto: las rutas /sessions/:id exigen identidad
// verificada del hotelero, no solo el secret de servicio.
const USER_TOKEN = devUserToken(CONTEXT.userId);

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
      "X-Pms-User-Token": USER_TOKEN,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

function dumpMeta(meta: any) {
  if (!meta) { console.log("    (sin agentMeta)"); return; }
  const tools = (meta.toolsExecuted as any[]) ?? [];
  console.log(`    model=${meta.modelUsed} tokens=${meta.inputTokens}/${meta.outputTokens} iter=${meta.iterations ?? "?"}`);
  if (!tools.length) { console.log("    tools: NINGUNA"); return; }
  for (const t of tools) {
    const out = t.outcome ?? t.status;
    const detail = t.error ? ` ERROR=${JSON.stringify(t.error).slice(0, 200)}` :
      (t.resultSummary ? ` ${String(t.resultSummary).slice(0, 120)}` :
       (t.result ? ` ${JSON.stringify(t.result).slice(0, 120)}` : ""));
    console.log(`    · ${t.toolName}(${JSON.stringify(t.args ?? t.input ?? {}).slice(0, 120)}) → ${out}${detail}`);
  }
}

async function runScenario(label: string, context: any, message: string, agentId: string) {
  console.log(`\n========== ${label} ==========`);
  console.log(`context.propertyId=${context.propertyId ?? "(vacio)"}`);
  const sess = await req("POST", "/", { agentId, context });
  if (sess.status !== 201 || !sess.body?.sessionId) {
    console.log(`  ✗ createSession status=${sess.status} body=${JSON.stringify(sess.body).slice(0, 300)}`);
    return;
  }
  const sid = sess.body.sessionId;
  console.log(`  sesion=${sid}`);
  // Mostrar el contexto enriquecido que quedo guardado
  if (sess.body.context) {
    const c = sess.body.context;
    console.log(`  ctx enriquecido: company=${c.companyId} property=${c.propertyId ?? "(vacio)"} role=${c.userRole} propName=${c.propertyName ?? "-"}`);
  }
  console.log(`  > "${message}"`);
  const msg = await req("POST", `/${sid}/messages`, { content: message });
  if (msg.status !== 200) {
    console.log(`  ✗ postMessage status=${msg.status} body=${JSON.stringify(msg.body).slice(0, 400)}`);
    return;
  }
  console.log(`  < "${String(msg.body?.message?.content ?? "").slice(0, 400).replace(/\n/g, " ")}"`);
  dumpMeta(msg.body?.message?.agentMeta);
}

async function main() {
  await connectDB();
  const agent = await AgentDefinition.findOne({ slug: "asistente-de-operaciones" });
  if (!agent) { console.error("agente no encontrado"); process.exit(1); }
  const agentId = agent.agentId;
  console.log(`agente=${agentId} tools=${agent.enabledToolIds?.length}`);
  await mongoose.disconnect();

  await runScenario("A) Con propertyId correcto (Diplomatic)", CONTEXT, "Mostrame el estado de las habitaciones del hotel.", agentId);
  await runScenario("B) Sin propertyId (sesion sin propiedad activa)", CONTEXT_NO_PROP, "Mostrame el estado de las habitaciones.", agentId);
  // C) Usuario scabral@pxsol.com: editor, SIN activeCompanyId ni membership.
  await runScenario(
    "C) Usuario sin company (scabral@pxsol.com)",
    { userId: "user-c0f04c25-cd54-466f-b7ab-2784205e8903", channel: "pms_app" },
    "Mostrame el estado de las habitaciones.",
    agentId,
  );
  // D) Company 24274288 + propiedad cuyos units estan stampeados con OTRA company.
  await runScenario(
    "D) Company 24274288, units huerfanos (prop-fd17f26c)",
    {
      userId: "user-12878efb-d7f0-41c9-81ce-591049ec6951",
      companyId: "elippser-24274288-e767-4965-91e3-9753c7fe7ca0",
      propertyId: "prop-fd17f26c-c78a-4638-b4f7-e4075e4fc039",
      userRole: "owner",
      channel: "pms_app",
    },
    "Mostrame el estado de las habitaciones.",
    agentId,
  );

  // E) Web builder: el agente debe entender Proyecto > Sitio y llamar las tools
  // que rinden tarjetas (list_site_projects / get_site_project / get_site).
  await runScenario(
    "E) Web builder (proyectos/sitios/dominios)",
    CONTEXT,
    "Mostrame mis proyectos web y sus sitios con los dominios.",
    agentId,
  );

  // F) Email de avisos: el agente NO debe desviar a "no disponible / registrar
  // pedido" — debe usar get_engine_settings (hotelNotificationEmail). Ya no hay
  // SMTP por hotel: no debe pedir servidor/usuario/app password.
  // (Solo lectura, no sobrescribimos.)
  await runScenario(
    "F) Email de avisos del hotel (NO debe deflexionar)",
    CONTEXT,
    "Quiero que el hotel envie emails de confirmacion a los huespedes. Esta configurado el email del hotel? Revisalo.",
    agentId,
  );

  process.exit(0);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
