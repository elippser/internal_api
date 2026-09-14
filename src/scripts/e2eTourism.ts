/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * E2E del estado turístico: una pregunta real, por el camino real, con el modelo.
 *
 *   npm run e2e:tourism -- <propertyId> <userId> <companyId> ["mensaje"]
 *
 * GASTA TOKENS (pocos: el perfil turístico va sin tools y en el tier barato).
 * Corre contra internal-api levantado (por defecto :8600) y hace lo mismo que el
 * chat del PMS: crea la sesión, manda el mensaje y lee la respuesta.
 *
 * Verifica lo que ningún test sin modelo puede verificar:
 *   - que el router mande la pregunta al perfil turístico (no a la web);
 *   - que la tarjeta llegue en `toolsExecuted` como `estado_turistico`;
 *   - que el modelo interprete en pocas líneas en vez de repetir las cifras.
 */
import "dotenv/config";
import { devUserToken } from "./devUserToken";

const API = process.env.E2E_API ?? "http://localhost:8600/api/v1";
const SECRET = process.env.PMS_INTERNAL_SECRET ?? "";

const [propertyId, userId, companyId, custom] = process.argv.slice(2);
const MESSAGE = custom ?? "¿Hay algo grande pasando cerca este fin de semana?";

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
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
    console.error('Uso: npm run e2e:tourism -- <propertyId> <userId> <companyId> ["mensaje"]');
    process.exit(1);
  }
  console.log(`Mensaje: "${MESSAGE}"\n`);

  const session = await req("POST", "/conversations/sessions", {
    agentId: process.env.OPS_AGENT_ID ?? "asistente-de-operaciones",
    context: { userId, companyId, propertyId, channel: "pms_app" },
  });
  if (session.status !== 200 && session.status !== 201) {
    console.error("✗ No se pudo crear la sesión:", session.status, session.json);
    process.exit(1);
  }
  const sessionId = session.json?.data?.sessionId ?? session.json?.sessionId ?? session.json?.data?.id;

  const t0 = Date.now();
  const turn = await req("POST", `/conversations/sessions/${sessionId}/messages`, { content: MESSAGE });
  const ms = Date.now() - t0;
  if (turn.status !== 200 && turn.status !== 201) {
    console.error("✗ El turno falló:", turn.status, JSON.stringify(turn.json).slice(0, 600));
    process.exit(1);
  }

  const msg = turn.json?.data?.message ?? turn.json?.message ?? turn.json?.data ?? turn.json;
  const meta = msg?.agentMeta ?? {};
  const content = String(msg?.content ?? "");
  let problems = 0;
  const bad = (m: string) => {
    problems++;
    console.log(`  ✗ ${m}`);
  };

  console.log(`Tardó ${(ms / 1000).toFixed(1)} s · modelo ${meta.modelUsed} · sub-agente ${meta.subAgent}`);
  console.log(`Tokens: ${meta.inputTokens} entrada + ${meta.cacheReadInputTokens ?? 0} de caché · ${meta.outputTokens} salida`);

  console.log("\n── Verificaciones ──");
  const tourism = meta.tourism;
  if (!tourism) bad("el turno no registró estado turístico (agentMeta.tourism vacío)");
  else {
    console.log(`  ✓ estado turístico (${tourism.mode}) en ${tourism.prepMs} ms · ubicación: ${tourism.locationSource || "—"}`);
    if (tourism.hubsCold?.length) console.log(`    leídos en el turno: ${tourism.hubsCold.join(", ")}`);
    if (tourism.missing?.length) console.log(`    sin datos: ${tourism.missing.join("; ")}`);
    if (tourism.failure) console.log(`    falla: ${tourism.failure}`);
    if (tourism.mode !== "profile") bad(`se esperaba el perfil turístico y fue "${tourism.mode}"`);
  }

  const executed = meta.toolsExecuted ?? [];
  const card = executed.find((t: any) => t.toolName === "estado_turistico")?.result;
  if (!card) {
    if (!tourism?.failure) bad("no llegó la tarjeta (estado_turistico) en toolsExecuted");
  } else {
    console.log(`  ✓ tarjeta "${card.title}" con ${card.metrics.length} métricas · confianza ${card.confidence}`);
    for (const m of card.metrics) console.log(`    ${m.label}: ${m.value} [${m.confidence}]${m.hint ? ` — ${m.hint}` : ""}`);
    const repeated = card.metrics.filter((m: any) => m.value.length > 3 && content.includes(m.value));
    if (repeated.length > 1) bad(`la respuesta repite ${repeated.length} cifras de la tarjeta`);
  }
  if (executed.some((t: any) => /web_search/.test(t.toolName)) || (meta.webSources ?? []).length) {
    bad("el turno buscó en la web");
  }
  if (content.length > 700) bad(`la respuesta tiene ${content.length} caracteres: debería ser 2-4 líneas`);

  console.log(`\n── Respuesta ──\n${content}\n`);
  console.log(problems === 0 ? "✓ El estado turístico funciona de punta a punta." : `✗ ${problems} problema(s).`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
