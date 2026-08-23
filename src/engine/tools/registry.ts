/**
 * Registro EN MEMORIA de herramientas de código, y la lista de permitidos por
 * capacidad (§12.2, §12.3).
 *
 * Dos mecanismos distintos que conviven acá:
 *
 * 1. REGISTRO. Nivel 1 de la resolución. Herramientas definidas en código y
 *    registradas al arrancar. Ganan sobre el catálogo del inquilino y sobre el
 *    global: si alguien crea por API una fila llamada `think`, la de código
 *    sigue siendo la que corre.
 *
 * 2. LISTA DE PERMITIDOS POR CAPACIDAD. Un subconjunto de herramientas NUNCA
 *    aparece en el catálogo ni en el selector: llegan al agente sólo si tiene
 *    activada la capacidad correspondiente (§35.11). La lista es de nombres
 *    EXACTOS, no de prefijos, y eso es deliberado: un prefijo `memory_`
 *    capturaría una herramienta del usuario llamada `memory_export` y le
 *    entregaría al agente algo que nadie le concedió.
 *
 * `assertAllowlistIntegrity()` es la prueba de deriva: exige que registrado ⟺
 * en la lista. Sin ella el modo de falla es silencioso en las dos direcciones —
 * una herramienta registrada y no listada nunca llega a ningún agente, y una
 * listada y no registrada rompe el arranque del grafo de todo agente que
 * active la capacidad.
 */
import type { RuntimeCapability } from "../models/enums";
import { createLogger } from "../core/logger";
import type { ResolvedTool } from "./types";

const log = createLogger("engine:tools:registry");

const registry = new Map<string, ResolvedTool>();

/**
 * MAPA DE CAPACIDADES -> nombres exactos. Agregar una capacidad de runtime es
 * agregar una entrada acá, registrar las herramientas y cablear el efecto en el
 * corredor (receta §34).
 */
const CAPABILITY_TOOLS: Record<RuntimeCapability, readonly string[]> = {
  memory: [
    "memory_search",
    "memory_ask",
    "memory_learn",
    "memory_forget",
    "memory_gap",
    "graph_relate",
    "graph_neighbors",
    "graph_traverse",
    "graph_path",
  ],
  agent_conversation: ["talk_to_agent"],
  auto_title: [],
  image_generation: ["generate_image"],
  self_scheduling: ["schedule_task", "list_my_tasks", "cancel_my_task"],
  quality_inspection: ["inspect_execution", "list_execution_steps"],
  // Estas dos son herramientas de SERVIDOR: no se registran acá porque no las
  // ejecuta el motor. La fábrica las construye a partir del catálogo del modelo.
  web_search: [],
  code_execution: [],
};

const CAPABILITY_MANAGED_NAMES: ReadonlySet<string> = new Set(
  Object.values(CAPABILITY_TOOLS).flat(),
);

/**
 * Capacidades DECLARADAS pero cuyas herramientas pertenecen a secciones fuera
 * de esta entrega (memoria §17, conversación entre agentes, generación de
 * imágenes, auto-agenda §20).
 *
 * Se distinguen de la deriva real a propósito. La deriva es un DEFECTO: alguien
 * cambió el registro y rompió una capacidad que funcionaba. Esto es una
 * AUSENCIA PLANIFICADA. Mezclarlas haría que el arranque escupiera catorce
 * advertencias todos los días, y una alarma que suena siempre deja de leerse —
 * justo cuando aparezca la deriva de verdad, nadie la va a ver.
 *
 * El vocabulario de autoría publica esta lista para que la consola muestre esas
 * capacidades como "próximamente" en vez de ofrecer un interruptor que rompe el
 * grafo al activarse.
 */
const PENDING_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
  "memory",
  "agent_conversation",
  "image_generation",
  "self_scheduling",
]);

export function isPendingCapability(capability: RuntimeCapability): boolean {
  return PENDING_CAPABILITIES.has(capability);
}

export function pendingCapabilities(): RuntimeCapability[] {
  return [...PENDING_CAPABILITIES];
}

/** Registra una herramienta de código. Idempotente por nombre. */
export function registerCodeTool(tool: ResolvedTool): void {
  if (registry.has(tool.name)) {
    log.warn("herramienta ya registrada, se reemplaza", { name: tool.name });
  }
  registry.set(tool.name, tool);
}

export function getCodeTool(name: string): ResolvedTool | undefined {
  return registry.get(name);
}

export function listCodeTools(): ResolvedTool[] {
  return [...registry.values()];
}

/** ¿Este nombre está gobernado por una capacidad? (no puede pedirse por catálogo) */
export function isCapabilityManaged(name: string): boolean {
  return CAPABILITY_MANAGED_NAMES.has(name);
}

/** Nombres que entrega una capacidad activa. */
export function toolsForCapability(capability: RuntimeCapability): readonly string[] {
  return CAPABILITY_TOOLS[capability] ?? [];
}

export function capabilityMap(): Record<string, readonly string[]> {
  return { ...CAPABILITY_TOOLS };
}

/**
 * Prueba de deriva: registrado ⟺ en la lista de permitidos.
 *
 * Se corre al arrancar y ADVIERTE en vez de tumbar el proceso. Es un juicio
 * consciente: una herramienta de capacidad faltante degrada a un agente, pero
 * tirar abajo la API entera degrada a todos. El aviso es ruidoso a propósito
 * para que se note en el primer arranque tras el cambio.
 */
export function assertAllowlistIntegrity(): {
  ok: boolean;
  problems: string[];
  pending: string[];
} {
  const problems: string[] = [];
  const pending: string[] = [];

  for (const [capability, names] of Object.entries(CAPABILITY_TOOLS)) {
    const isPending = PENDING_CAPABILITIES.has(capability as RuntimeCapability);
    for (const name of names) {
      if (registry.has(name)) continue;
      if (isPending) {
        pending.push(`${capability}.${name}`);
        continue;
      }
      problems.push(
        `capacidad "${capability}" declara "${name}" pero no está registrada: ` +
          `todo agente con esa capacidad va a fallar al construir el grafo`,
      );
    }
  }

  for (const name of registry.keys()) {
    // Las herramientas de uso general (think, handoff) no pertenecen a ninguna
    // capacidad y se piden por catálogo: sólo se exige la ida, no la vuelta,
    // para las que SÍ declaran ser gestionadas por capacidad.
    if (registry.get(name)?.origin === "capability" && !CAPABILITY_MANAGED_NAMES.has(name)) {
      problems.push(
        `"${name}" se registró como gestionada por capacidad pero no figura en ninguna lista: ` +
          `nunca va a llegar a un agente`,
      );
    }
  }

  // Deriva real: un defecto. Ruidoso a propósito.
  if (problems.length > 0) {
    log.warn("deriva entre el registro de herramientas y las listas de capacidad", {
      count: problems.length,
      problems,
    });
  }

  // Ausencia planificada: una línea informativa, sin nombres uno por uno.
  if (pending.length > 0) {
    log.info("capacidades declaradas y pendientes de implementación", {
      capabilities: [...PENDING_CAPABILITIES],
      tools: pending.length,
    });
  }

  return { ok: problems.length === 0, problems, pending };
}

/** Sólo para pruebas. */
export function resetRegistry(): void {
  registry.clear();
}
