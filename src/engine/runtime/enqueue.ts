/**
 * Creación de ejecuciones. La API sólo ENCOLA (§35.2).
 *
 * Este es el único sitio de creación del motor. Que sea único es lo que sostiene
 * el invariante §35.3: el CARRIL SE ESTAMPA AL CREAR, derivado del tipo de grafo
 * de la versión. Si hubiera tres lugares que crean ejecuciones, el tercero se
 * olvidaría del carril y esa corrida aterrizaría en un trabajador sin las
 * capacidades que necesita, para morir de forma opaca. Todo camino de creación
 * —la API, el planificador, la delegación a sub-agentes, el reintento— pasa por
 * acá.
 */
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { newId } from "../core/ids";
import { createLogger } from "../core/logger";
import { getEngineConfig } from "../core/config";
import { EngineAgent } from "../models/agent.model";
import {
  EngineAgentVersion,
  type EngineAgentVersionDoc,
} from "../models/agentVersion.model";
import {
  EngineExecution,
  EMPTY_PHASE_TIMINGS,
  type EngineExecutionDoc,
} from "../models/execution.model";
import type { ExecutionLane, ExecutionTrigger, GraphType, ResponseMode } from "../models/enums";
import type { SessionOrigin } from "../models/session.model";
import { ensureSession, recordUserMessage } from "./session";

const log = createLogger("engine:enqueue");

/**
 * Tipo de grafo -> carril. Única función que decide el carril; el resto del
 * motor lo lee de la fila.
 */
export function laneForGraphType(graphType: GraphType, hasParent: boolean): ExecutionLane {
  // El carril de codificación gana sobre todo: esas corridas necesitan sandbox
  // y presupuesto propio, y se EXCLUYEN de los otros dos aunque sean hijas.
  if (graphType === "coding_run") return "coding";
  return hasParent ? "sub_agent" : "root";
}

export interface EnqueueInput {
  agentId: string;
  input: Record<string, unknown>;
  inputText?: string | null;
  tenantId: string | null;
  organizationId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  /** Clave del sistema externo; agrupa eventos del mismo hilo en una sesión. */
  externalKey?: string | null;
  sessionOrigin?: SessionOrigin;
  trigger?: ExecutionTrigger;
  responseMode?: ResponseMode;
  callbackUrl?: string | null;
  idempotencyKey?: string | null;
  priority?: number;

  // Linaje
  parentExecutionId?: string | null;
  originalRunId?: string | null;
  attempt?: number;
  depth?: number;
  /** Enlace confiable. NUNCA se acepta desde el cuerpo de una petición. */
  sourceScheduledTaskId?: string | null;

  /** Fija la versión a correr. Si se omite, se usa la activa del agente. */
  versionId?: string | null;
}

export interface EnqueueResult {
  execution: EngineExecutionDoc;
  version: EngineAgentVersionDoc;
  /** La corrida ya existía por clave de idempotencia; no se creó nada. */
  deduplicated: boolean;
}

export async function enqueueExecution(input: EnqueueInput): Promise<EnqueueResult> {
  const cfg = getEngineConfig();

  // --- Idempotencia ------------------------------------------------------
  // Se resuelve ANTES de tocar nada: un reintento de red no puede producir dos
  // corridas facturables.
  if (input.idempotencyKey) {
    const existing = await EngineExecution.findOne({
      idempotencyKey: input.idempotencyKey,
    }).lean();
    if (existing) {
      const version = await EngineAgentVersion.findOne({ versionId: existing.versionId }).lean();
      if (!version) throw new NotFoundError("La versión de la corrida existente ya no está");
      return {
        execution: existing as EngineExecutionDoc,
        version: version as EngineAgentVersionDoc,
        deduplicated: true,
      };
    }
  }

  // --- Agente y versión --------------------------------------------------
  const agent = await EngineAgent.findOne({ agentId: input.agentId, deletedAt: null }).lean();
  if (!agent) throw new NotFoundError(`Agente no encontrado: ${input.agentId}`);
  if (agent.status === "archived") {
    throw new ConflictError("El agente está archivado y no puede ejecutarse");
  }
  if (agent.status !== "active" && !input.versionId) {
    throw new ConflictError(`El agente no está activo (estado: ${agent.status})`);
  }

  const versionId = input.versionId ?? agent.activeVersionId;
  if (!versionId) {
    throw new ConflictError(
      "El agente no tiene una versión activa: guardá una configuración antes de ejecutarlo",
    );
  }

  const version = await EngineAgentVersion.findOne({ versionId }).lean();
  if (!version) throw new NotFoundError(`Versión no encontrada: ${versionId}`);
  if (version.agentId !== agent.agentId) {
    throw new ValidationError("La versión indicada no pertenece a este agente");
  }

  // --- Profundidad de delegación ----------------------------------------
  const depth = input.depth ?? 0;
  if (depth > cfg.execution.maxSubAgentDepth) {
    throw new ValidationError(
      `Profundidad de delegación ${depth} por encima del tope (${cfg.execution.maxSubAgentDepth})`,
    );
  }

  // --- Carril: estampado al crear ---------------------------------------
  const lane = laneForGraphType(version.graphType, Boolean(input.parentExecutionId));

  const executionId = newId("exec");
  const now = new Date();
  const timeoutSeconds = version.timeoutSeconds || cfg.execution.defaultTimeoutSeconds;

  const doc: Partial<EngineExecutionDoc> = {
    executionId,
    agentId: agent.agentId,
    versionId: version.versionId,
    tenantId: input.tenantId,
    organizationId: input.organizationId ?? agent.organizationId ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,

    parentExecutionId: input.parentExecutionId ?? null,
    originalRunId: input.originalRunId ?? null,
    attempt: input.attempt ?? 0,
    sourceScheduledTaskId: input.sourceScheduledTaskId ?? null,
    trigger: input.trigger ?? "api",
    depth,

    status: "queued",
    lane,
    priority: input.priority ?? 0,
    idempotencyKey: input.idempotencyKey ?? null,

    input: input.input ?? {},
    inputText: input.inputText ?? null,

    timeoutAt: new Date(now.getTime() + timeoutSeconds * 1000),
    activeMs: 0,
    phaseTimings: { ...EMPTY_PHASE_TIMINGS },

    responseMode: input.responseMode ?? "async",
    callbackUrl: input.callbackUrl ?? null,
    pauseRequested: false,
    cancelRequested: false,
    stepCount: 0,
  };

  try {
    const created = await EngineExecution.create(doc);

    // La sesión se acuña acá, implícitamente (§2): no hay endpoint de creación,
    // así que no existe la carrera entre "creá la sesión" y "mandá el mensaje".
    // El turno del usuario se persiste ANTES de correr para que aparezca en la
    // conversación aunque la corrida después falle.
    if (input.sessionId || input.externalKey) {
      const sessionId = await ensureSession({
        sessionId: input.sessionId,
        agentId: agent.agentId,
        tenantId: input.tenantId,
        userId: input.userId,
        externalKey: input.externalKey,
        origin: input.sessionOrigin,
        firstMessage: input.inputText,
      });
      if (sessionId) {
        await EngineExecution.updateOne({ executionId }, { $set: { sessionId } });
        created.sessionId = sessionId;
        if (input.inputText) {
          await recordUserMessage(
            sessionId,
            agent.agentId,
            input.tenantId,
            input.inputText,
            executionId,
          );
        }
      }
    }

    log.info("ejecución encolada", { executionId, agentId: agent.agentId, lane, depth });
    return {
      execution: created.toObject() as EngineExecutionDoc,
      version: version as EngineAgentVersionDoc,
      deduplicated: false,
    };
  } catch (err) {
    // Carrera de idempotencia: dos peticiones con la misma clave llegaron a la
    // vez y el índice único cortó a la segunda. Se devuelve la ganadora.
    if (isDuplicateKey(err) && input.idempotencyKey) {
      const existing = await EngineExecution.findOne({
        idempotencyKey: input.idempotencyKey,
      }).lean();
      if (existing) {
        return {
          execution: existing as EngineExecutionDoc,
          version: version as EngineAgentVersionDoc,
          deduplicated: true,
        };
      }
    }
    throw err;
  }
}

function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: number }).code === 11000);
}
