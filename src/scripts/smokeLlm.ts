/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prueba de humo de los consumidores de IA del internal contra OpenRouter.
 *
 * Importa los MISMOS modulos que corren en produccion (`routeTurn`, `callJson`,
 * `memoryService`, el cliente compartido) y los llama con la forma real de
 * pedido de cada uno. Lo que se verifica no es que el proveedor conteste, sino
 * que conteste algo que el codigo de arriba sepa leer.
 *
 * Toca la base para leer (el router filtra tools por permisos) y, en el caso de
 * la memoria, escribe y BORRA en un espacio operativo de descarte.
 *
 *   npm run smoke:llm            todo salvo busqueda web
 *   npm run smoke:llm -- --web   suma el radar con web_search (mas lento y caro)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { routeTurn } from "../modules/conversations/services/taskRouter";
import { callJson, draftModel, radarModel } from "../modules/competitors/ciLlm";
import { memoryService } from "../modules/memory/memory.service";
import { resolveTools } from "../modules/conversations/services/toolExecutor";
import { Tool } from "../modules/tools/tools.model";
import { collectSchemaDefects } from "../shared/llm/toolSchema";
import { AgentMemory } from "../modules/memory/memory.model";
import { computeCostUsd, getModelPricing } from "../modules/usage/usage.pricing";
import {
  LLM_MODELS,
  OPENROUTER_SDK_BASE_URL,
  engineModelFor,
  getLlmClient,
  modelFor,
  modelRank,
  serverToolSupport,
  thinkingBlockFor,
} from "../shared/llm/provider";
import { resolveModel } from "../engine/llm/client";

const WITH_WEB = process.argv.includes("--web");

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FALLA"}  ${name.padEnd(38)} ${detail}`);
}

// ── 1. Tarifas: que ningun tier caiga en el fallback ─────────────────────────
// Es puro codigo, sin red, pero es la prueba que atrapa el error mas caro de
// esta migracion: un id sin fila propia se cobra a la tarifa de reserva.
function smokePricing(): void {
  for (const [tier, model] of Object.entries(LLM_MODELS)) {
    const p = getModelPricing(model);
    const qualified = getModelPricing(`openrouter/${model}`);
    report(
      `tarifa · ${tier}`,
      p.inputPerMTok === qualified.inputPerMTok && p.inputPerMTok < 1,
      `in=${p.inputPerMTok} out=${p.outputPerMTok} (id desnudo y cualificado coinciden: ${p.inputPerMTok === qualified.inputPerMTok})`,
    );
  }
  // Un turno tipico del chat: 8k de contexto, 800 de respuesta.
  const antes = computeCostUsd("claude-sonnet-4-6", { inputTokens: 8000, outputTokens: 800 });
  const ahora = computeCostUsd(modelFor("standard"), { inputTokens: 8000, outputTokens: 800 });
  report(
    "tarifa · turno tipico mas barato",
    ahora < antes / 10,
    `antes USD ${antes.toFixed(6)} · ahora USD ${ahora.toFixed(6)} (${(antes / ahora).toFixed(0)}x)`,
  );
}

// ── 2. Orden de los tiers y politica de razonamiento ─────────────────────────
function smokeTiers(): void {
  report(
    "tiers · orden de capacidad",
    modelRank(modelFor("cheap")) < modelRank(modelFor("standard")) &&
      modelRank(modelFor("standard")) < modelRank(modelFor("premium")),
    `cheap=${modelRank(modelFor("cheap"))} standard=${modelRank(modelFor("standard"))} premium=${modelRank(modelFor("premium"))}`,
  );
  report(
    "tiers · razonamiento apagable solo donde corresponde",
    !!thinkingBlockFor(modelFor("cheap"), { enabled: false }) &&
      !thinkingBlockFor(modelFor("standard"), { enabled: false }),
    "cheap acepta thinking:disabled; standard lo rechazaria con 400 y por eso se omite",
  );
  report(
    "tiers · code_execution desactivada",
    serverToolSupport(modelFor("standard")).codeExecution === false &&
      serverToolSupport(modelFor("standard")).webSearch === true,
    "web_search si, code_execution no (400 en el gateway)",
  );
  // El motor guarda los modelos cualificados; si el prefijo no resuelve a un
  // proveedor cableado, el turno muere con 501 antes de llegar a la red.
  try {
    const r = resolveModel(engineModelFor("standard"));
    report("motor · resuelve el id cualificado", r.provider === "openrouter", `provider=${r.provider} model=${r.model}`);
  } catch (err: any) {
    report("motor · resuelve el id cualificado", false, err?.message?.slice(0, 90));
  }
}

// ── 3. Router de tareas (tier barato, clasificador de 1 palabra) ─────────────
async function smokeRouter(): Promise<void> {
  // Mensaje deliberadamente ambiguo: no matchea ninguna heuristica, asi que
  // obliga a que el clasificador LLM decida. Si cayera en "default" no
  // estariamos probando el modelo.
  const ambiguo = await routeTurn({
    userMessage: "che, y con lo del tema ese de ayer como venimos",
    enabledToolIds: [],
  });
  // Se exige `clasificador:` y no se acepta `default`: caer al default es
  // exactamente el sintoma de que el modelo se quedo sin presupuesto pensando y
  // volvio sin texto. Pagabamos el pedido y no clasificabamos nada.
  report(
    "router · el clasificador LLM decide",
    ambiguo.reason.startsWith("clasificador:"),
    `sub-agente=${ambiguo.subAgent.id} motivo=${ambiguo.reason} modelo=${ambiguo.subAgent.model}`,
  );

  const escritura = await routeTurn({
    userMessage: "cancelame la reserva 8842 y avisale al huesped",
    enabledToolIds: [],
  });
  report(
    "router · intencion de escritura va a operativo",
    escritura.subAgent.id === "operativo",
    `sub-agente=${escritura.subAgent.id} motivo=${escritura.reason}`,
  );

  report(
    "router · los sub-agentes apuntan a los tiers nuevos",
    [ambiguo, escritura].every((d) => !/claude/i.test(d.subAgent.model)),
    `modelos: ${[...new Set([ambiguo.subAgent.model, escritura.subAgent.model])].join(", ")}`,
  );
}

// ── 4. Chat operativo: tool loop en shape nativo ─────────────────────────────
// La forma exacta del pedido de conversationRunner: system + tools + streaming
// con deltas en vivo y `finalMessage()` para lo que se persiste.
async function smokeChatToolLoop(): Promise<void> {
  const client = getLlmClient();
  const tools = [
    {
      name: "get_reservation",
      description: "Trae una reserva del PMS por su codigo",
      input_schema: {
        type: "object",
        properties: { code: { type: "string", description: "codigo de reserva" } },
        required: ["code"],
      },
    },
  ];

  const stream = client.messages.stream({
    model: modelFor("standard"),
    max_tokens: 4096,
    system: "Sos el asistente operativo del PMS. SIEMPRE usas las herramientas para leer datos reales.",
    messages: [{ role: "user", content: "Mostrame la reserva RSV-8842" }],
    tools: tools as never,
  } as never);

  // Se lee el consumo del ALAMBRE, igual que conversationRunner: OpenRouter
  // manda `message_start` en cero y los totales en `message_delta`, y el
  // acumulador del SDK 0.27.x se queda con el primero para la entrada. Medir
  // `finalMessage().usage.input_tokens` daria cero y el ledger facturaria de
  // menos; esta suite existe justamente para que eso no pase inadvertido.
  const wire = { input: 0, output: 0 };
  let deltas = 0;
  stream.on("text", () => { deltas++; });
  stream.on("streamEvent", (event: any) => {
    if (event?.type !== "message_start" && event?.type !== "message_delta") return;
    const u = event.usage ?? event.message?.usage;
    if (!u) return;
    wire.input = Math.max(wire.input, typeof u.input_tokens === "number" ? u.input_tokens : 0);
    wire.output = Math.max(wire.output, typeof u.output_tokens === "number" ? u.output_tokens : 0);
  });
  const final: any = await stream.finalMessage();

  const toolUse = (final.content as any[]).find((b) => b.type === "tool_use");
  report(
    "chat · emite tool_use",
    toolUse?.name === "get_reservation" && String(toolUse?.input?.code ?? "").includes("8842"),
    toolUse ? `${toolUse.name}(${JSON.stringify(toolUse.input)}) stop=${final.stop_reason}` : `sin tool_use, bloques=[${(final.content as any[]).map((b) => b.type).join("+")}]`,
  );
  // Misma resolución que el runner: el mensaje final manda si trae algo, y si
  // no, vale lo leído del stream.
  const inTokens = (final.usage?.input_tokens || wire.input) as number;
  const outTokens = (final.usage?.output_tokens || wire.output) as number;
  report(
    "chat · consumo del turno",
    inTokens > 0 && outTokens > 0,
    `in=${inTokens} out=${outTokens} · deltas de texto=${deltas}` +
      ` (finalMessage traia in=${final.usage?.input_tokens ?? "?"})`,
  );

  // Segundo turno: el resultado de la tool vuelve como tool_result y el modelo
  // tiene que redactar. Es la mitad del loop que mas se rompe al cambiar de
  // proveedor, porque exige que acepte de vuelta SUS PROPIOS content blocks.
  const seguimiento: any = await client.messages.create({
    model: modelFor("standard"),
    max_tokens: 2048,
    system: "Sos el asistente operativo del PMS. Respondes breve y en espanol.",
    messages: [
      { role: "user", content: "Mostrame la reserva RSV-8842" },
      { role: "assistant", content: final.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse?.id,
            content: JSON.stringify({ code: "RSV-8842", huesped: "Ana Pereyra", habitacion: 204, noches: 3 }),
          },
        ],
      },
    ],
  } as never);

  const texto = (seguimiento.content as any[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  report(
    "chat · cierra el loop con tool_result",
    /pereyra/i.test(texto) || /204/.test(texto),
    texto.replace(/\s+/g, " ").slice(0, 80) || "sin texto",
  );
}

// ── 4b. El catalogo COMPLETO de tools contra los tres tiers ──────────────────
//
// Esta es la prueba que faltaba el 2026-09-11, cuando el chat se cayo entero con
// un 400 de Google: `properties[order].items: missing field`. El defecto no
// estaba en el modelo ni en el protocolo sino en veintitres arrays del catalogo
// declarados sin `items` — invisibles con Anthropic, que los aceptaba.
//
// Lo que la hace valer: manda las 272 declaraciones JUNTAS, que es como viajan
// en un turno real. Una sola mal formada tumba el pedido completo, asi que
// probar con dos tools de juguete no habria encontrado nada.
async function smokeFullToolCatalog(): Promise<void> {
  const todas = await Tool.find({ status: "active" }, { toolId: 1 }).lean();
  const tools = await resolveTools((todas as any[]).map((t) => t.toolId));
  report(
    "catalogo · esquemas sin defectos",
    tools.every((t) => collectSchemaDefects(t.input_schema).length === 0),
    `${tools.length} tools resueltas`,
  );

  const client = getLlmClient();
  for (const tier of ["cheap", "standard", "premium"] as const) {
    try {
      const res: any = await client.messages.create({
        model: modelFor(tier),
        max_tokens: 2048,
        system: "Sos el asistente operativo del PMS. Usa las herramientas para leer datos reales.",
        messages: [{ role: "user", content: "Mostrame la reserva RSV-8842" }],
        tools: tools as never,
      } as never);
      const bloques = (res.content as any[]).map((b) => b.type).join("+");
      report(
        `catalogo · ${tier} acepta las ${tools.length}`,
        true,
        `stop=${res.stop_reason} blocks=[${bloques}]`,
      );
    } catch (err: any) {
      report(
        `catalogo · ${tier} acepta las ${tools.length}`,
        false,
        String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 150),
      );
    }
  }
}

// ── 5. Inteligencia competitiva: JSON estructurado ───────────────────────────
async function smokeCompetitiveIntel(): Promise<void> {
  const r = await callJson({
    model: draftModel(),
    system:
      'Sos un analista de competencia. Devolves SOLO JSON con esta forma: ' +
      '{"kind":"pricing_change|feature_launch|otro","severity":1-5,"summary":"<una oracion en espanol>"}',
    user:
      "Cloudbeds anuncio en su changelog que su plan Starter pasa de USD 99 a USD 129 por mes " +
      "a partir del proximo trimestre. Clasificalo.",
    maxTokens: 800,
  });
  report(
    "CI · borrador JSON (tier barato)",
    !!r.json?.kind && !!r.json?.summary,
    r.json ? `kind=${r.json.kind} sev=${r.json.severity} costo=USD ${r.usage.costUsd}` : `sin JSON (stop=${r.stopReason}): ${r.text.slice(0, 60)}`,
  );

  if (!WITH_WEB) {
    console.log("  nota   radar con web_search omitido (agregar --web para probarlo)");
    return;
  }
  const web = await callJson({
    model: radarModel(),
    system: 'Devolves SOLO JSON: {"respuesta":"<texto corto>","fuentes":["<url>"]}',
    user: "Busca en la web cual es la capital de Australia y devolvela con la fuente.",
    maxTokens: 1500,
    webSearch: { maxUses: 2 },
  });
  report(
    "CI · radar con web_search (tier estandar)",
    !!web.json?.respuesta && web.usage.webSearches > 0,
    web.json
      ? `${web.usage.webSearches} busquedas · costo=USD ${web.usage.costUsd} · ${String(web.json.respuesta).slice(0, 40)}`
      : `sin JSON (stop=${web.stopReason})`,
  );
}

// ── 6. Memoria: destilado y guardado ─────────────────────────────────────────
// Escribe de verdad, en un espacio operativo inventado, y limpia al salir.
async function smokeMemory(): Promise<void> {
  const scopeId = `smoke-llm-${Date.now()}`;
  try {
    await memoryService.distillFromExchange({
      scope: { operativeSpaceId: scopeId, companyId: null, propertyId: null, agentId: null },
      userMessage:
        "Acordate que en este hotel el check-in es a las 15 y nunca aceptamos mascotas, " +
        "salvo perros guia. Y el desayuno lo servimos de 7 a 10.",
      assistantMessage: "Anotado: check-in 15hs, sin mascotas salvo perros guia, desayuno 7-10.",
    });
    const guardadas = await memoryService.list(scopeId);
    report(
      "memoria · destila y guarda hechos",
      guardadas.length > 0,
      guardadas.length > 0
        ? `${guardadas.length} hechos · p.ej. "${guardadas[0].content.slice(0, 50)}"`
        : "cero hechos (el modelo no devolvio bloque de texto o el JSON no parseo)",
    );
  } finally {
    const borradas = await AgentMemory.deleteMany({ operativeSpaceId: scopeId });
    console.log(`  nota   limpieza del espacio de descarte: ${borradas.deletedCount ?? 0} documentos`);
  }
}

async function main(): Promise<void> {
  console.log("\nHumo de IA del internal contra OpenRouter");
  console.log(`  base SDK : ${OPENROUTER_SDK_BASE_URL}`);
  console.log(`  cheap    : ${LLM_MODELS.cheap}`);
  console.log(`  standard : ${LLM_MODELS.standard}`);
  console.log(`  premium  : ${LLM_MODELS.premium}\n`);

  await connectDB();

  console.log("\n[tarifas del medidor]");
  smokePricing();

  console.log("\n[tiers y capacidades]");
  smokeTiers();

  const suites: Array<[string, () => Promise<void>]> = [
    ["router de tareas", smokeRouter],
    ["chat operativo (roombir-IA)", smokeChatToolLoop],
    ["catalogo completo de tools", smokeFullToolCatalog],
    ["inteligencia competitiva", smokeCompetitiveIntel],
    ["memoria de largo plazo", smokeMemory],
  ];
  for (const [title, fn] of suites) {
    console.log(`\n[${title}]`);
    try {
      await fn();
    } catch (err: any) {
      failed++;
      console.log(`  FALLA  ${title} lanzo: ${(err?.message || err)?.toString().slice(0, 160)}`);
    }
  }

  console.log(`\n${passed} pasaron · ${failed} fallaron\n`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke:llm error:", err);
  process.exit(1);
});
