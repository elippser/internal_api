/**
 * Herramientas de código registradas al arrancar (nivel 1 de la resolución).
 *
 * Dos familias distintas viven acá:
 *  - De uso general (`think`): se piden por catálogo como cualquier otra.
 *  - Gestionadas por capacidad (`inspect_execution`, `list_execution_steps`):
 *    NO existen en el catálogo ni en el selector. Llegan al agente sólo si la
 *    versión activa la capacidad `quality_inspection`, y la lista de permitidos
 *    de `registry.ts` es de nombres exactos (§35.11).
 *
 * Las herramientas de las capacidades que este entrega todavía no implementa
 * (memoria, conversación entre agentes, generación de imágenes, auto-agenda)
 * están declaradas en el mapa de capacidades pero no registradas acá. La prueba
 * de deriva del registro lo reporta al arrancar con el nombre exacto de lo que
 * falta, en vez de dejar que un agente con esa capacidad falle al construir el
 * grafo con un mensaje incomprensible.
 */
import { EngineExecution } from "../models/execution.model";
import { EngineExecutionStep } from "../models/executionStep.model";
import { registerCodeTool } from "./registry";
import type { ResolvedTool, ToolContext } from "./types";

const think: ResolvedTool = {
  name: "think",
  description:
    "Registra un paso de razonamiento explícito antes de actuar. No tiene efectos ni " +
    "consulta nada: sirve para ordenar un plan de varios pasos antes de ejecutarlo.",
  inputSchema: {
    type: "object",
    properties: {
      thought: { type: "string", description: "El razonamiento a registrar." },
    },
    required: ["thought"],
  },
  type: "think",
  scope: "global",
  origin: "registry",
  concurrency: "read",
  execute: async (args) => ({ recorded: true, thought: String(args.thought ?? "") }),
};

/**
 * Introspección de la PROPIA ejecución. Acotada a `ctx.executionId` a
 * propósito: un agente que pudiera inspeccionar corridas arbitrarias sería un
 * canal de fuga entre inquilinos con forma de herramienta.
 */
const inspectExecution: ResolvedTool = {
  name: "inspect_execution",
  description:
    "Devuelve el estado, el consumo y el conteo de pasos de la ejecución actual. " +
    "Útil para decidir si conviene seguir profundizando o cerrar con lo que ya se tiene.",
  inputSchema: { type: "object", properties: {} },
  type: "function",
  scope: "global",
  origin: "capability",
  concurrency: "read",
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    const doc = await EngineExecution.findOne(
      { executionId: ctx.executionId },
      {
        status: 1,
        stepCount: 1,
        tokensInput: 1,
        tokensOutput: 1,
        costUsd: 1,
        activeMs: 1,
        depth: 1,
      },
    ).lean();
    if (!doc) return { error: "ejecución no encontrada" };
    return {
      status: doc.status,
      steps: doc.stepCount,
      tokensInput: doc.tokensInput,
      tokensOutput: doc.tokensOutput,
      costUsd: doc.costUsd,
      activeMs: doc.activeMs,
      depth: doc.depth,
    };
  },
};

const listExecutionSteps: ResolvedTool = {
  name: "list_execution_steps",
  description:
    "Lista los pasos ya ejecutados en esta corrida (herramienta, resultado y duración). " +
    "Sirve para no repetir una llamada que ya se hizo en este mismo turno.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Máximo de pasos a devolver (por defecto 20)." },
    },
  },
  type: "function",
  scope: "global",
  origin: "capability",
  concurrency: "read",
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
    const steps = await EngineExecutionStep.find(
      { executionId: ctx.executionId },
      { index: 1, kind: 1, name: 1, outcome: 1, durationMs: 1, errorMessage: 1 },
    )
      .sort({ index: -1 })
      .limit(limit)
      .lean();
    return steps.reverse().map((s) => ({
      index: s.index,
      kind: s.kind,
      name: s.name,
      outcome: s.outcome,
      durationMs: s.durationMs,
      ...(s.errorMessage ? { error: s.errorMessage } : {}),
    }));
  },
};

/**
 * NIVEL 2 de la revelación progresiva (§19). El nivel 1 (nombre + descripción)
 * ya está en el prompt; esta herramienta trae el cuerpo, y sólo cuando el
 * modelo decide que le sirve.
 *
 * Es una herramienta de uso general y no gestionada por capacidad a propósito:
 * si sólo llegara con una capacidad activa, un agente con habilidades
 * declaradas pero sin esa capacidad vería la lista en el prompt y no tendría
 * forma de cargar ninguna — la peor combinación posible.
 */
const loadSkill: ResolvedTool = {
  name: "load_skill",
  description:
    "Carga el instructivo completo de una habilidad de la lista disponible. " +
    "Usala cuando la tarea coincide con lo que describe una habilidad; no la cargues por las dudas.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nombre exacto de la habilidad a cargar." },
    },
    required: ["name"],
  },
  type: "function",
  scope: "global",
  origin: "registry",
  concurrency: "read",
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const { loadSkillBody } = await import("../skills/resolver");
    return loadSkillBody(String(args.name ?? ""), {
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      declared: ctx.declaredSkills,
    });
  },
};

let registered = false;

/**
 * Sincroniza las herramientas de código al registro. Idempotente: el arranque
 * de la API la llama y el worker también, y en la topología in-process son el
 * mismo proceso.
 */
export function registerBuiltinTools(): void {
  if (registered) return;
  registered = true;
  registerCodeTool(think);
  registerCodeTool(loadSkill);
  registerCodeTool(inspectExecution);
  registerCodeTool(listExecutionSteps);
}

/** Sólo para pruebas. */
export function resetBuiltins(): void {
  registered = false;
}
