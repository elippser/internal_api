/**
 * Pruebas de los invariantes estructurales del motor (§33, §35).
 *
 * Corren SIN servidor, SIN base y SIN proveedor: ejercitan la lógica pura donde
 * viven los invariantes. Es a propósito — estas son las reglas cuya violación es
 * un defecto y no una preferencia, y una prueba que necesita infraestructura
 * para correr termina no corriéndose.
 *
 *   npm run test:engine
 */
import assert from "assert";

import {
  EXECUTION_STATUSES,
  HUMAN_RESUMABLE_STATUSES,
  IN_FLIGHT_STATUSES,
  STOP_WAITING_STATUSES,
  TERMINAL_STATUSES,
  WAITING_STATUSES,
  isTerminal,
  meetsRoleFloor,
  shouldStopWaiting,
} from "../engine/models/enums";
import { laneForGraphType } from "../engine/runtime/enqueue";
import { translateReasoning } from "../engine/llm/reasoning";
import { capabilitiesFor, listCatalog } from "../engine/llm/catalog";
import {
  applyChunk,
  newAccumulator,
  parseSseBuffer,
  toEngineMessage,
  toOpenAiMessages,
  toOpenAiTools,
  toStopReason,
} from "../engine/llm/providers/openrouterProtocol";
import { primeOpenRouterCatalog } from "../engine/llm/providers/openrouterCatalog";
import { computeCost, rateCardFor } from "../engine/llm/pricing";
import { partitionCalls, executePartitioned } from "../engine/tools/partition";
import { trimHistory } from "../engine/runtime/prompt";
import { redactSecrets, redactDeep, resetRedactionCache } from "../engine/runtime/redaction";
import { validateOutputSchema } from "../engine/runtime/outputSchema";
import { validateInterruptions } from "../engine/graph/factory";
import { capToolResult, sanitizeToolName } from "../engine/tools/types";
import { uuidv7, timestampOf } from "../engine/core/ids";
import { isPersistable, makeEvent } from "../engine/events/protocol";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function suite(title: string, fn: () => void): void {
  console.log(`\n${title}`);
  fn();
}

// ---------------------------------------------------------------------------

suite("§35.4 — «terminó» y «dejá de esperar» son conceptos distintos", () => {
  test("los conjuntos derivados cubren exactamente la taxonomía", () => {
    const union = new Set([...TERMINAL_STATUSES, ...WAITING_STATUSES, "queued", "running"]);
    assert.strictEqual(
      union.size,
      EXECUTION_STATUSES.length,
      "hay estados que no caen en ningún conjunto: alguien agregó uno sin derivarlo",
    );
  });

  test("«dejá de esperar» incluye los suspendidos, no sólo los finales", () => {
    for (const s of WAITING_STATUSES) {
      assert.ok(shouldStopWaiting(s), `${s} debería cortar un sondeo`);
      assert.ok(!isTerminal(s), `${s} no es un final de ciclo de vida`);
    }
  });

  test("un sondeo contra los finales colgaría en waiting_for_input", () => {
    // Esta es la regresión concreta que el invariante previene.
    assert.ok(shouldStopWaiting("waiting_for_input"));
    assert.ok(!TERMINAL_STATUSES.includes("waiting_for_input" as never));
  });

  test("«en vuelo» es exactamente el complemento de los finales", () => {
    for (const s of EXECUTION_STATUSES) {
      assert.strictEqual(IN_FLIGHT_STATUSES.includes(s), !isTerminal(s), `desajuste en ${s}`);
    }
  });

  test("waiting_for_subtask NO es reanudable por un humano", () => {
    // La despierta el bucle de reclamo; un botón de reanudar crearía dos dueños.
    assert.ok(!HUMAN_RESUMABLE_STATUSES.includes("waiting_for_subtask"));
    assert.ok(HUMAN_RESUMABLE_STATUSES.includes("waiting_for_input"));
    assert.ok(HUMAN_RESUMABLE_STATUSES.includes("paused"));
  });
});

suite("§35.3 — el carril se estampa al crear", () => {
  test("una corrida de codificación va al carril de codificación aunque sea hija", () => {
    assert.strictEqual(laneForGraphType("coding_run", true), "coding");
    assert.strictEqual(laneForGraphType("coding_run", false), "coding");
  });

  test("hijo y raíz caen en carriles disjuntos", () => {
    assert.strictEqual(laneForGraphType("react_loop", false), "root");
    assert.strictEqual(laneForGraphType("react_loop", true), "sub_agent");
  });
});

suite("§11.4 — migración cruzada de los controles de razonamiento", () => {
  test("un presupuesto heredado se PROMUEVE a adaptativo en la familia nueva", () => {
    const { params, adjustments } = translateReasoning("claude-opus-5", {
      thinkingBudgetTokens: 12_000,
    });
    assert.strictEqual(params.thinking?.type, "adaptive");
    assert.strictEqual(params.thinking?.budget_tokens, undefined, "budget_tokens sería un 400");
    assert.ok(adjustments.some((a) => a.includes("promovido")));
  });

  test("un presupuesto declarado se traduce a nivel de esfuerzo", () => {
    const { params } = translateReasoning("claude-opus-5", { thinkingBudgetTokens: 12_000 });
    assert.strictEqual(params.output_config?.effort, "high");
  });

  test("un esfuerzo declarado se CONVIERTE a presupuesto en un modelo sólo-heredado", () => {
    const { params, adjustments } = translateReasoning("claude-haiku-4-5", {
      reasoningEffort: "high",
    });
    assert.strictEqual(params.thinking?.type, "enabled");
    assert.ok((params.thinking?.budget_tokens ?? 0) > 0);
    assert.strictEqual(params.output_config, undefined, "Haiku rechaza el parámetro de esfuerzo");
    assert.ok(adjustments.some((a) => a.includes("convertido a presupuesto")));
  });

  test("el presupuesto siempre queda por debajo de maxTokens", () => {
    const { params } = translateReasoning("claude-haiku-4-5", {
      thinkingBudgetTokens: 30_000,
      maxTokens: 4_000,
    });
    assert.ok(
      (params.thinking?.budget_tokens ?? 0) < params.max_tokens,
      "budget_tokens >= max_tokens es un 400 del proveedor",
    );
  });

  test("el muestreo se DESCARTA en los modelos que lo rechazan", () => {
    const { params, adjustments } = translateReasoning("claude-opus-5", { temperature: 0.7 });
    assert.strictEqual(params.temperature, undefined, "temperature es un 400 en Opus 5");
    assert.ok(adjustments.some((a) => a.includes("muestreo")));
  });

  test("el muestreo SÍ pasa en los modelos que lo aceptan", () => {
    const { params } = translateReasoning("claude-haiku-4-5", { temperature: 0.7 });
    assert.strictEqual(params.temperature, 0.7);
  });

  test("temperature y top_p nunca viajan juntos", () => {
    const { params } = translateReasoning("claude-haiku-4-5", { temperature: 0.5, topP: 0.9 });
    assert.ok(
      !(params.temperature !== undefined && params.top_p !== undefined),
      "el proveedor rechaza ambos a la vez",
    );
  });

  test("Fable 5 no acepta que se apague el pensamiento: se omite el apagado", () => {
    const { params, adjustments } = translateReasoning("claude-fable-5", {
      thinkingEnabled: false,
    });
    assert.strictEqual(params.thinking, undefined, "un disabled explícito sería un 400");
    assert.ok(adjustments.some((a) => a.includes("piensa siempre")));
  });

  test("Opus 5 rechaza pensamiento apagado por encima de high: se baja el esfuerzo", () => {
    const { params, adjustments } = translateReasoning("claude-opus-5", {
      thinkingEnabled: false,
      reasoningEffort: "max",
    });
    assert.strictEqual(params.thinking?.type, "disabled");
    assert.strictEqual(params.output_config?.effort, "high");
    assert.ok(adjustments.some((a) => a.includes("rechaza el pensamiento deshabilitado")));
  });

  test("el resumen del razonamiento requiere opt-in explícito", () => {
    const off = translateReasoning("claude-opus-5", {});
    assert.strictEqual(off.params.thinking?.display, undefined);
    const on = translateReasoning("claude-opus-5", { reasoningSummary: true });
    assert.strictEqual(on.params.thinking?.display, "summarized");
  });

  test("maxTokens se acota al tope del modelo", () => {
    const { params } = translateReasoning("claude-haiku-4-5", { maxTokens: 999_999 });
    assert.strictEqual(params.max_tokens, capabilitiesFor("claude-haiku-4-5").maxOutputTokens);
  });

  test("un modelo desconocido cae al perfil conservador (forma nueva de la API)", () => {
    const caps = capabilitiesFor("modelo-que-no-existe-9");
    assert.strictEqual(caps.supportsSampling, false, "asumir la forma vieja sería un 400 seguro");
  });
});

suite("§24 — tarifas congeladas y desglose columnar", () => {
  test("el match exacto gana sobre la familia", () => {
    // La tabla vieja matchea sólo por familia y cobraría Opus 5 al triple.
    assert.strictEqual(rateCardFor("claude-opus-5").card.inputPerMTok, 5);
    assert.strictEqual(rateCardFor("claude-opus-5").source, "exact:claude-opus-5");
  });

  test("Fable 5 tiene tarifa propia y no cae al fallback", () => {
    assert.strictEqual(rateCardFor("claude-fable-5").card.inputPerMTok, 10);
  });

  test("el prefijo de proveedor no rompe la tarificación", () => {
    assert.strictEqual(rateCardFor("anthropic/claude-sonnet-5").card.inputPerMTok, 3);
  });

  test("el desglose suma al total y la instantánea queda adjunta", () => {
    const cost = computeCost("claude-opus-5", {
      tokensInput: 1_000_000,
      tokensOutput: 100_000,
      cacheReadTokens: 500_000,
    });
    assert.strictEqual(cost.costInputUsd, 5);
    assert.strictEqual(cost.costOutputUsd, 2.5);
    assert.strictEqual(cost.costCacheReadUsd, 0.25);
    assert.strictEqual(cost.costTotalUsd, 7.75);
    assert.strictEqual(cost.pricingSnapshot.source, "exact:claude-opus-5");
  });

  test("la tarificación falla abierta: nunca lanza", () => {
    const cost = computeCost("", { tokensInput: NaN, tokensOutput: 10 });
    assert.ok(Number.isFinite(cost.costTotalUsd) || cost.costTotalUsd === 0);
  });
});

suite("§11.2 — nodo de herramientas particionado", () => {
  test("las lecturas consecutivas se agrupan en un lote", () => {
    const batches = partitionCalls([
      { item: "a", concurrency: "read" },
      { item: "b", concurrency: "read" },
      { item: "c", concurrency: "read" },
    ]);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].items.length, 3);
  });

  test("una escritura corta la racha y corre sola", () => {
    const batches = partitionCalls([
      { item: "r1", concurrency: "read" },
      { item: "w1", concurrency: "write" },
      { item: "r2", concurrency: "read" },
    ]);
    assert.deepStrictEqual(
      batches.map((b) => b.items),
      [["r1"], ["w1"], ["r2"]],
    );
  });

  test("una exclusiva nunca comparte lote", () => {
    const batches = partitionCalls([
      { item: "x", concurrency: "exclusive" },
      { item: "y", concurrency: "exclusive" },
    ]);
    assert.strictEqual(batches.length, 2);
  });

  test("el orden ORIGINAL de los resultados se conserva", async () => {
    // El proveedor exige que los tool_result vuelvan emparejados con sus
    // tool_use; romper el orden rompe el turno.
    const results = await executePartitioned<string, string>(
      [
        { item: "a", concurrency: "read" },
        { item: "b", concurrency: "read" },
        { item: "c", concurrency: "write" },
      ],
      async (item) => {
        await new Promise((r) => setTimeout(r, item === "a" ? 20 : 1));
        return item.toUpperCase();
      },
      () => "ERR",
    );
    assert.deepStrictEqual(results, ["A", "B", "C"]);
  });

  test("una herramienta que revienta no tumba a sus hermanas del lote", async () => {
    const results = await executePartitioned<string, string>(
      [
        { item: "ok1", concurrency: "read" },
        { item: "boom", concurrency: "read" },
        { item: "ok2", concurrency: "read" },
      ],
      async (item) => {
        if (item === "boom") throw new Error("falló");
        return item;
      },
      (item) => `ERR:${item}`,
    );
    assert.deepStrictEqual(results, ["ok1", "ERR:boom", "ok2"]);
  });
});

suite("§35.10 — la compactación deja un historial válido para el proveedor", () => {
  test("nunca arranca en un mensaje con tool_result huérfano", () => {
    const messages = [
      { role: "user" as const, content: "hola" },
      { role: "assistant" as const, content: [{ type: "tool_use", id: "t1" }] },
      { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1" }] },
      { role: "assistant" as const, content: "listo" },
    ];
    const trimmed = trimHistory(messages, 2);
    const first = trimmed.find((m) => typeof m.content !== "string" || !m.content.startsWith("["));
    const hasOrphan =
      Array.isArray(first?.content) &&
      (first!.content as Array<{ type?: string }>).some((b) => b?.type === "tool_result");
    assert.ok(!hasOrphan, "un tool_result sin su tool_use es un 400 del proveedor");
  });

  test("marca la omisión de forma explícita", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    const trimmed = trimHistory(messages, 4);
    assert.ok(
      String(trimmed[0].content).includes("omitieron"),
      "sin la marca el modelo cree que vio el principio y afirma cosas falsas",
    );
  });

  test("no toca un historial que ya entra", () => {
    const messages = [{ role: "user" as const, content: "hola" }];
    assert.strictEqual(trimHistory(messages, 10), messages);
  });
});

suite("§15.3 — reglas de interrupción validadas al guardar", () => {
  test("una interrupción por herramienta SIN nombre se rechaza", () => {
    assert.throws(
      () => validateInterruptions([{ trigger: "tool_call" }] as never),
      /toolName/,
      "sin nombre la regla nunca dispara: sería un gate inexistente que el usuario cree activo",
    );
  });

  test("el conteo de turnos en 0 se rechaza", () => {
    assert.throws(
      () => validateInterruptions([{ trigger: "turn_count", everyNTurns: 0 }] as never),
      /≥ 1/,
    );
  });

  test("el umbral de costo se rechaza EXPLÍCITAMENTE", () => {
    assert.throws(
      () => validateInterruptions([{ trigger: "cost_threshold" }] as never),
      /no soportado/,
      "aceptarlo prometería una compuerta que nunca frena nada",
    );
  });

  test("las reglas válidas pasan", () => {
    const rules = validateInterruptions([
      { trigger: "tool_call", toolName: "create_reservation" },
      { trigger: "turn_count", everyNTurns: 5 },
    ] as never);
    assert.strictEqual(rules.length, 2);
  });
});

suite("§29 — redacción de secretos en la salida", () => {
  test("redacta por valor conocido", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-valor-secretisimo-de-prueba-123456";
    resetRedactionCache();
    const out = redactSecrets("la clave es sk-ant-valor-secretisimo-de-prueba-123456 ok");
    assert.ok(!out.includes("secretisimo"));
    assert.ok(out.includes("[REDACTADO"));
  });

  test("redacta por patrón un token que nunca vimos", () => {
    const out = redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 fin");
    assert.ok(out.includes("[REDACTADO:GITHUB_TOKEN]"));
  });

  test("redacta credenciales embebidas en una URL", () => {
    const out = redactSecrets("mongodb://user:pass123@host/db");
    assert.ok(!out.includes("pass123"));
  });

  test("redacta por NOMBRE de clave aunque el valor no matchee ningún patrón", () => {
    const out = redactDeep({ apiKey: "xyz", nested: { password: "abc", safe: "hola" } }) as Record<
      string,
      Record<string, string> | string
    >;
    assert.strictEqual(out.apiKey, "[REDACTADO]");
    assert.strictEqual((out.nested as Record<string, string>).password, "[REDACTADO]");
    assert.strictEqual((out.nested as Record<string, string>).safe, "hola");
  });

  test("acota la profundidad: una estructura cíclica no cuelga el cierre", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => redactDeep(cyclic));
  });
});

suite("§35.13 — un esquema de salida declarado se hace cumplir", () => {
  test("sin esquema, cualquier texto pasa", () => {
    assert.ok(validateOutputSchema(null, "prosa libre").ok);
  });

  test("con esquema, la prosa FALLA", () => {
    const r = validateOutputSchema({ type: "object" }, "esto es prosa");
    assert.ok(!r.ok);
    assert.ok(r.error?.includes("JSON"));
  });

  test("un campo requerido ausente falla nombrando el campo", () => {
    const r = validateOutputSchema(
      { type: "object", required: ["issues"] },
      '{"summary":"todo bien"}',
    );
    assert.ok(!r.ok);
    assert.ok(r.error?.includes("issues"));
  });

  test("acepta JSON envuelto en un bloque de código", () => {
    const r = validateOutputSchema(
      { type: "object", required: ["ok"] },
      '```json\n{"ok": true}\n```',
    );
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.value, { ok: true });
  });

  test("valida tipos anidados", () => {
    const schema = {
      type: "object",
      required: ["items"],
      properties: { items: { type: "array", items: { type: "object", required: ["id"] } } },
    };
    assert.ok(validateOutputSchema(schema, '{"items":[{"id":"a"}]}').ok);
    assert.ok(!validateOutputSchema(schema, '{"items":[{"nope":1}]}').ok);
  });
});

suite("§12 — saneado de herramientas y tope de resultado", () => {
  test("el nombre se sanea al patrón que acepta el proveedor", () => {
    assert.match(sanitizeToolName("crear reserva (rápido)"), /^[a-zA-Z0-9_-]{1,64}$/);
    assert.match(sanitizeToolName("acción-ñ"), /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(sanitizeToolName("").length > 0, "nunca devuelve vacío");
  });

  test("un resultado gigante se trunca CON aviso de que no es el final", () => {
    const big = { rows: Array.from({ length: 5_000 }, (_, i) => ({ i, name: `fila ${i}` })) };
    const capped = capToolResult(big, 1_000) as Record<string, unknown>;
    assert.strictEqual(capped.truncated, true);
    assert.ok(
      String(capped.note).includes("NO es el final"),
      "sin el aviso el modelo afirma que la lista terminó",
    );
  });

  test("un resultado chico pasa intacto", () => {
    const small = { ok: true };
    assert.strictEqual(capToolResult(small, 10_000), small);
  });
});

suite("§7.3 — pisos de rol", () => {
  test("el rango se compara, no se iguala", () => {
    assert.ok(meetsRoleFloor("admin", "developer"));
    assert.ok(!meetsRoleFloor("analyst", "developer"));
    assert.ok(meetsRoleFloor("developer", "developer"));
  });

  test("sin piso declarado, cualquiera pasa", () => {
    assert.ok(meetsRoleFloor("support", null));
  });

  test("un rol desconocido no supera ningún piso", () => {
    assert.ok(!meetsRoleFloor("inventado", "support"));
  });
});

suite("ids ordenables en el tiempo", () => {
  test("los ids generados en ráfaga quedan ordenados lexicográficamente", () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const sorted = [...ids].sort();
    assert.deepStrictEqual(ids, sorted, "sin monotonía el diario se reproduce desordenado");
  });

  test("no hay colisiones dentro del mismo milisegundo", () => {
    const ids = Array.from({ length: 2_000 }, () => uuidv7());
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  test("el timestamp embebido se puede recuperar", () => {
    const before = Date.now();
    const ts = timestampOf(uuidv7());
    assert.ok(ts && ts.getTime() >= before - 5 && ts.getTime() <= Date.now() + 5);
  });
});

suite("§22 — protocolo de eventos", () => {
  test("los deltas de alta frecuencia NO se persisten", () => {
    assert.ok(!isPersistable("token"));
    assert.ok(!isPersistable("thinking_delta"));
    assert.ok(!isPersistable("tool_call_delta"));
  });

  test("los eventos con significado SÍ se persisten", () => {
    for (const t of ["status", "tool_call", "tool_result", "interrupt", "done", "error"]) {
      assert.ok(isPersistable(t), `${t} debería quedar en el diario`);
    }
  });

  test("un evento malformado falla donde se produce", () => {
    assert.throws(() => makeEvent("no_existe" as never, "exec-1", 1), /desconocido/);
    assert.throws(() => makeEvent("status", "", 1), /sin executionId/);
  });

  test("el evento lleva la versión del protocolo", () => {
    assert.strictEqual(makeEvent("status", "exec-1", 3).v, 1);
  });

  test("text_reset existe y NO se persiste", () => {
    // Es una instrucción sobre un borrador vivo: en una reproducción histórica
    // el texto final ya está resuelto y no hay borrador que limpiar.
    assert.doesNotThrow(() => makeEvent("text_reset", "exec-1", 1));
    assert.ok(!isPersistable("text_reset"));
  });
});

suite("§24 — la clave de tarifa es el modelo CONFIGURADO", () => {
  test("el id upstream de un gateway no cotiza y caería a la reserva", () => {
    // Es el bug real: el gateway responde `deepseek-v4-flash-0731`, que no
    // existe en ningún catálogo, y la reserva cobraba ~45x de más.
    const upstream = rateCardFor("deepseek-v4-flash-0731");
    assert.strictEqual(upstream.source, "unknown");

    // El nombre cualificado del autor sí cotiza contra el catálogo del gateway.
    primeOpenRouterCatalog([
      {
        id: "~deepseek/deepseek-v4-flash-latest",
        name: "DeepSeek V4 Flash",
        vendor: "~deepseek",
        contextLength: 1_048_576,
        maxOutputTokens: null,
        vision: false,
        tools: true,
        reasoning: false,
        promptPerMTok: 0.067,
        completionPerMTok: 0.134,
      },
    ]);
    const configured = rateCardFor("openrouter/~deepseek/deepseek-v4-flash-latest");
    assert.strictEqual(configured.card.inputPerMTok, 0.067);
    assert.ok(configured.source.startsWith("openrouter:"));

    // La diferencia entre una y otra es el tamaño del error que esto evita.
    assert.ok(
      upstream.card.inputPerMTok / configured.card.inputPerMTok > 40,
      "la reserva cobraba decenas de veces de más",
    );
  });
});

suite("§11.3 — gateway agregador: traducción de protocolo", () => {
  test("los tool_result se ABREN en un mensaje `tool` por resultado", () => {
    // Agruparlos en uno solo deja llamadas sin respuesta y el proveedor rechaza
    // el turno entero.
    const out = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "1" },
          { type: "tool_result", tool_use_id: "b", content: "2" },
        ],
      },
    ]);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(
      out.map((m) => [m.role, m.tool_call_id]),
      [
        ["tool", "a"],
        ["tool", "b"],
      ],
    );
  });

  test("los tool_use del asistente se convierten en tool_calls con argumentos serializados", () => {
    const out = toOpenAiMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "voy a buscar" },
          { type: "tool_use", id: "t1", name: "buscar", input: { q: "hola" } },
        ],
      },
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].content, "voy a buscar");
    assert.strictEqual(out[0].tool_calls?.[0].function.name, "buscar");
    assert.strictEqual(out[0].tool_calls?.[0].function.arguments, '{"q":"hola"}');
  });

  test("una imagen base64 se convierte a data URL", () => {
    const out = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "text", text: "qué es esto" },
        ],
      },
    ]);
    const parts = out[0].content as Array<Record<string, unknown>>;
    const image = parts.find((p) => p.type === "image_url");
    assert.ok(String((image?.image_url as { url: string }).url).startsWith("data:image/png;base64,"));
  });

  test("las herramientas de SERVIDOR se descartan (no existen del otro lado)", () => {
    const tools = toOpenAiTools([
      { type: "web_search_20260209", name: "web_search" },
      { name: "buscar", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
    assert.strictEqual(tools?.length, 1);
    assert.strictEqual(tools?.[0].function.name, "buscar");
  });

  test("los argumentos fragmentados se concatenan por índice antes de parsear", () => {
    const acc = newAccumulator();
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: '{"a"' } }] } }],
    });
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }],
    });
    const msg = toEngineMessage(acc, "m");
    const call = msg.content.find((b) => b.type === "tool_use");
    assert.deepStrictEqual(call?.input, { a: 1 });
  });

  test("un turno con herramientas SIEMPRE cierra en tool_use", () => {
    const acc = newAccumulator();
    applyChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "x", function: { name: "f", arguments: "{}" } }] }, finish_reason: "stop" },
      ],
    });
    // El proveedor dijo "stop"; el bucle necesita "tool_use" para ejecutar y volver.
    assert.strictEqual(toEngineMessage(acc, "m").stop_reason, "tool_use");
  });

  test("los argumentos malformados no borran la llamada", () => {
    const acc = newAccumulator();
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "f", arguments: "{roto" } }] } }],
    });
    const call = toEngineMessage(acc, "m").content.find((b) => b.type === "tool_use");
    assert.ok(call, "la llamada tiene que sobrevivir para que el modelo pueda corregirse");
    assert.ok((call?.input as Record<string, unknown>).__rawArguments);
  });

  test("los deltas de texto se acumulan y se reportan", () => {
    const acc = newAccumulator();
    const d1 = applyChunk(acc, { choices: [{ delta: { content: "Hola" } }] });
    const d2 = applyChunk(acc, { choices: [{ delta: { content: " mundo" } }] });
    assert.strictEqual(d1, "Hola");
    assert.strictEqual(d2, " mundo");
    assert.strictEqual(acc.text, "Hola mundo");
  });

  test("el uso llega por el evento final y alimenta el asiento", () => {
    const acc = newAccumulator();
    applyChunk(acc, { usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [] });
    const msg = toEngineMessage(acc, "m");
    assert.strictEqual(msg.usage.input_tokens, 100);
    assert.strictEqual(msg.usage.output_tokens, 20);
  });

  test("finish_reason se mapea al vocabulario del motor", () => {
    assert.strictEqual(toStopReason("stop"), "end_turn");
    assert.strictEqual(toStopReason("length"), "max_tokens");
    assert.strictEqual(toStopReason("tool_calls"), "tool_use");
    assert.strictEqual(toStopReason("content_filter"), "refusal");
  });

  test("el buffer SSE conserva la línea incompleta para el próximo chunk", () => {
    const { events, rest } = parseSseBuffer('data: {"a":1}\ndata: {"b":2');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { a: 1 });
    assert.strictEqual(rest, 'data: {"b":2', "cortar acá perdería el evento");
  });

  test("[DONE] y las líneas basura no rompen el parseo", () => {
    const { events } = parseSseBuffer("data: [DONE]\n: comentario\ndata: no-json\ndata: {\"ok\":1}\n");
    assert.deepStrictEqual(events, [{ ok: 1 }]);
  });
});

suite("§11.3 — capacidades y tarifas del gateway", () => {
  test("un modelo del gateway NO acepta pensamiento adaptativo", () => {
    primeOpenRouterCatalog([
      {
        id: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        vendor: "google",
        contextLength: 1_000_000,
        maxOutputTokens: 65_536,
        vision: true,
        tools: true,
        reasoning: false,
        promptPerMTok: 1.25,
        completionPerMTok: 10,
      },
    ]);
    const caps = capabilitiesFor("openrouter/google/gemini-2.5-pro");
    assert.deepStrictEqual(caps.thinkingModes, ["none"]);
    assert.strictEqual(caps.supportsSampling, true, "el protocolo mayoritario sí acepta muestreo");
    assert.strictEqual(caps.contextWindowTokens, 1_000_000);
  });

  test("el traductor no manda `thinking` a un modelo del gateway", () => {
    const { params } = translateReasoning("openrouter/google/gemini-2.5-pro", {
      thinkingEnabled: true,
      temperature: 0.5,
    });
    assert.strictEqual(params.thinking, undefined, "sería un 400");
    assert.strictEqual(params.temperature, 0.5);
  });

  test("la tarifa sale del catálogo del gateway, no de la tabla local", () => {
    const { card, source } = rateCardFor("openrouter/google/gemini-2.5-pro");
    assert.strictEqual(card.inputPerMTok, 1.25);
    assert.strictEqual(card.outputPerMTok, 10);
    assert.ok(source.startsWith("openrouter:"));
  });

  test("con el catálogo frío el costo es CERO explícito, no un número inventado", () => {
    const { card, source } = rateCardFor("openrouter/inexistente/modelo-x");
    assert.strictEqual(card.inputPerMTok, 0);
    assert.strictEqual(source, "openrouter:catalog-frio");
  });

  test("los modelos sin soporte de herramientas quedan fuera del selector", () => {
    primeOpenRouterCatalog([
      {
        id: "con/tools",
        name: "Con",
        vendor: "con",
        contextLength: 8000,
        maxOutputTokens: null,
        vision: false,
        tools: true,
        reasoning: false,
        promptPerMTok: 1,
        completionPerMTok: 1,
      },
      {
        id: "sin/tools",
        name: "Sin",
        vendor: "sin",
        contextLength: 8000,
        maxOutputTokens: null,
        vision: false,
        tools: false,
        reasoning: false,
        promptPerMTok: 1,
        completionPerMTok: 1,
      },
    ]);
    const ids = listCatalog().map((m) => m.id);
    assert.ok(ids.includes("con/tools"));
    assert.ok(!ids.includes("sin/tools"), "elegirlo y descubrir que ignora las tools es el peor modo de falla");
  });

  test("los modelos de primera parte siguen intactos", () => {
    assert.strictEqual(capabilitiesFor("claude-opus-5").thinkingModes[0], "adaptive");
    assert.strictEqual(rateCardFor("claude-opus-5").card.inputPerMTok, 5);
  });
});

// ---------------------------------------------------------------------------

setTimeout(() => {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} pasaron · ${failed} fallaron`);
  if (failed > 0) {
    console.error("\nHay invariantes rotos.");
    process.exit(1);
  }
  console.log("Todos los invariantes estructurales se sostienen.\n");
  process.exit(0);
  // Un tick para que terminen las pruebas asíncronas del particionado.
}, 250);
