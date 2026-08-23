/**
 * Sub-agentes y delegación (§14).
 *
 * Patrón "agentes como herramientas": cada sub-agente se expone al modelo padre
 * como una herramienta más, el modelo decide cuándo delegar y redacta la
 * subtarea. El padre no orquesta a mano.
 *
 * Los tres modos NO son intercambiables y la diferencia es de recursos, no de
 * estilo:
 *
 *   EN LÍNEA  el grafo hijo se construye y se invoca en el MISMO proceso, dentro
 *             de la ranura del padre. Rápido y simple. El costo se atribuye por
 *             ruta de agentes, pero la propiedad del gasto queda en la ejecución
 *             padre — no hay fila de ejecución hija.
 *
 *   REMOTO    crea una ejecución hija encolada; el padre BLOQUEA y sondea. Sirve
 *             para aislar de verdad (el hijo tiene su propia fila, su propio
 *             costo, su propio diagnóstico) sin cambiar la forma del código del
 *             padre. Pero mantiene ocupada la ranura del padre mientras espera.
 *
 *   ASÍNCRONO crea la ejecución hija, levanta una interrupción y RETORNA: libera
 *             la ranura del carril y el despertador revive al padre cuando el
 *             hijo termina. Es el único modo que escala a delegación ancha: con
 *             el modo remoto, diez padres esperando diez hijos ocupan diez
 *             ranuras sin hacer nada.
 *
 * Propiedades que valen para los tres:
 *   - Aislamiento de contexto: el hijo arranca con mensajes VACÍOS y recibe
 *     únicamente la cadena de tarea que compuso el padre.
 *   - Errores como cadenas JSON, no excepciones: el padre puede adaptarse o
 *     reintentar en vez de morir por una falla del hijo.
 *   - Credenciales reenviadas por CONFIGURACIÓN, nunca por estado ni punto de
 *     control (§35.8).
 */
import { ValidationError } from "../core/errors";
import { getEngineConfig } from "../core/config";
import { createLogger, errField } from "../core/logger";
import { COMPLEXITY_TIERS, type ComplexityTier } from "../models/enums";
import type { EngineAgentVersionDoc, SubAgentRef } from "../models/agentVersion.model";
import { EngineAgent } from "../models/agent.model";
import { EngineExecution } from "../models/execution.model";
import { enqueueExecution } from "../runtime/enqueue";
import { sanitizeToolName, type ResolvedTool, type ToolContext } from "../tools/types";

const log = createLogger("engine:subagents");

/**
 * Señal de suspensión por subtarea asíncrona. NO es un error: es un control de
 * flujo. El corredor la captura, escribe `waiting_for_subtask` y suelta la
 * ranura. Se modela como excepción porque tiene que atravesar el bucle del
 * grafo y el nodo de herramientas sin que cada capa tenga que propagar un
 * valor de retorno especial.
 */
export class SubtaskSuspension extends Error {
  constructor(
    readonly childExecutionIds: string[],
    readonly toolCallId: string,
    readonly subAgentName: string,
  ) {
    super(`Suspendido esperando subtarea(s): ${childExecutionIds.join(", ")}`);
    this.name = "SubtaskSuspension";
  }
}

/**
 * Corredor de grafo en línea, inyectado desde el arranque. Evita el ciclo de
 * importación grafo -> sub-agentes -> grafo, que en CommonJS deja uno de los
 * dos módulos a medio inicializar y produce el clásico "is not a function" en
 * el primer uso.
 */
export type InlineGraphRunner = (args: {
  version: EngineAgentVersionDoc;
  task: string;
  ctx: ToolContext;
  modelOverride?: string | null;
  toolAllowlist?: string[] | null;
}) => Promise<{ text: string; tokensInput: number; tokensOutput: number }>;

let inlineRunner: InlineGraphRunner | null = null;

export function registerInlineGraphRunner(fn: InlineGraphRunner): void {
  inlineRunner = fn;
}

/**
 * Resuelve el modelo del menú por complejidad. La lista es la CADENA DE
 * RESERVA: se toma el primer modelo disponible de esa etiqueta, y si la
 * etiqueta no tiene ninguno, se baja de nivel. Una elección explícita por
 * llamada gana siempre.
 */
export function resolveModelForComplexity(
  ref: SubAgentRef,
  requested: string | undefined,
): string | null {
  if (!ref.models || ref.models.length === 0) return null;

  const tier = (requested ?? "").toLowerCase();
  if (COMPLEXITY_TIERS.includes(tier as ComplexityTier)) {
    const exact = ref.models.find((m) => m.tier === tier);
    if (exact) return exact.model;
  }

  // Sin etiqueta pedida (o sin modelo para esa etiqueta): se prefiere la media
  // y se cae hacia la más capaz. Bajar a la más barata por defecto degradaría
  // en silencio una delegación que el autor pensó para tareas difíciles.
  const order: ComplexityTier[] = ["medium", "high", "low"];
  for (const t of order) {
    const hit = ref.models.find((m) => m.tier === t);
    if (hit) return hit.model;
  }
  return ref.models[0].model;
}

/**
 * Construye las herramientas de delegación de una versión.
 *
 * VALIDACIÓN DE PROPIEDAD: cablear como sub-agente un agente de otro inquilino
 * sin concesión es un error de validación y no una advertencia. El identificador
 * viene del cliente y el runtime lo EJECUTA: sin esta comprobación, cualquiera
 * con permiso de editar un agente puede ejecutar agentes ajenos con las
 * credenciales de su propia sesión.
 */
export async function buildSubAgentTools(
  version: EngineAgentVersionDoc,
  opts: { tenantId: string | null },
): Promise<ResolvedTool[]> {
  const refs = version.subAgents ?? [];
  if (refs.length === 0) return [];

  const targets = await EngineAgent.find({
    agentId: { $in: refs.map((r) => r.agentId) },
    deletedAt: null,
  }).lean();
  const byId = new Map(targets.map((a) => [a.agentId, a]));

  const tools: ResolvedTool[] = [];

  for (const ref of refs) {
    const target = byId.get(ref.agentId);
    if (!target) {
      throw new ValidationError(
        `El sub-agente "${ref.name}" apunta a un agente inexistente (${ref.agentId})`,
      );
    }
    // Global de plataforma o del propio inquilino. Cualquier otra cosa se
    // rechaza al construir el grafo, no al ejecutar.
    const owned = target.tenantId === null || target.tenantId === opts.tenantId;
    if (!owned) {
      throw new ValidationError(
        `El sub-agente "${ref.name}" pertenece a otro inquilino y no hay concesión para usarlo`,
      );
    }

    tools.push(makeDelegationTool(ref, version));
  }

  return tools;
}

function makeDelegationTool(ref: SubAgentRef, parentVersion: EngineAgentVersionDoc): ResolvedTool {
  const hasMenu = (ref.models?.length ?? 0) > 0;

  const properties: Record<string, unknown> = {
    task: {
      type: "string",
      description:
        "La subtarea COMPLETA y autocontenida. El sub-agente no ve esta conversación: " +
        "incluí todo el contexto, los datos y el formato de respuesta que necesita.",
    },
  };
  if (hasMenu) {
    properties.complexity = {
      type: "string",
      enum: [...COMPLEXITY_TIERS],
      description:
        "Complejidad de la subtarea. Determina qué modelo la atiende: " +
        "'low' para tareas mecánicas, 'high' para razonamiento profundo.",
    };
  }

  return {
    name: sanitizeToolName(ref.name),
    description:
      ref.description ||
      `Delega una subtarea autocontenida al sub-agente "${ref.name}".`,
    inputSchema: { type: "object", properties, required: ["task"] },
    type: "sub_agent",
    scope: "tenant",
    origin: "sub_agent",
    // Una delegación puede escribir: se serializa por defecto.
    concurrency: "write",
    execute: async (args, ctx) => delegate(ref, parentVersion, args, ctx),
  };
}

async function delegate(
  ref: SubAgentRef,
  parentVersion: EngineAgentVersionDoc,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const cfg = getEngineConfig();
  const task = String(args.task ?? "").trim();
  if (!task) {
    return { ok: false, error: "La subtarea vino vacía. Redactá la tarea completa en 'task'." };
  }

  // Profundidad ACOTADA: se incrementa por nivel con tope configurable, lo que
  // permite incluso la auto-recursión (un agente que se delega a sí mismo) sin
  // bucle infinito.
  const maxDepth = ref.maxDepth ?? cfg.execution.maxSubAgentDepth;
  const childDepth = ctx.depth + 1;
  if (childDepth > maxDepth) {
    return {
      ok: false,
      error: `Se alcanzó la profundidad máxima de delegación (${maxDepth}). Resolvé esta parte vos mismo.`,
    };
  }

  const modelOverride = resolveModelForComplexity(ref, args.complexity as string | undefined);

  try {
    if (ref.mode === "inline") {
      return await runInline(ref, task, ctx, modelOverride);
    }

    const { execution } = await enqueueExecution({
      agentId: ref.agentId,
      // AISLAMIENTO DE CONTEXTO: el hijo recibe la tarea y nada más.
      input: { task, parentAgentPath: ctx.agentPath },
      inputText: task,
      tenantId: ctx.tenantId,
      userId: ctx.userId ?? null,
      trigger: "sub_agent",
      parentExecutionId: ctx.executionId,
      depth: childDepth,
      // Los hijos van con prioridad alta: un hijo lento bloquea a su padre, que
      // ya consumió recursos. Terminarlo libera más de lo que cuesta.
      priority: 10,
    });

    ctx.emit?.("sub_agent_started", {
      subAgent: ref.name,
      mode: ref.mode,
      childExecutionId: execution.executionId,
    });

    if (ref.mode === "async") {
      // Levanta la interrupción y RETORNA: libera la ranura del carril.
      throw new SubtaskSuspension([execution.executionId], String(args.__toolCallId ?? ""), ref.name);
    }

    return await pollRemote(execution.executionId, ref, ctx);
  } catch (err) {
    if (err instanceof SubtaskSuspension) throw err;
    log.warn("la delegación falló", { subAgent: ref.name, ...errField(err) });
    // ERRORES COMO DATOS, no como excepción: el padre decide qué hacer.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      subAgent: ref.name,
    };
  }
}

async function runInline(
  ref: SubAgentRef,
  task: string,
  ctx: ToolContext,
  modelOverride: string | null,
): Promise<unknown> {
  if (!inlineRunner) {
    return {
      ok: false,
      error: "El corredor de grafos en línea no está registrado en este proceso.",
    };
  }

  const agent = await EngineAgent.findOne({ agentId: ref.agentId, deletedAt: null }).lean();
  if (!agent?.activeVersionId) {
    return { ok: false, error: `El sub-agente "${ref.name}" no tiene versión activa.` };
  }

  const { EngineAgentVersion } = await import("../models/agentVersion.model");
  const childVersion = await EngineAgentVersion.findOne({
    versionId: agent.activeVersionId,
  }).lean();
  if (!childVersion) {
    return { ok: false, error: `No se encontró la versión activa de "${ref.name}".` };
  }

  const result = await inlineRunner({
    version: childVersion as EngineAgentVersionDoc,
    task,
    ctx: {
      ...ctx,
      agentId: ref.agentId,
      depth: ctx.depth + 1,
      // La ruta de agentes es lo que atribuye el costo de un paso al
      // sub-agente que lo produjo, aunque la propiedad del gasto quede en la
      // ejecución padre.
      agentPath: `${ctx.agentPath}/${ref.name}`,
    },
    modelOverride,
    toolAllowlist: ref.toolAllowlist?.length ? ref.toolAllowlist : null,
  });

  ctx.emit?.("sub_agent_completed", { subAgent: ref.name, mode: "inline" });
  return compressOutput(result.text, ref.name);
}

async function pollRemote(
  childExecutionId: string,
  ref: SubAgentRef,
  ctx: ToolContext,
): Promise<unknown> {
  const cfg = getEngineConfig();
  const timeoutMs = (ref.timeoutSeconds ?? cfg.execution.defaultTimeoutSeconds) * 1000;
  const deadline = Date.now() + timeoutMs;
  // Sondeo con retroceso: arranca ágil (una subtarea corta responde rápido) y
  // se relaja para no martillar la base en las largas.
  let waitMs = 250;

  while (Date.now() < deadline) {
    if (ctx.signal?.cancelled) {
      return { ok: false, error: "La corrida padre fue cancelada mientras esperaba la subtarea." };
    }

    const child = await EngineExecution.findOne(
      { executionId: childExecutionId },
      { status: 1, outputText: 1, output: 1, errorMessage: 1 },
    ).lean();

    if (!child) return { ok: false, error: "La subtarea desapareció." };

    // Se compara contra "dejá de esperar", NO contra los finales: si el hijo
    // se suspendió esperando una aprobación humana, seguir sondeando los
    // estados finales dejaría al padre girando hasta el tiempo límite.
    const { shouldStopWaiting } = await import("../models/enums");
    if (shouldStopWaiting(child.status)) {
      ctx.emit?.("sub_agent_completed", {
        subAgent: ref.name,
        mode: "remote",
        status: child.status,
      });
      if (child.status === "succeeded") {
        return compressOutput(child.outputText ?? JSON.stringify(child.output ?? null), ref.name);
      }
      return {
        ok: false,
        status: child.status,
        error: child.errorMessage ?? `La subtarea terminó en estado "${child.status}".`,
      };
    }

    await new Promise((r) => setTimeout(r, waitMs));
    waitMs = Math.min(waitMs * 1.5, 3_000);
  }

  return { ok: false, error: `La subtarea superó el tiempo límite (${timeoutMs} ms).` };
}

/**
 * COMPRESIÓN DE SALIDA antes de devolver al padre. Un sub-agente puede producir
 * miles de tokens; inyectarlos crudos en el contexto del padre consume el
 * presupuesto que el padre necesita para razonar sobre el resultado.
 */
const MAX_SUBAGENT_OUTPUT_CHARS = 12_000;

function compressOutput(text: string, subAgentName: string): unknown {
  const value = text ?? "";
  if (value.length <= MAX_SUBAGENT_OUTPUT_CHARS) {
    return { ok: true, subAgent: subAgentName, result: value };
  }
  return {
    ok: true,
    subAgent: subAgentName,
    truncated: true,
    originalLength: value.length,
    result: value.slice(0, MAX_SUBAGENT_OUTPUT_CHARS),
    note: "Respuesta del sub-agente truncada. Pedile un resumen más corto si necesitás el resto.",
  };
}
