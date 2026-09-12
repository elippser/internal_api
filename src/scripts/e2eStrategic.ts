/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * E2E del turno estratégico: un pedido real, por el camino real, con el modelo.
 *
 *   npm run e2e:strategic -- <propertyId> <userId> <companyId> ["mensaje"]
 *
 * GASTA TOKENS. Corre contra internal-api levantado (por defecto :8600) y hace
 * exactamente lo que hace el chat del PMS: crea la sesión, manda el mensaje y
 * lee la respuesta con su traza.
 *
 * Lo que verifica, y que ningún test sin modelo puede verificar:
 *   - que el router mande el mensaje al turno estratégico;
 *   - que el modelo entregue el plan en vez de escribir consejos sueltos;
 *   - que los pasos del plan pasen la validación (ninguno descartado);
 *   - que la respuesta cite números de la foto en vez de generalidades.
 */
import "dotenv/config";
import { devUserToken } from "./devUserToken";

const API = process.env.E2E_API ?? "http://localhost:8600/api/v1";
const BASE = API + "/conversations";
const SECRET = process.env.PMS_INTERNAL_SECRET ?? "";

const [propertyId, userId, companyId, custom] = process.argv.slice(2);
const MESSAGE =
  custom ?? "Como puedo aumentar mi ocupacion? recien entro, no entiendo nada";

async function req(method: string, path: string, body?: unknown) {
  const url = path.startsWith("/growth") ? `${API}${path}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
      "X-Pms-User-Token": devUserToken(userId),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

async function main() {
  if (!propertyId || !userId || !companyId) {
    console.error(
      'Uso: npm run e2e:strategic -- <propertyId> <userId> <companyId> ["mensaje"]',
    );
    process.exit(1);
  }

  console.log(`Mensaje: "${MESSAGE}"\n`);

  const session = await req("POST", "/sessions", {
    agentId: process.env.OPS_AGENT_ID ?? "asistente-de-operaciones",
    context: { userId, companyId, propertyId, channel: "pms_app" },
  });
  if (session.status !== 200 && session.status !== 201) {
    console.error("✗ No se pudo crear la sesión:", session.status, session.json);
    process.exit(1);
  }
  const sessionId =
    session.json?.data?.sessionId ?? session.json?.sessionId ?? session.json?.data?.id;
  console.log(`Sesión: ${sessionId}`);

  // Plan activo ANTES del turno: cambia qué es la respuesta correcta.
  const before = await req("GET", `/growth/plans?propertyId=${encodeURIComponent(propertyId)}`);
  const planBefore = before.json?.data ?? null;
  if (planBefore) {
    console.log(`Plan activo previo: ${planBefore.planId} (${planBefore.steps?.length} pasos)`);
  }

  const t0 = Date.now();
  const turn = await req("POST", `/sessions/${sessionId}/messages`, {
    content: MESSAGE,
  });
  const ms = Date.now() - t0;

  if (turn.status !== 200 && turn.status !== 201) {
    console.error("✗ El turno falló:", turn.status, JSON.stringify(turn.json).slice(0, 600));
    process.exit(1);
  }

  const msg = turn.json?.data?.message ?? turn.json?.message ?? turn.json?.data ?? turn.json;
  if (process.env.E2E_RAW) console.log(JSON.stringify(turn.json).slice(0, 1200));
  const meta = msg?.agentMeta ?? {};
  const strategic = meta.strategic;

  console.log(`\n${"─".repeat(72)}`);
  console.log(`Tardó ${(ms / 1000).toFixed(1)} s · modelo ${meta.modelUsed} · sub-agente ${meta.subAgent}`);
  console.log(
    `Tokens: ${meta.inputTokens} entrada + ${meta.cacheReadInputTokens ?? 0} de caché · ${meta.outputTokens} salida`,
  );
  console.log(`stopReason: ${meta.stopReason}`);

  const content0 = String(msg?.content ?? "");

  let problems = 0;
  const bad = (m: string) => {
    problems++;
    console.log(`  ✗ ${m}`);
  };

  console.log(`\n── Verificaciones ──`);
  if (!strategic) {
    bad("el turno NO se armó como estratégico (agentMeta.strategic vacío)");
  } else {
    console.log(`  ✓ turno estratégico`);
    console.log(
      `    foto en ${strategic.snapshotMs} ms · playbooks: ${(strategic.playbookIds ?? []).join(", ") || "(ninguno)"} · ${strategic.leverCount} palancas`,
    );
    if ((strategic.missing ?? []).length) {
      console.log(`    sin datos: ${strategic.missing.join(", ")}`);
    }
    // Con un plan ACTIVO el turno correcto NO es proponer otro: es retomar el
    // que hay. Esperar un plan nuevo siempre haría fallar el segundo E2E
    // seguido y empujaría a "arreglar" un comportamiento que está bien.
    if (strategic.planId) {
      console.log(`  ✓ plan ${strategic.planId} con ${strategic.stepsProposed} pasos`);
    } else if (planBefore) {
      console.log(
        `  ✓ no propuso plan nuevo: ya había uno activo (${planBefore.planId}), y lo retomó`,
      );
      const mentions = /paso|plan/i.test(content0);
      if (!mentions) bad("hay un plan activo pero la respuesta no lo menciona");
    } else {
      bad("no se entregó ningún plan y no había uno activo");
    }
    if (strategic.stepsDropped > 0) {
      bad(`${strategic.stepsDropped} paso(s) descartados por la validación`);
    }
    if (strategic.forced) {
      console.log("  ⚠ hubo que FORZAR la entrega del plan (el modelo no lo hizo solo)");
    }
  }

  console.log(`  tools ejecutadas:`);
  for (const t of meta.toolsExecuted ?? []) {
    console.log(`    ${t.outcome === "success" ? "ok" : "ERROR"} ${t.toolName}` + (t.errorMessage ? ` — ${t.errorMessage}` : ""));
    if (t.toolName === "propose_growth_plan" && t.outcome !== "success") {
      if (t.inputArgs) console.log(`      args: ${JSON.stringify(t.inputArgs).slice(0, 900)}`);
    }
  }

  const content = content0;
  const numbers = (content.match(/\d+([.,]\d+)?%?/g) ?? []).length;
  if (numbers < 2) bad(`la respuesta cita ${numbers} número(s): suena genérica`);
  else console.log(`  ✓ la respuesta cita ${numbers} números`);
  if (content.length > 1200) {
    bad(`la respuesta tiene ${content.length} caracteres: debería cerrar en 1-2 frases`);
  }

  console.log(`\n── Respuesta ──\n${content}\n`);

  const plan = (meta.toolsExecuted ?? []).find(
    (t: any) => t.toolName === "propose_growth_plan",
  );
  if (plan?.result) {
    const r = plan.result as any;
    console.log(`── Plan ──`);
    console.log(`Objetivo: ${r.goal} · ${r.horizonDays} días`);
    console.log(`Diagnóstico: ${r.diagnosis}`);
    console.log(`Evidencia:`);
    for (const e of r.evidence ?? []) console.log(`  · ${e}`);
    console.log(`Pasos:`);
    for (const s of r.steps ?? []) {
      console.log(
        `  ${s.n}. [${s.priority}/${s.effort}] ${s.title}  (${s.tool})` +
          (s.confirmationLevel !== "none" ? ` · confirma: ${s.confirmationLevel}` : ""),
      );
      if (s.reason) console.log(`     ${s.reason}`);
    }
  }

  console.log(
    problems === 0
      ? "\n✓ El turno estratégico funciona de punta a punta."
      : `\n✗ ${problems} problema(s).`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
