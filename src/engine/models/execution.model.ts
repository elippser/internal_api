/**
 * `engine_executions` — una corrida (§6.3).
 *
 * Es la fila más cargada del sistema porque concentra cuatro cosas que en
 * conjunto permiten responder "¿qué pasó?" sin adivinar: linaje, reclamo,
 * tiempos y diagnóstico. Vale la pena leer los bloques en ese orden.
 *
 * No lleva borrado suave: es un registro histórico (§6.1).
 */
import { Schema, model, type Model } from "mongoose";
import {
  EXECUTION_LANES,
  EXECUTION_STATUSES,
  EXECUTION_TRIGGERS,
  FAILURE_REASONS,
  RESPONSE_MODES,
  type ExecutionLane,
  type ExecutionStatus,
  type ExecutionTrigger,
  type FailureReason,
  type ResponseMode,
} from "./enums";

/**
 * Descomposición NO SOLAPADA de la latencia. Que no se solapen es el punto:
 * suman `active_ms` y por lo tanto se pueden graficar apiladas. Si `llm_ms`
 * incluyera el tiempo de las tools, el gráfico mentiría.
 */
export interface PhaseTimings {
  queueMs: number;
  setupMs: number;
  llmMs: number;
  toolMs: number;
  overheadMs: number;
  finalizeMs: number;
}

export interface FailureDetails {
  workerId?: string | null;
  signal?: string | null;
  engineVersion?: string | null;
  lastHeartbeatAt?: Date | null;
  recoveredByExecutionId?: string | null;
  [key: string]: unknown;
}

export interface EngineExecutionDoc {
  executionId: string;

  // --- Identidad y ámbito ---
  agentId: string;
  /** La versión que REALMENTE corrió. Estampada al crear, nunca recalculada. */
  versionId: string;
  tenantId: string | null;
  organizationId: string | null;
  userId?: string | null;
  sessionId?: string | null;

  // --- Linaje (§6.3) ---
  parentExecutionId?: string | null;
  /** Raíz de la cadena de reintentos. Un reintento del reintento apunta al original. */
  originalRunId?: string | null;
  attempt: number;
  /**
   * Enlace CONFIABLE a la tarea que la disparó. No se acepta desde el cuerpo de
   * la petición: si el cliente pudiera declararlo, podría falsificar la
   * atribución de autoría y ver tareas de otro.
   */
  sourceScheduledTaskId?: string | null;
  trigger: ExecutionTrigger;
  /** Profundidad de delegación. Se compara contra el tope al crear un hijo. */
  depth: number;

  // --- Encolado y reclamo (§10.2) ---
  status: ExecutionStatus;
  /**
   * ESTAMPADO AL CREAR, derivado del tipo de grafo de la versión (§35.3). Si un
   * sitio de creación lo omite, la corrida aterriza en un carril sin las
   * capacidades que necesita y muere de forma opaca.
   */
  lane: ExecutionLane;
  priority: number;
  workerId?: string | null;
  heartbeatAt?: Date | null;
  /** Único y disperso: dos POST con la misma clave devuelven la misma corrida. */
  idempotencyKey?: string | null;
  /** Para el despertador: no reclamar antes de este instante. */
  scheduledFor?: Date | null;

  // --- Entrada / salida ---
  input: Record<string, unknown>;
  output?: unknown;
  /** Turno del usuario en texto plano, para el historial y el enrutado. */
  inputText?: string | null;
  outputText?: string | null;

  // --- Tiempos (§6.3) ---
  /** Primer reclamo. ESTABLE: una reanudación no lo pisa. */
  startedAt?: Date | null;
  /** Comienzo del tramo actual. Se resetea en cada reanudación. */
  legStartedAt?: Date | null;
  graphStartedAt?: Date | null;
  completedAt?: Date | null;
  timeoutAt?: Date | null;
  /**
   * Trabajo real acumulado, EXCLUYENDO cola y suspensión. Un turno que esperó
   * dos horas la aprobación de un humano no tardó dos horas: tardó `activeMs`.
   */
  activeMs: number;
  phaseTimings: PhaseTimings;

  // --- Consumo (§24) ---
  tokensInput: number;
  tokensOutput: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /**
   * Equivalente de API cuando el gasto real lo cubre una suscripción. JAMÁS se
   * suma al costo ni al presupuesto: es una métrica de referencia, no plata.
   */
  costUsdNotional: number;

  // --- Diagnóstico (§23) ---
  errorMessage?: string | null;
  failureReason?: FailureReason | null;
  failureDetails?: FailureDetails | null;
  /** El texto EXACTO que se le mandó al modelo. Sin esto no se depura nada. */
  resolvedSystemPrompt?: string | null;
  graphSnapshot?: Record<string, unknown> | null;
  resolvedVersions?: Record<string, string> | null;
  stepCount: number;

  // --- Control (§10.6) ---
  /**
   * BANDERA, no estado (§35.5). La API la levanta; el estado `paused` sólo lo
   * escribe el trabajador cuando ya soltó la fila. Si la API escribiera el
   * estado, se reanudaría una corrida que todavía tiene un worker adentro.
   */
  pauseRequested: boolean;
  cancelRequested: boolean;
  responseMode: ResponseMode;
  callbackUrl?: string | null;

  /** Carga del humano al reanudar una interrupción de aprobación. */
  resumePayload?: unknown;
  /** Descriptor de la interrupción vigente, para que la UI sepa qué preguntar. */
  interrupt?: Record<string, unknown> | null;
  /** Punto de control del grafo para reanudar sin re-ejecutar efectos. */
  checkpoint?: Record<string, unknown> | null;

  createdAt: Date;
  updatedAt: Date;
}

const phaseTimingsSchema = new Schema<PhaseTimings>(
  {
    queueMs: { type: Number, default: 0 },
    setupMs: { type: Number, default: 0 },
    llmMs: { type: Number, default: 0 },
    toolMs: { type: Number, default: 0 },
    overheadMs: { type: Number, default: 0 },
    finalizeMs: { type: Number, default: 0 },
  },
  { _id: false },
);

const executionSchema = new Schema<EngineExecutionDoc>(
  {
    executionId: { type: String, required: true, unique: true, index: true },

    agentId: { type: String, required: true, index: true },
    versionId: { type: String, required: true },
    tenantId: { type: String, default: null, index: true },
    organizationId: { type: String, default: null },
    userId: { type: String, default: null, index: true },
    sessionId: { type: String, default: null, index: true },

    parentExecutionId: { type: String, default: null, index: true },
    originalRunId: { type: String, default: null, index: true },
    attempt: { type: Number, default: 0 },
    sourceScheduledTaskId: { type: String, default: null, index: true },
    trigger: { type: String, enum: EXECUTION_TRIGGERS, default: "api" },
    depth: { type: Number, default: 0 },

    status: { type: String, enum: EXECUTION_STATUSES, default: "queued", index: true },
    lane: { type: String, enum: EXECUTION_LANES, required: true, index: true },
    priority: { type: Number, default: 0 },
    workerId: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: null },
    scheduledFor: { type: Date, default: null },

    input: { type: Schema.Types.Mixed, default: {} },
    output: { type: Schema.Types.Mixed, default: null },
    inputText: { type: String, default: null },
    outputText: { type: String, default: null },

    startedAt: { type: Date, default: null },
    legStartedAt: { type: Date, default: null },
    graphStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    timeoutAt: { type: Date, default: null },
    activeMs: { type: Number, default: 0 },
    phaseTimings: { type: phaseTimingsSchema, default: () => ({}) },

    tokensInput: { type: Number, default: 0 },
    tokensOutput: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    costUsdNotional: { type: Number, default: 0 },

    errorMessage: { type: String, default: null },
    failureReason: { type: String, enum: FAILURE_REASONS, default: null },
    failureDetails: { type: Schema.Types.Mixed, default: null },
    resolvedSystemPrompt: { type: String, default: null },
    graphSnapshot: { type: Schema.Types.Mixed, default: null },
    resolvedVersions: { type: Schema.Types.Mixed, default: null },
    stepCount: { type: Number, default: 0 },

    pauseRequested: { type: Boolean, default: false },
    cancelRequested: { type: Boolean, default: false },
    responseMode: { type: String, enum: RESPONSE_MODES, default: "async" },
    callbackUrl: { type: String, default: null },

    resumePayload: { type: Schema.Types.Mixed, default: null },
    interrupt: { type: Schema.Types.Mixed, default: null },
    checkpoint: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: "engine_executions" },
);

/**
 * ÍNDICE DEL RECLAMO. Es el índice más importante del motor: lo usa el
 * `findOneAndUpdate` atómico del bucle de trabajo en cada tick de cada worker.
 * El orden de las claves es el orden del predicado + el orden del sort, para
 * que Mongo no tenga que ordenar en memoria bajo carga.
 */
executionSchema.index({ status: 1, lane: 1, scheduledFor: 1, priority: -1, createdAt: 1 });

/** Barrido del detector de zombies: corridas en curso con latido viejo. */
executionSchema.index({ status: 1, heartbeatAt: 1 });

/** Despertador: encontrar padres suspendidos esperando a un hijo concreto. */
executionSchema.index({ status: 1, parentExecutionId: 1 });

/** Clave de idempotencia: disperso, para que las corridas sin clave no colisionen. */
executionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

/** Listados de la consola: por inquilino y por agente, más recientes primero. */
executionSchema.index({ tenantId: 1, createdAt: -1 });
executionSchema.index({ agentId: 1, createdAt: -1 });
executionSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const EngineExecution: Model<EngineExecutionDoc> = model<EngineExecutionDoc>(
  "EngineExecution",
  executionSchema,
);

export function sanitizeExecution(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  // El punto de control es estado interno del grafo: puede contener el
  // transcripto completo y no aporta nada a un cliente. Se expone por el
  // depurador, no por el listado.
  delete obj.checkpoint;
  return obj;
}

export const EMPTY_PHASE_TIMINGS: PhaseTimings = {
  queueMs: 0,
  setupMs: 0,
  llmMs: 0,
  toolMs: 0,
  overheadMs: 0,
  finalizeMs: 0,
};
