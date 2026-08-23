/**
 * Contratos del motor de grafos (§11).
 *
 * Un grafo compilado es una función de `GraphState` a `GraphResult` con acceso
 * a `GraphDeps`. La separación entre estado y dependencias es lo que hace que
 * un punto de control sea posible: el ESTADO es serializable y se guarda; las
 * DEPENDENCIAS (cliente del modelo, herramientas cableadas, grabador de pasos)
 * se reconstruyen en cada reclamo y jamás se persisten.
 *
 * Esa frontera es también la que sostiene el invariante §35.8: los secretos
 * viven en las dependencias, que no se serializan. Si una credencial entrara al
 * estado del grafo, terminaría escrita en el punto de control de la fila de la
 * ejecución, legible por cualquiera que pueda leer esa corrida.
 */
import type { GraphType } from "../models/enums";
import type { ResolvedTool, ToolContext } from "../tools/types";
import type { StepRecorder } from "../runtime/stepRecorder";
import type { EngineAgentVersionDoc } from "../models/agentVersion.model";

/** Mensaje en el formato del proveedor. El contenido puede ser texto o bloques. */
export interface GraphMessage {
  role: "user" | "assistant";
  content: unknown;
}

/** ESTADO: serializable, va al punto de control. */
export interface GraphState {
  messages: GraphMessage[];
  /** Iteraciones del bucle consumidas. Se conserva al reanudar. */
  iteration: number;
  /** Turnos del asistente, para la interrupción por conteo de turnos. */
  turnCount: number;
  /**
   * Turno en el que se interrumpió por última vez. Existe para que reanudar no
   * vuelva a interrumpir en el mismo punto (bucle de aprobación infinito) sin
   * tener que falsear `turnCount`, que descuadraría la cadencia real: inflar el
   * contador hace que la siguiente interrupción llegue un turno antes de lo
   * que el autor declaró.
   */
  lastInterruptTurn: number;
  /** Texto acumulado de la última iteración. */
  lastText: string;
}

/** DEPENDENCIAS: no serializables, se reconstruyen en cada reclamo. */
export interface GraphDeps {
  version: EngineAgentVersionDoc;
  /** Prefijo ESTABLE del prompt. Lleva el punto de caché. */
  systemStatic: string;
  /** Cola volátil del prompt: contexto, memoria, especialización del turno. */
  systemDynamic: string;
  tools: ResolvedTool[];
  /** Modelo efectivo del turno, ya resuelto contra menú y visión. */
  model: string;
  recorder: StepRecorder;
  toolContext: ToolContext;
  emit: (type: string, payload: Record<string, unknown>) => void;
  /** Revisada en cada borde de superpaso. */
  signal: GraphSignal;
}

/**
 * Señal de control revisada en cada BORDE DE SUPERPASO (§10.3, paso 11). Es un
 * objeto mutable y no una promesa porque el chequeo tiene que ser síncrono y
 * baratísimo: se hace varias veces por turno.
 */
export interface GraphSignal {
  cancelled: boolean;
  pauseRequested: boolean;
  /** Instante en que la corrida debe abandonar, venga de donde venga. */
  deadline: number;
}

export type GraphOutcome =
  | { kind: "completed"; text: string; stopReason: string }
  | { kind: "interrupted"; interrupt: InterruptDescriptor; stopReason: string }
  | { kind: "suspended"; childExecutionIds: string[]; stopReason: string }
  | { kind: "paused"; stopReason: string }
  | { kind: "cancelled"; stopReason: string };

/** Lo que la interfaz necesita para preguntarle al humano. */
export interface InterruptDescriptor {
  reason: "tool_call" | "turn_count";
  message: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  turnCount?: number;
}

export interface GraphResult {
  outcome: GraphOutcome;
  /** Estado final, para el punto de control. */
  state: GraphState;
}

export interface CompiledGraph {
  type: GraphType;
  run(state: GraphState, deps: GraphDeps): Promise<GraphResult>;
  /** Instantánea de la topología. Se guarda en la ejecución para depurar. */
  snapshot(): Record<string, unknown>;
}

export function emptyState(userContent: unknown): GraphState {
  return {
    messages: [{ role: "user", content: userContent }],
    iteration: 0,
    turnCount: 0,
    lastInterruptTurn: 0,
    lastText: "",
  };
}
