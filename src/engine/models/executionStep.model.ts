/**
 * `engine_execution_steps` — un paso de nodo (§6.3).
 *
 * El paso es la unidad de observabilidad: el árbol de pasos ES el depurador.
 * Tres detalles que no son obvios y que valen su peso:
 *
 *  1. `toolCallId` está PROMOVIDO fuera del JSON de entrada. Si viviera adentro
 *     del blob, emparejar una llamada con su resultado requeriría escanear.
 *  2. `groupId` agrupa las llamadas concurrentes de UN turno del modelo. Sin él
 *     no se puede distinguir "el modelo pidió 3 tools de una" de "el modelo
 *     pidió 3 tools en 3 turnos".
 *  3. `execStartedAt` / `execCompletedAt` son la ventana REAL. El orden de
 *     petición no muestra el solapamiento: dos tools que corrieron en paralelo
 *     se ven idénticas a dos secuenciales si sólo se mira el orden.
 */
import { Schema, model, type Model } from "mongoose";
import {
  CONCURRENCY_MODES,
  STEP_KINDS,
  STEP_OUTCOMES,
  type ConcurrencyMode,
  type StepKind,
  type StepOutcome,
} from "./enums";

export interface EngineExecutionStepDoc {
  stepId: string;
  executionId: string;
  tenantId: string | null;

  /** Orden de creación dentro de la ejecución. Denso, empieza en 0. */
  index: number;
  kind: StepKind;
  name: string;
  outcome: StepOutcome;

  // --- Instrumentación de paralelismo ---
  /** Un id por turno del modelo: agrupa sus llamadas concurrentes. */
  groupId?: string | null;
  /** Promovido fuera del JSON para poder emparejar por índice. */
  toolCallId?: string | null;
  concurrencyMode?: ConcurrencyMode | null;
  execStartedAt?: Date | null;
  execCompletedAt?: Date | null;
  durationMs: number;

  // --- Atribución ---
  /** Qué agente ejecutó este paso (puede ser un sub-agente en línea). */
  executedByAgentId?: string | null;
  /** Ruta de agentes: `raiz/analista/buscador`. Atribuye costo en delegación. */
  agentPath?: string | null;

  // --- Consumo del paso ---
  model?: string | null;
  provider?: string | null;
  serviceTier?: string | null;
  stopReason?: string | null;
  tokensInput: number;
  tokensOutput: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;

  /** Resumen liviano. La carga cruda vive en la tabla fría con TTL. */
  input?: unknown;
  output?: unknown;
  errorMessage?: string | null;

  createdAt: Date;
}

const stepSchema = new Schema<EngineExecutionStepDoc>(
  {
    stepId: { type: String, required: true, unique: true, index: true },
    executionId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null, index: true },

    index: { type: Number, required: true },
    kind: { type: String, enum: STEP_KINDS, required: true },
    name: { type: String, required: true },
    outcome: { type: String, enum: STEP_OUTCOMES, default: "success" },

    groupId: { type: String, default: null },
    toolCallId: { type: String, default: null, index: true },
    concurrencyMode: { type: String, enum: CONCURRENCY_MODES, default: null },
    execStartedAt: { type: Date, default: null },
    execCompletedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },

    executedByAgentId: { type: String, default: null },
    agentPath: { type: String, default: null },

    model: { type: String, default: null },
    provider: { type: String, default: null },
    serviceTier: { type: String, default: null },
    stopReason: { type: String, default: null },
    tokensInput: { type: Number, default: 0 },
    tokensOutput: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },

    input: { type: Schema.Types.Mixed, default: null },
    output: { type: Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: null },
  },
  // Historia: sin `updatedAt`, sin borrado suave.
  { timestamps: { createdAt: true, updatedAt: false }, collection: "engine_execution_steps" },
);

/** El depurador siempre pide los pasos de UNA ejecución, en orden. */
stepSchema.index({ executionId: 1, index: 1 }, { unique: true });

export const EngineExecutionStep: Model<EngineExecutionStepDoc> = model<EngineExecutionStepDoc>(
  "EngineExecutionStep",
  stepSchema,
);

export function sanitizeStep(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
