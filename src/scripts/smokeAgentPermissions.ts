/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smoke E2E de PERMISOS del agente contra el internal corriendo (:8600) con la
 * identidad REAL de un usuario del PMS. Gasta tokens (un turno de Sonnet por
 * mensaje): es opt-in, no corre en CI.
 *
 *   npm run smoke:agent-permissions -- <userId> <companyId> <propertyId> "<mensaje>"
 *   npm run smoke:agent-permissions -- <userId> <companyId> <propertyId> --action <toolName> '<argsJson>'
 *
 * Firma un app_token con el JWT_SECRET de pms-core/api/.env (cargado con
 * dotenv.parse: el valor real tiene un `#` sin comillas, ver memoria
 * jwt-secret-hash-truncation), crea una sesión y manda el mensaje (o dispara
 * una acción de card). Imprime tools ejecutadas, traza y respuesta.
 *
 * Casos útiles:
 *   - staff sin company.settings: "Cambiale el nombre a la empresa" → debe
 *     explicar la capability faltante sin llamar ninguna tool.
 *   - staff con todas-reservas: "busca la reserva de garcia" → search_reservations.
 *   - --action accept_rate_recommendation con revenue:operate → 403 con mensaje.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

const argv = process.argv.slice(2);
const [userId, companyId, propertyId] = argv;
const isAction = argv[3] === "--action";
const message = isAction ? "" : argv.slice(3).join(" ");
const actionTool = isAction ? argv[4] : "";
const actionArgs = isAction ? JSON.parse(argv[5] || "{}") : {};

if (!userId || !companyId || !propertyId || (!message && !actionTool)) {
  console.error("uso: <userId> <companyId> <propertyId> \"<mensaje>\" | --action <toolName> '<argsJson>'");
  process.exit(1);
}

const pmsEnv = dotenv.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../pms-core/api/.env")),
);
const token = jwt.sign({ userId, companyId }, pmsEnv.JWT_SECRET, { expiresIn: "10m" });
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8600}/api/v1`;
const SECRET = process.env.PMS_INTERNAL_SECRET ?? "";
const headers = { "Content-Type": "application/json", "X-Internal-Secret": SECRET };

async function main() {
  const agent = (await (
    await fetch(`${BASE}/agents/runtime/by-slug/asistente-de-operaciones`, { headers })
  ).json()) as any;
  console.log("agent:", agent.agentId, agent.status);
  const sessRes = await fetch(`${BASE}/conversations/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId: agent.agentId,
      context: { channel: "pms_app", token, companyId, propertyId },
    }),
  });
  const sess = (await sessRes.json()) as any;
  console.log("session:", sessRes.status, sess.sessionId ?? sess);
  if (!sess.sessionId) process.exit(1);

  if (isAction) {
    const res = await fetch(`${BASE}/conversations/sessions/${sess.sessionId}/actions`, {
      method: "POST",
      headers: { ...headers, "X-Pms-User-Token": token },
      body: JSON.stringify({ toolName: actionTool, args: actionArgs }),
    });
    console.log(res.status, JSON.stringify(await res.json()).slice(0, 800));
    return;
  }

  const t0 = Date.now();
  const msgRes = await fetch(`${BASE}/conversations/sessions/${sess.sessionId}/messages`, {
    method: "POST",
    headers: { ...headers, "X-Pms-User-Token": token },
    body: JSON.stringify({ content: message }),
  });
  const out = (await msgRes.json()) as any;
  const m = out.message ?? out;
  console.log(`\n[${msgRes.status} · ${Date.now() - t0}ms · ${m.agentMeta?.modelUsed} · ${m.agentMeta?.subAgent}]`);
  console.log(
    "TOOLS:",
    (m.agentMeta?.toolsExecuted ?? [])
      .map((t: any) => `${t.toolName}=${t.outcome}${t.errorMessage ? ` (${t.errorMessage})` : ""}`)
      .join(" | ") || "(ninguna)",
  );
  console.log("TRACE:", JSON.stringify(m.agentMeta?.trace ?? []).slice(0, 600));
  console.log("\nRESPUESTA:\n" + (m.content ?? JSON.stringify(out)));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
