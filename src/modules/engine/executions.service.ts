/**
 * Servicio de ejecuciones (§10).
 *
 * La API SÓLO ENCOLA (§35.2). Ninguna función de este archivo corre un grafo:
 * crean filas, levantan banderas o leen evidencia. El trabajo ocurre en un
 * proceso que reclama.
 *
 * Las operaciones de control merecen atención porque las tres se parecen y
 * hacen cosas distintas:
 *   - CANCELAR levanta una bandera y, si la corrida todavía no arrancó, la
 *     cierra de una.
 *   - PAUSAR levanta una bandera y NADA MÁS. El estado `paused` lo escribe el
 *     trabajador cuando ya soltó la fila (§35.5).
 *   - REANUDAR sólo aplica a los estados humanamente reanudables, que NO
 *     incluyen `waiting_for_subtask`: a ésa la despierta el bucle de reclamo.
 */
import { ConflictError, NotFoundError } from "../../engine/core/errors";
import { currentScope } from "../../engine/core/scope";
import { replay as replayJournal } from "../../engine/events/bus";
import {
  HUMAN_RESUMABLE_STATUSES,
  TERMINAL_STATUSES,
  isTerminal,
  shouldStopWaiting,
  type ExecutionStatus,
} from "../../engine/models/enums";
import {
  EngineExecution,
  sanitizeExecution,
  type EngineExecutionDoc,
} from "../../engine/models/execution.model";
import {
  EngineExecutionStep,
  sanitizeStep,
} from "../../engine/models/executionStep.model";
import { EngineStepPayload } from "../../engine/models/executionPayload.model";
import { EngineUsageRecord, sanitizeUsage } from "../../engine/models/usageRecord.model";
import { enqueueExecution } from "../../engine/runtime/enqueue";
import { scopedFilter } from "../../engine/repositories/base.repository";

export interface ListInput {
  agentId?: string;
  status?: string;
  sessionId?: string;
  userId?: string;
  parentExecutionId?: string;
  trigger?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
  skip: number;
}

export const engineExecutionsService = {
  async create(payload: Record<string, unknown>) {
    const scope = currentScope();
    const { execution, deduplicated } = await enqueueExecution({
      agentId: String(payload.agentId),
      input: (payload.input as Record<string, unknown>) ?? {},
      inputText: (payload.inputText as string) ?? null,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      userId: scope.userId ?? null,
      sessionId: (payload.sessionId as string) ?? null,
      externalKey: (payload.externalKey as string) ?? null,
      sessionOrigin: "console",
      responseMode: payload.responseMode as never,
      callbackUrl: (payload.callbackUrl as string) ?? null,
      idempotencyKey: (payload.idempotencyKey as string) ?? null,
      priority: payload.priority as number | undefined,
      versionId: (payload.versionId as string) ?? null,
      trigger: "api",
    });

    return { ...sanitizeExecution(execution), deduplicated };
  },

  /**
   * Modo SÍNCRONO: retiene la petición hasta que la corrida deja de esperar.
   *
   * Sondea contra "dejá de esperar", NO contra los finales. Con los finales, una
   * corrida que levanta una interrupción de aprobación humana dejaría la
   * petición HTTP colgada hasta el tiempo límite, esperando algo que no va a
   * pasar sin intervención (§35.4).
   */
  async waitFor(executionId: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    let waitMs = 200;

    while (Date.now() < deadline) {
      const doc = await EngineExecution.findOne(scopedFilter({ executionId })).lean();
      if (!doc) throw new NotFoundError(`Ejecución no encontrada: ${executionId}`);
      if (shouldStopWaiting(doc.status)) return sanitizeExecution(doc);

      await new Promise((r) => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.4, 2_000);
    }
    return null;
  },

  async list(input: ListInput) {
    const filter: Record<string, unknown> = {};
    if (input.agentId) filter.agentId = input.agentId;
    if (input.status) filter.status = input.status;
    if (input.sessionId) filter.sessionId = input.sessionId;
    if (input.userId) filter.userId = input.userId;
    if (input.parentExecutionId) filter.parentExecutionId = input.parentExecutionId;
    if (input.trigger) filter.trigger = input.trigger;
    if (input.dateFrom || input.dateTo) {
      const range: Record<string, Date> = {};
      if (input.dateFrom) range.$gte = new Date(input.dateFrom);
      if (input.dateTo) range.$lte = new Date(input.dateTo);
      filter.createdAt = range;
    }

    const scoped = scopedFilter(filter);
    const [docs, total] = await Promise.all([
      EngineExecution.find(scoped)
        .sort({ createdAt: -1 })
        .skip(input.skip)
        .limit(input.limit)
        .select({ checkpoint: 0, input: 0, graphSnapshot: 0, resolvedSystemPrompt: 0 })
        .lean(),
      EngineExecution.countDocuments(scoped),
    ]);

    return { data: docs.map((d) => sanitizeExecution(d)), total, page: input.page, limit: input.limit };
  },

  async getById(executionId: string) {
    const doc = await requireExecution(executionId);
    return sanitizeExecution(doc);
  },

  async steps(executionId: string) {
    await requireExecution(executionId);
    const docs = await EngineExecutionStep.find({ executionId }).sort({ index: 1 }).lean();
    return docs.map((d) => sanitizeStep(d));
  },

  /** Carga cruda de UN paso. Tabla fría con TTL: puede haber expirado. */
  async stepPayload(executionId: string, stepId: string) {
    await requireExecution(executionId);
    const doc = await EngineStepPayload.findOne({ executionId, stepId }).lean();
    if (!doc) {
      throw new NotFoundError(
        "La carga cruda de este paso no está disponible (expiró por TTL o no se persistió)",
      );
    }
    return { stepId, request: doc.request, response: doc.response, expiresAt: doc.expiresAt };
  },

  /** Reproducción histórica desde el diario persistido. */
  async events(executionId: string) {
    await requireExecution(executionId);
    return replayJournal(executionId);
  },

  async usage(executionId: string) {
    await requireExecution(executionId);
    const docs = await EngineUsageRecord.find({ executionId }).sort({ occurredAt: 1 }).lean();
    return docs.map((d) => sanitizeUsage(d));
  },

  /**
   * CANCELAR. Levanta la bandera y, si la corrida todavía está en cola, la
   * cierra directamente: no tiene sentido reclamarla para matarla.
   */
  async cancel(executionId: string) {
    const doc = await requireExecution(executionId);
    if (isTerminal(doc.status)) {
      throw new ConflictError(`La corrida ya terminó (${doc.status})`);
    }

    const closedInQueue = await EngineExecution.updateOne(
      { executionId, status: "queued" },
      {
        $set: {
          status: "cancelled" as ExecutionStatus,
          cancelRequested: true,
          completedAt: new Date(),
          errorMessage: "Cancelada antes de arrancar",
          failureReason: "cancelled_by_user",
        },
      },
    );
    if (closedInQueue.modifiedCount > 0) {
      return { executionId, status: "cancelled", immediate: true };
    }

    await EngineExecution.updateOne({ executionId }, { $set: { cancelRequested: true } });
    return { executionId, status: doc.status, cancelRequested: true, immediate: false };
  },

  /**
   * PAUSAR. La API sólo levanta la BANDERA (§35.5). Escribir acá el estado
   * `paused` produciría una corrida "pausada" que todavía tiene un trabajador
   * adentro; reanudarla arrancaría un segundo corredor sobre la misma fila.
   */
  async pause(executionId: string) {
    const doc = await requireExecution(executionId);

    if (isTerminal(doc.status)) throw new ConflictError(`La corrida ya terminó (${doc.status})`);
    // Una corrida esperando subtarea RECHAZA la pausa: no progresa ni ocupa
    // ranura, así que pausarla no libera nada y sí rompe al despertador.
    if (doc.status === "waiting_for_subtask") {
      throw new ConflictError(
        "No se puede pausar una corrida que espera subtareas: no progresa ni ocupa ranura, " +
          "y el despertador la revive sola cuando los hijos terminen.",
      );
    }

    await EngineExecution.updateOne({ executionId }, { $set: { pauseRequested: true } });
    return { executionId, pauseRequested: true, note: "El estado pausado lo escribe el trabajador al soltar la fila" };
  },

  /**
   * REANUDAR. Sólo desde los estados humanamente reanudables. `waiting_for_
   * subtask` queda deliberadamente afuera: a ésa la despierta el bucle de
   * reclamo, y ofrecer un botón acá crearía una corrida con dos dueños.
   */
  async resume(executionId: string, payload: unknown) {
    const doc = await requireExecution(executionId);

    if (!HUMAN_RESUMABLE_STATUSES.includes(doc.status)) {
      throw new ConflictError(
        `No se puede reanudar desde "${doc.status}". Estados reanudables por un humano: ` +
          HUMAN_RESUMABLE_STATUSES.join(", "),
      );
    }

    await EngineExecution.updateOne(
      { executionId, status: doc.status },
      {
        $set: {
          status: "queued" as ExecutionStatus,
          // La carga del humano entra en el punto de interrupción; el corredor
          // la inyecta como turno de usuario al restaurar el estado.
          resumePayload: payload ?? null,
          pauseRequested: false,
          workerId: null,
          heartbeatAt: null,
          interrupt: null,
        },
      },
    );

    return { executionId, status: "queued", resumed: true };
  },

  /**
   * REINTENTO: nueva ejecución que HEREDA la entrada y enlaza el linaje. No
   * reusa la fila vieja a propósito — la corrida fallida es evidencia y tiene
   * que seguir consultable con su diagnóstico intacto.
   */
  async retry(executionId: string) {
    const doc = await requireExecution(executionId);
    if (!isTerminal(doc.status)) {
      throw new ConflictError(
        `Sólo se reintentan corridas terminadas (${TERMINAL_STATUSES.join(", ")}); ` +
          `esta está en "${doc.status}". Si está suspendida, reanudala o cancelala primero.`,
      );
    }

    // El reintento hereda el ámbito de la corrida ORIGINAL, no el del llamador:
    // un operador de plataforma que reintenta la corrida de un hotel no debe
    // reasignarla a su propio inquilino.
    const { execution } = await enqueueExecution({
      agentId: doc.agentId,
      input: doc.input,
      inputText: doc.inputText,
      tenantId: doc.tenantId,
      organizationId: doc.organizationId,
      userId: doc.userId,
      sessionId: doc.sessionId,
      trigger: "retry",
      originalRunId: doc.originalRunId ?? doc.executionId,
      attempt: (doc.attempt ?? 0) + 1,
      // Se fija la MISMA versión: un reintento reproduce, no compara. Para
      // comparar contra la versión vigente está `replay`.
      versionId: doc.versionId,
      priority: doc.priority,
    });

    return sanitizeExecution(execution);
  },

  /**
   * REPETICIÓN: reejecuta con la versión ORIGINAL o con la VIGENTE. La segunda
   * es la que sirve para comparar: "¿el cambio que hice arregla este caso?".
   */
  async replayRun(executionId: string, useLatestVersion: boolean) {
    const doc = await requireExecution(executionId);

    const { execution } = await enqueueExecution({
      agentId: doc.agentId,
      input: doc.input,
      inputText: doc.inputText,
      tenantId: doc.tenantId,
      organizationId: doc.organizationId,
      userId: doc.userId,
      trigger: "replay",
      originalRunId: doc.originalRunId ?? doc.executionId,
      attempt: (doc.attempt ?? 0) + 1,
      versionId: useLatestVersion ? null : doc.versionId,
    });

    return sanitizeExecution(execution);
  },
};

async function requireExecution(executionId: string): Promise<EngineExecutionDoc> {
  const doc = await EngineExecution.findOne(scopedFilter({ executionId })).lean();
  if (!doc) throw new NotFoundError(`Ejecución no encontrada: ${executionId}`);
  return doc as EngineExecutionDoc;
}
