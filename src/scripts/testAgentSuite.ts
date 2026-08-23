/* eslint-disable @typescript-eslint/no-explicit-any */
// Bateria EXHAUSTIVA con el agente real (LLM, via HTTP :8600). Corre tareas
// operativas sobre reservas, categorias, habitaciones y propiedades, y marca
// FALLO si el agente deflexiona ("no encontre / no disponible / registrar
// pedido") o si todas sus tools fallan. Una sola sesion (memoria continua).
import "dotenv/config";
import { connectDB } from "../shared/db";
import mongoose from "mongoose";
import { AgentDefinition } from "../modules/agents/agents.model";
import { devUserToken } from "./devUserToken";

const BASE = (process.env.E2E_API ?? "http://localhost:8600/api/v1") + "/conversations/sessions";
const SECRET = process.env.PMS_INTERNAL_SECRET!;
const CTX = {
  userId: "user-a0d6653c-0397-4ed9-82aa-ea4729ebd05a",
  companyId: "elippser-bd8cd057-c7d9-42ac-8745-72195f5808b8",
  propertyId: "prop-59f127d5-271c-4e24-b025-94d848495482",
  userRole: "admin",
  channel: "pms_app",
};

// Frases que delatan deflexion REAL (no disponible / no encontre / registrar
// pedido). Evitamos "no disponible" generico (es lenguaje valido de estados de
// habitacion) y solo contamos como fallo si ademas el agente NO devolvio datos.
const DEFLECT =
  /no\s+encontr[eé]|no\s+exist[ei]|no\s+disponible\s+todav|no\s+est[aá]\s+disponible\s+(todav|en\s+la\s+plataforma)|registr[ae]r?\s+(este\s+|el\s+|tu\s+)?pedido|error\s+temporal|funcionalidad.*no\s+est[aá]\s+disponible/i;

const QUERIES: { id: string; q: string; needData?: boolean }[] = [
  { id: "R1-ultima", q: "¿Cuál es la última reserva registrada?", needData: true },
  { id: "R2-esteban", q: "Mostrame la reserva de Esteban Mulic", needData: true },
  { id: "R3-michelo", q: "Buscá las reservas de Michelo Bamma", needData: true },
  { id: "R4-confirmadas", q: "Listame las reservas confirmadas", needData: true },
  { id: "R5-canceladas", q: "¿Cuántas reservas canceladas hay?", needData: true },
  { id: "C1-categorias", q: "¿Qué categorías de habitación tenemos?", needData: true },
  { id: "C2-premium", q: "Mostrame el detalle de la categoría Premium", needData: true },
  { id: "H1-estado", q: "¿Cuál es el estado de las habitaciones?", needData: true },
  { id: "H2-disponibles", q: "¿Cuántas habitaciones disponibles hay ahora?", needData: true },
  { id: "P1-propiedades", q: "¿Qué propiedades tiene el hotel?", needData: true },
];

let pass = 0;
let fail = 0;
const failed: string[] = [];

// Token del usuario del contexto: las rutas /sessions/:id exigen identidad
// verificada del hotelero, no solo el secret de servicio.
const USER_TOKEN = devUserToken(CTX.userId);

async function req(m: string, p: string, b?: any) {
  const res = await fetch(`${BASE}${p}`, {
    method: m,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
      "X-Pms-User-Token": USER_TOKEN,
    },
    body: b ? JSON.stringify(b) : undefined,
  });
  const t = await res.text();
  let j: any;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}

async function main() {
  await connectDB();
  const agent = await AgentDefinition.findOne({ slug: "asistente-de-operaciones" });
  await mongoose.disconnect();
  if (!agent) { console.error("agente no encontrado"); process.exit(1); }

  const s = await req("POST", "/", { agentId: agent.agentId, context: CTX });
  const sid = s.body?.sessionId;
  if (!sid) { console.error("no se pudo crear sesion", s.status); process.exit(1); }
  console.log(`Sesion ${sid} · agente ${agent.agentId} · ${agent.enabledToolIds?.length} tools\n`);

  for (const { id, q, needData } of QUERIES) {
    const m = await req("POST", `/${sid}/messages`, { content: q });
    const content = String(m.body?.message?.content ?? "");
    const tools = (m.body?.message?.agentMeta?.toolsExecuted ?? []) as any[];
    const toolNames = tools.map((t) => `${t.toolName}:${t.outcome}`);
    const anyToolOk = tools.some((t) => t.outcome === "success");
    const allToolErr = tools.length > 0 && tools.every((t) => t.outcome === "error");

    // Solo cuenta como deflexion-fallo si ademas NO devolvio datos (si llamo
    // una tool de datos con exito, la respuesta es valida aunque mencione "no").
    const deflected = DEFLECT.test(content) && !anyToolOk;
    const ok = m.status === 200 && !deflected && !allToolErr && (!needData || anyToolOk);

    if (ok) { pass++; console.log(`✓ ${id}`); }
    else {
      fail++;
      const why = deflected ? "DEFLEXIONÓ" : allToolErr ? "todas las tools fallaron" : !anyToolOk ? "no usó tools de datos" : `status ${m.status}`;
      console.log(`✗ ${id} — ${why}`);
      failed.push(`${id}: ${why}`);
    }
    console.log(`    > ${q}`);
    console.log(`    < ${content.slice(0, 180).replace(/\n/g, " ")}`);
    console.log(`    tools: ${toolNames.join(", ") || "(ninguna)"}`);
  }

  console.log(`\n===== ${pass} OK / ${fail} FAIL =====`);
  if (failed.length) { console.log("FALLOS:"); failed.forEach((f) => console.log("  - " + f)); }
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crash:", e); process.exit(1); });
