/**
 * Taxonomía del dominio del motor. TODO el vocabulario vive acá: los modelos,
 * los servicios, el worker y la API lo importan de este archivo y de ningún
 * otro lado.
 *
 * El archivo existe por el invariante §35.4: "terminó" y "dejá de esperar" son
 * conceptos distintos, y confundirlos fue una fuente real de defectos. La
 * defensa estructural es que hay UNA lista editable a mano (los estados de
 * espera y los finales de ciclo de vida) y todas las demás se DERIVAN. Agregar
 * un estado suspendido nuevo se hace en un solo lugar; olvidarse de sumarlo a
 * "dejar de esperar" pasa a ser imposible en vez de ser un bug silencioso que
 * cuelga un sondeo para siempre.
 */

// ---------------------------------------------------------------------------
// Ciclo de vida de la ejecución (§10.1)
// ---------------------------------------------------------------------------

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "waiting_for_input",
  "waiting_for_subtask",
  "paused",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * FUENTE ÚNICA 1 — estados de espera. La corrida está viva pero suspendida.
 * Un estado suspendido nuevo se agrega SÓLO acá.
 */
export const WAITING_STATUSES = [
  "waiting_for_input",
  "waiting_for_subtask",
  "paused",
] as const satisfies readonly ExecutionStatus[];

/**
 * FUENTE ÚNICA 2 — finales de ciclo de vida. La corrida terminó, para siempre.
 * Denominador de alertas, compuerta de reintento, cierre de WebSocket.
 */
export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const satisfies readonly ExecutionStatus[];

const WAITING_SET: ReadonlySet<ExecutionStatus> = new Set(WAITING_STATUSES);
const TERMINAL_SET: ReadonlySet<ExecutionStatus> = new Set(TERMINAL_STATUSES);

/**
 * DERIVADO — "dejá de esperar": finales ∪ espera. Todo bucle de creación y
 * sondeo y el modo síncrono usan ESTE conjunto, nunca `TERMINAL_STATUSES`.
 * Sondear contra los finales cuelga para siempre en cuanto el grafo levanta una
 * interrupción de aprobación humana.
 */
export const STOP_WAITING_STATUSES: readonly ExecutionStatus[] = [
  ...TERMINAL_STATUSES,
  ...WAITING_STATUSES,
];

/** DERIVADO — en vuelo: complemento de los finales. Compuerta del botón cancelar. */
export const IN_FLIGHT_STATUSES: readonly ExecutionStatus[] = EXECUTION_STATUSES.filter(
  (s) => !TERMINAL_SET.has(s),
);

/**
 * DERIVADO — reanudables por un humano. NO incluye `waiting_for_subtask`: a esa
 * la despierta el bucle de reclamo cuando el hijo termina. Ofrecer un botón
 * "reanudar" ahí produciría una corrida con dos dueños.
 */
export const HUMAN_RESUMABLE_STATUSES: readonly ExecutionStatus[] = WAITING_STATUSES.filter(
  (s) => s !== "waiting_for_subtask",
);

export const isWaiting = (s: ExecutionStatus): boolean => WAITING_SET.has(s);
export const isTerminal = (s: ExecutionStatus): boolean => TERMINAL_SET.has(s);
export const isInFlight = (s: ExecutionStatus): boolean => !TERMINAL_SET.has(s);
export const shouldStopWaiting = (s: ExecutionStatus): boolean =>
  TERMINAL_SET.has(s) || WAITING_SET.has(s);
export const isHumanResumable = (s: ExecutionStatus): boolean =>
  WAITING_SET.has(s) && s !== "waiting_for_subtask";

// ---------------------------------------------------------------------------
// Carriles de reclamo (§10.2)
// ---------------------------------------------------------------------------

/**
 * Carriles DISJUNTOS con conteos de ranuras independientes. Existen para que
 * una avalancha de sub-agentes no ahogue el trabajo de usuario, y para que los
 * hijos tengan progreso garantizado (si compartieran carril con los padres, un
 * padre bloqueado esperando a su hijo podría ocupar la última ranura y trabar
 * el sistema entero).
 */
export const EXECUTION_LANES = ["root", "sub_agent", "coding"] as const;
export type ExecutionLane = (typeof EXECUTION_LANES)[number];

// ---------------------------------------------------------------------------
// Tipos de grafo (§11.1)
// ---------------------------------------------------------------------------

export const GRAPH_TYPES = [
  "react_loop",
  "linear_chain",
  "classifier_router",
  "flow_dag",
  "coding_run",
] as const;
export type GraphType = (typeof GRAPH_TYPES)[number];

/**
 * Subconjunto habilitado para autoría. Los demás siguen en la enumeración y con
 * su punto de construcción intacto para poder revivirlos sin migración, pero el
 * esquema de guardado los rechaza. Restringir en el esquema y no borrar el tipo
 * es deliberado: borrar rompe los agentes ya guardados.
 */
export const AUTHORABLE_GRAPH_TYPES: readonly GraphType[] = ["react_loop"];

// ---------------------------------------------------------------------------
// Herramientas (§12.1)
// ---------------------------------------------------------------------------

export const TOOL_TYPES = [
  "function",
  "http",
  "mcp",
  "search",
  "think",
  "sub_agent",
  "schedule",
  "code_execution",
] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

export const TOOL_SCOPES = ["user", "tenant", "global"] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

/**
 * Clase de concurrencia del nodo de herramientas particionado (§11.2). El nodo
 * agrupa las llamadas del mismo turno del modelo y ejecuta en paralelo lo que
 * puede: las de lectura van todas juntas, las de escritura se serializan entre
 * sí, y una exclusiva corre sola. Sin esta clasificación habría que serializar
 * todo (lento) o paralelizar todo (carreras sobre el mismo recurso del PMS).
 */
export const CONCURRENCY_MODES = ["read", "write", "exclusive"] as const;
export type ConcurrencyMode = (typeof CONCURRENCY_MODES)[number];

// ---------------------------------------------------------------------------
// Sub-agentes (§14)
// ---------------------------------------------------------------------------

export const SUB_AGENT_MODES = ["inline", "remote", "async"] as const;
export type SubAgentMode = (typeof SUB_AGENT_MODES)[number];

/** Etiquetas del menú de modelos por complejidad. */
export const COMPLEXITY_TIERS = ["low", "medium", "high"] as const;
export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];

// ---------------------------------------------------------------------------
// Pasos de ejecución (§6.3)
// ---------------------------------------------------------------------------

export const STEP_KINDS = [
  "llm_call",
  "tool_call",
  "sub_agent_call",
  "guardrail",
  "hook",
  "graph_node",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_OUTCOMES = ["success", "error", "blocked", "cancelled", "skipped"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Diagnóstico (§6.3)
// ---------------------------------------------------------------------------

/**
 * Razón de falla legible por máquina. El texto libre de `errorMessage` es para
 * el humano; esto es lo que agrupa la analítica y dispara las alertas.
 */
export const FAILURE_REASONS = [
  "provider_error",
  "context_overflow",
  "tool_error",
  "guardrail_input",
  "guardrail_output",
  "output_schema",
  "timeout",
  "worker_lost",
  "cancelled_by_user",
  "budget_exceeded",
  "max_iterations",
  "sub_agent_failed",
  "config_error",
  "unknown",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

// ---------------------------------------------------------------------------
// Origen y disparador (§6.4, §20)
// ---------------------------------------------------------------------------

export const EXECUTION_TRIGGERS = [
  "api",
  "session",
  "sub_agent",
  "retry",
  "replay",
  "schedule",
  "webhook",
  "connector",
] as const;
export type ExecutionTrigger = (typeof EXECUTION_TRIGGERS)[number];

export const RESPONSE_MODES = ["async", "sync", "callback"] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

// ---------------------------------------------------------------------------
// Capacidades de runtime (§13)
// ---------------------------------------------------------------------------

/**
 * Banderas de `config.capabilities`. TODAS por defecto apagadas y TODAS
 * cableadas por el corredor. Una capacidad es una compuerta, no un catálogo:
 * las herramientas que entrega no existen en el catálogo del inquilino y no se
 * pueden pedir por nombre (§35.11).
 */
export const RUNTIME_CAPABILITIES = [
  "memory",
  "agent_conversation",
  "auto_title",
  "image_generation",
  "self_scheduling",
  "quality_inspection",
  "web_search",
  "code_execution",
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Roles (§7.3)
// ---------------------------------------------------------------------------

/**
 * Espejo de los roles de internal-laupser. Se replica acá con su rango para que
 * el motor compare pisos (`rol >= developer`) sin importar el middleware HTTP:
 * el filtrado de herramientas por piso de rol corre dentro del grafo, en el
 * worker, donde no hay request.
 */
export const ROLE_RANK: Record<string, number> = {
  support: 1,
  analyst: 2,
  developer: 3,
  admin: 4,
  super_admin: 5,
};

export function meetsRoleFloor(role: string | null | undefined, floor: string | null | undefined): boolean {
  if (!floor) return true;
  const have = ROLE_RANK[role ?? ""] ?? 0;
  const need = ROLE_RANK[floor] ?? 0;
  return have >= need;
}
