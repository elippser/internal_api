/**
 * Prueba de humo de extremo a extremo del motor agéntico (§33.1).
 *
 * Existe porque los simulacros no alcanzan: la superficie combina tenencia,
 * ciclo de vida, versionado, streaming y proveedores de contexto, y muchos
 * defectos sólo aparecen en interacciones HTTP reales contra una pila levantada.
 * Sale con código distinto de cero al primer fallo.
 *
 * Cuatro fases, y las tres primeras NO necesitan clave de proveedor:
 *   1. Fundamentos  — salud, vocabulario, catálogo, contrato de eventos
 *   2. Autoría      — agente, versionado inmutable, activación, validaciones
 *   3. Ciclo de vida— encolado, control (pausar/cancelar), linaje
 *   4. Ejecución    — corrida real contra el modelo (requiere ANTHROPIC_API_KEY)
 *
 * Uso:
 *   API_URL=http://localhost:8600 SMOKE_EMAIL=... SMOKE_PASSWORD=... npm run smoke:engine
 *   (o SMOKE_TOKEN=<jwt> para saltear el login)
 */
import "dotenv/config";

const BASE = (process.env.API_URL ?? "http://localhost:8600").replace(/\/$/, "");
const API = `${BASE}/api/v1`;
const TENANT = process.env.SMOKE_TENANT ?? "smoke-tenant";

let token = process.env.SMOKE_TOKEN ?? "";
let checks = 0;
const created: { agentId?: string; toolId?: string } = {};

// ---------------------------------------------------------------------------

function ok(label: string, detail = ""): void {
  checks += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function die(label: string, detail: unknown): never {
  console.error(`  ✗ ${label}`);
  console.error(`      ${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`);
  process.exit(1);
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<CallResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-engine-tenant": TENANT,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = opts.raw ? { raw: text } : { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

function expect(result: CallResult, status: number, label: string): Record<string, unknown> {
  if (result.status !== status) {
    die(label, { expected: status, got: result.status, body: result.body });
  }
  return result.body;
}

// ---------------------------------------------------------------------------

async function login(): Promise<void> {
  if (token) {
    ok("token provisto por entorno");
    return;
  }
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    die("autenticación", "faltan SMOKE_TOKEN o SMOKE_EMAIL + SMOKE_PASSWORD");
  }

  const res = await call("POST", "/auth/login", { email, password });
  const body = expect(res, 200, "login");
  token = String(body.token ?? body.accessToken ?? "");
  if (!token) die("login", body);
  ok("autenticado");
}

async function phase1Foundations(): Promise<void> {
  console.log("\n[1/4] Fundamentos");

  const health = expect(await call("GET", "/engine/system/health"), 200, "salud del motor");
  ok("salud del motor", `worker=${JSON.stringify((health.self as Record<string, unknown>)?.running)}`);

  const vocab = expect(await call("GET", "/engine/system/vocabulary"), 200, "vocabulario");
  const statuses = vocab.executionStatuses as Record<string, string[]>;

  // El invariante §35.4 tiene que ser visible desde afuera: si la consola
  // tuviera que recalcular estos conjuntos, se volverían a confundir.
  if (!statuses.stopWaiting.includes("waiting_for_input")) {
    die("vocabulario", "«dejá de esperar» no incluye los estados suspendidos");
  }
  if (statuses.humanResumable.includes("waiting_for_subtask")) {
    die("vocabulario", "waiting_for_subtask no debe ser reanudable por un humano");
  }
  ok("conjuntos de estado derivados y coherentes");

  const models = expect(await call("GET", "/engine/system/models"), 200, "catálogo de modelos");
  if (!Array.isArray(models.models) || models.models.length === 0) {
    die("catálogo de modelos", "vacío");
  }
  ok("catálogo de modelos", `${(models.models as unknown[]).length} modelos`);

  const protocol = expect(
    await call("GET", "/engine/system/event-protocol"),
    200,
    "contrato de eventos",
  );
  if (protocol.terminalEvent !== "done") die("contrato de eventos", "el evento terminal cambió");
  ok("contrato de eventos", `v${protocol.version}`);

  expect(await call("GET", "/engine/system/registry"), 200, "registro de herramientas");
  ok("registro de herramientas de código");
}

async function phase2Authoring(): Promise<void> {
  console.log("\n[2/4] Autoría y versionado inmutable");

  const agent = expect(
    await call("POST", "/engine/agents", {
      name: `Smoke ${Date.now()}`,
      description: "Agente efímero de la prueba de humo",
    }),
    201,
    "crear agente",
  );
  created.agentId = String(agent.agentId);
  ok("agente creado", created.agentId);

  if (agent.activeVersionId !== null) {
    die("crear agente", "un agente recién creado no debería tener versión activa");
  }
  ok("el agente nace sin versión activa");

  // --- Validaciones que DEBEN correr al guardar ---
  const badInterrupt = await call("POST", `/engine/agents/${created.agentId}/versions`, {
    modelName: "claude-haiku-4-5",
    config: { interruptions: [{ trigger: "tool_call" }] },
  });
  if (badInterrupt.status !== 422) {
    die("interrupción sin toolName", {
      expected: 422,
      got: badInterrupt.status,
      note: "sería un gate inexistente que el operador cree activo",
    });
  }
  ok("una interrupción por herramienta sin nombre se rechaza al guardar");

  const badCost = await call("POST", `/engine/agents/${created.agentId}/versions`, {
    modelName: "claude-haiku-4-5",
    config: { interruptions: [{ trigger: "cost_threshold" }] },
  });
  if (badCost.status !== 422) die("umbral de costo", "debería rechazarse explícitamente");
  ok("el umbral de costo se rechaza explícitamente");

  const badGraph = await call("POST", `/engine/agents/${created.agentId}/versions`, {
    modelName: "claude-haiku-4-5",
    graphType: "flow_dag",
  });
  if (badGraph.status !== 422) die("tipo de grafo", "la autoría de flow_dag está desactivada");
  ok("los tipos de grafo no autoriables se rechazan");

  // --- Versión válida ---
  const v1 = expect(
    await call("POST", `/engine/agents/${created.agentId}/versions`, {
      modelName: "claude-haiku-4-5",
      systemPrompt: "Respondé en una sola oración, en español.",
      tools: ["think"],
      modelParams: { maxTokens: 512 },
      changeNote: "versión inicial de la prueba de humo",
    }),
    201,
    "crear versión 1",
  );
  if (v1.version !== 1) die("versión 1", `se esperaba version=1 y llegó ${v1.version}`);
  ok("versión 1 creada y activada");

  const v2 = expect(
    await call("POST", `/engine/agents/${created.agentId}/versions`, {
      modelName: "claude-haiku-4-5",
      systemPrompt: "Respondé en DOS oraciones.",
      modelParams: { maxTokens: 512 },
      changeNote: "segunda versión",
    }),
    201,
    "crear versión 2",
  );
  if (v2.version !== 2) die("versión 2", "el número no incrementó");
  ok("versión 2 creada: editar NO muta, crea");

  const versions = expect(
    await call("GET", `/engine/agents/${created.agentId}/versions`),
    200,
    "listar versiones",
  ) as unknown as Array<Record<string, unknown>>;
  const list = Array.isArray(versions) ? versions : ((versions as Record<string, unknown>).data as never[]);
  if (list.length !== 2) die("listar versiones", `se esperaban 2 y hay ${list.length}`);
  ok("el historial conserva las dos versiones");

  // --- Reversión: mover el puntero ---
  expect(
    await call("POST", `/engine/agents/${created.agentId}/versions/${v1.versionId}/activate`),
    200,
    "revertir a v1",
  );
  const reverted = expect(
    await call("GET", `/engine/agents/${created.agentId}`),
    200,
    "leer agente revertido",
  );
  if (reverted.activeVersionId !== v1.versionId) die("reversión", "el puntero no se movió");
  ok("reversión = mover el puntero, sin copiar ni mutar");

  // Se deja v2 activa para el resto de la prueba.
  await call("POST", `/engine/agents/${created.agentId}/versions/${v2.versionId}/activate`);

  const exported = expect(
    await call("GET", `/engine/agents/${created.agentId}/export`),
    200,
    "exportar agente",
  );
  if (exported.format !== "engine-agent-export/1") die("exportar", "formato inesperado");
  ok("exportación portable entre despliegues");
}

async function phase3Lifecycle(): Promise<void> {
  console.log("\n[3/4] Ciclo de vida y control");

  const run = expect(
    await call("POST", "/engine/executions", {
      agentId: created.agentId,
      inputText: "Decí solamente: listo.",
    }),
    202,
    "encolar ejecución",
  );
  const executionId = String(run.executionId);
  ok("ejecución encolada", executionId);

  if (run.lane !== "root") die("carril", `se esperaba root y llegó ${run.lane}`);
  ok("el carril se estampó al crear");

  // --- Idempotencia ---
  const key = `smoke-${Date.now()}`;
  const first = expect(
    await call("POST", "/engine/executions", {
      agentId: created.agentId,
      inputText: "idempotencia",
      idempotencyKey: key,
    }),
    202,
    "primera con clave de idempotencia",
  );
  const second = expect(
    await call("POST", "/engine/executions", {
      agentId: created.agentId,
      inputText: "idempotencia",
      idempotencyKey: key,
    }),
    202,
    "segunda con la misma clave",
  );
  if (first.executionId !== second.executionId) {
    die("idempotencia", "un reintento de red produjo dos corridas facturables");
  }
  ok("la clave de idempotencia deduplica");

  // --- El cuerpo no puede falsificar el enlace de autoría ---
  const forged = await call("POST", "/engine/executions", {
    agentId: created.agentId,
    inputText: "hola",
    sourceScheduledTaskId: "tarea-de-otro-cliente",
  });
  if (forged.status !== 422) {
    die("enlace confiable", "sourceScheduledTaskId no puede aceptarse desde el cuerpo");
  }
  ok("el enlace de autoría no se puede falsificar desde el cuerpo");

  // --- Cancelación de una corrida en cola ---
  const toCancel = expect(
    await call("POST", "/engine/executions", {
      agentId: created.agentId,
      inputText: "esta se cancela",
      priority: -50,
    }),
    202,
    "encolar para cancelar",
  );
  const cancelled = expect(
    await call("POST", `/engine/executions/${toCancel.executionId}/cancel`),
    200,
    "cancelar",
  );
  ok("cancelación aceptada", `inmediata=${cancelled.immediate}`);

  // --- Reintento de una corrida no terminada se rechaza ---
  const badRetry = await call("POST", `/engine/executions/${executionId}/retry`);
  if (badRetry.status !== 409 && badRetry.status !== 202) {
    die("reintento", { got: badRetry.status, body: badRetry.body });
  }
  ok("el reintento sólo aplica a corridas terminadas");

  expect(await call("GET", `/engine/executions/${executionId}`), 200, "leer ejecución");
  expect(await call("GET", `/engine/executions/${executionId}/steps`), 200, "leer pasos");
  expect(await call("GET", `/engine/executions/${executionId}/events`), 200, "leer diario");
  expect(await call("GET", `/engine/executions/${executionId}/usage`), 200, "leer asientos");
  ok("superficie del depurador completa");

  const listed = expect(
    await call("GET", `/engine/executions?agentId=${created.agentId}&limit=5`),
    200,
    "listar ejecuciones",
  );
  ok("listado con filtros", `total=${listed.total}`);
}

async function phase4RealRun(): Promise<void> {
  console.log("\n[4/4] Corrida real contra el proveedor");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("  · omitida: falta ANTHROPIC_API_KEY");
    return;
  }

  const run = expect(
    await call("POST", "/engine/executions", {
      agentId: created.agentId,
      inputText: "Respondé exactamente con la palabra: listo",
      priority: 50,
    }),
    202,
    "encolar corrida real",
  );
  const executionId = String(run.executionId);

  // Se sondea contra "dejá de esperar", no contra los finales.
  const deadline = Date.now() + 90_000;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const body = expect(await call("GET", `/engine/executions/${executionId}`), 200, "sondear");
    last = body;
    const status = String(body.status);
    if (["succeeded", "failed", "timed_out", "cancelled", "waiting_for_input", "paused"].includes(status)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }

  if (!last) die("corrida real", "no se pudo leer la ejecución");
  if (last.status !== "succeeded") {
    die("corrida real", { status: last.status, error: last.errorMessage });
  }
  ok("la corrida terminó bien", String(last.outputText).slice(0, 60));

  if (!last.resolvedSystemPrompt) die("depurador", "no se persistió el prompt resuelto");
  ok("el prompt EXACTO enviado al modelo quedó persistido");

  const steps = (await call("GET", `/engine/executions/${executionId}/steps`)).body as unknown as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(steps) || steps.length === 0) die("pasos", "la corrida no dejó pasos");
  ok("árbol de pasos", `${steps.length} paso(s)`);

  const usage = (await call("GET", `/engine/executions/${executionId}/usage`)).body as unknown as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(usage) || usage.length === 0) die("asientos", "no se registró consumo");
  if (!usage[0].pricingSnapshot) die("asientos", "el asiento no congeló la tarifa");
  ok("asiento por llamada con tarifa congelada", `costo=$${last.costUsd}`);

  // §35.6: costo, pasos y ejecución no pueden divergir.
  const sumSteps = steps.reduce((a, s) => a + Number(s.tokensOutput ?? 0), 0);
  if (sumSteps !== Number(last.tokensOutput)) {
    die("§35.6", { pasos: sumSteps, ejecucion: last.tokensOutput });
  }
  ok("costo, pasos y ejecución coinciden");
}

async function cleanup(): Promise<void> {
  if (created.agentId) {
    await call("DELETE", `/engine/agents/${created.agentId}`);
    ok("agente de prueba archivado");
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Prueba de humo del motor agéntico contra ${API}\n`);
  await login();
  await phase1Foundations();
  await phase2Authoring();
  await phase3Lifecycle();
  await phase4RealRun();
  await cleanup();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${checks} verificaciones pasaron.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nLa prueba de humo reventó:", err);
  process.exit(1);
});
