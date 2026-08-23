/**
 * Repositorio de ejecuciones: reclamo, latido, zombies y despertador (§10.2, §10.5).
 *
 * Este archivo es donde vive la decisión de infraestructura más importante del
 * motor. El documento describe el reclamo como `SELECT ... FOR UPDATE SKIP
 * LOCKED` de PostgreSQL. Sobre MongoDB el equivalente exacto es
 * `findOneAndUpdate` con `sort`:
 *
 *   - Es ATÓMICO a nivel documento. Mongo toma un bloqueo de escritura sobre el
 *     documento que matchea, aplica la actualización y lo devuelve. No hay
 *     ventana entre "lo vi disponible" y "lo marqué mío".
 *   - SALTEA los bloqueados de forma natural. Dos workers que reclaman a la vez
 *     no compiten por la misma fila: el predicado incluye `status: "queued"`, y
 *     el que llega segundo ya no matchea esa fila y sigue con la siguiente.
 *   - El reclamo es EXACTAMENTE UNA VEZ y sin contención.
 *
 * Lo que NO se traslada es el bloqueo transaccional multi-documento; por eso
 * `persistence.ts` maneja aparte la escritura conjunta de ejecución + pasos +
 * asientos (§35.6).
 */
import { getEngineConfig } from "../core/config";
import { createLogger, errField } from "../core/logger";
import {
  EngineExecution,
  type EngineExecutionDoc,
} from "../models/execution.model";
import {
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  type ExecutionLane,
  type ExecutionStatus,
} from "../models/enums";

const log = createLogger("engine:repo:execution");

/**
 * Reclama UNA ejecución del carril indicado.
 *
 * El predicado y el orden son deliberados:
 *   - `status: "queued"` es lo que hace el reclamo exclusivo.
 *   - `scheduledFor` permite que el despertador re-encole una corrida con una
 *     demora (por ejemplo, esperar a que el hijo termine de persistir).
 *   - El orden por prioridad descendente y creación ascendente hace la cola
 *     FIFO dentro de cada nivel de prioridad, sin inanición del trabajo viejo.
 *
 * Marca la fila como en ejecución ANTES de devolverla: cuando el corredor la
 * recibe, ya es suya.
 */
export async function claimNext(
  lane: ExecutionLane,
  workerId: string,
): Promise<EngineExecutionDoc | null> {
  const now = new Date();

  const claimed = await EngineExecution.findOneAndUpdate(
    {
      status: "queued",
      lane,
      $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }],
    },
    {
      $set: {
        status: "running" as ExecutionStatus,
        workerId,
        heartbeatAt: now,
        legStartedAt: now,
        // `startedAt` es ESTABLE: se fija en el primer reclamo y una
        // reanudación no lo pisa. Si se reescribiera, la latencia total de una
        // corrida que esperó una aprobación humana mediría sólo el último tramo
        // y el tablero de latencia mentiría hacia abajo.
      },
    },
    { sort: { priority: -1, createdAt: 1 }, new: true },
  ).lean();

  if (!claimed) return null;

  // Primer reclamo: se estampa `startedAt` y se cotiza el tiempo en cola.
  if (!claimed.startedAt) {
    const queueMs = now.getTime() - new Date(claimed.createdAt).getTime();
    await EngineExecution.updateOne(
      { executionId: claimed.executionId },
      { $set: { startedAt: now, "phaseTimings.queueMs": queueMs } },
    );
    claimed.startedAt = now;
    claimed.phaseTimings = { ...claimed.phaseTimings, queueMs };
  }

  return claimed as EngineExecutionDoc;
}

/** Refresca el latido de las corridas en vuelo de ESTE worker. */
export async function beat(workerId: string, executionIds: string[]): Promise<void> {
  if (executionIds.length === 0) return;
  try {
    await EngineExecution.updateMany(
      { executionId: { $in: executionIds }, workerId },
      { $set: { heartbeatAt: new Date() } },
    );
  } catch (err) {
    // El latido falla abierto: perderlo un ciclo no justifica matar la corrida.
    // Si falla de forma sostenida, el detector de zombies hace su trabajo.
    log.warn("no se pudo refrescar el latido", { count: executionIds.length, ...errField(err) });
  }
}

export interface ZombieSweepResult {
  swept: number;
  executionIds: string[];
}

/**
 * Barre las corridas en curso cuyo latido superó el umbral y las marca como
 * expiradas, dejando EVIDENCIA ESTRUCTURADA de la falla.
 *
 * La evidencia importa más de lo que parece. Una corrida que aparece
 * "timed_out" sin más no dice si murió el proceso, si el pod fue desalojado o
 * si el modelo se colgó. Guardar el worker, el último latido y el umbral
 * convierte una investigación de horas en una consulta.
 */
export async function sweepZombies(): Promise<ZombieSweepResult> {
  const cfg = getEngineConfig();
  const cutoff = new Date(Date.now() - cfg.worker.zombieThresholdMs);

  const candidates = await EngineExecution.find(
    { status: "running", heartbeatAt: { $lt: cutoff } },
    { executionId: 1, workerId: 1, heartbeatAt: 1 },
  )
    .limit(100)
    .lean();

  if (candidates.length === 0) return { swept: 0, executionIds: [] };

  const ids: string[] = [];
  for (const doc of candidates) {
    // Se re-verifica el predicado en la propia actualización: entre el `find` y
    // el `update` el worker pudo revivir y latir. Sin esta condición se mataría
    // una corrida sana.
    const res = await EngineExecution.updateOne(
      { executionId: doc.executionId, status: "running", heartbeatAt: { $lt: cutoff } },
      {
        $set: {
          status: "timed_out" as ExecutionStatus,
          completedAt: new Date(),
          errorMessage: "El trabajador dejó de latir; la corrida se declaró perdida",
          failureReason: "worker_lost",
          failureDetails: {
            workerId: doc.workerId ?? null,
            lastHeartbeatAt: doc.heartbeatAt ?? null,
            thresholdMs: cfg.worker.zombieThresholdMs,
            detectedBy: cfg.worker.id,
            detectedAt: new Date(),
          },
        },
      },
    );
    if (res.modifiedCount > 0) ids.push(doc.executionId);
  }

  if (ids.length > 0) {
    log.warn("corridas declaradas perdidas por latido vencido", { count: ids.length });
  }
  return { swept: ids.length, executionIds: ids };
}

/**
 * DESPERTADOR (§10.6). Re-encola los padres suspendidos cuyos hijos ya
 * terminaron todos.
 *
 * Es lo que hace del modo asíncrono de sub-agente algo distinto del modo
 * remoto: el padre LIBERA su ranura de carril al suspenderse, y vuelve a la
 * cola solo. Sin este bucle, una corrida en `waiting_for_subtask` se queda ahí
 * para siempre y no hay ninguna acción humana que la rescate — porque la pausa
 * humana explícitamente no aplica a ese estado.
 */
export async function wakeParentsWithFinishedChildren(limit = 50): Promise<string[]> {
  const waiting = await EngineExecution.find(
    { status: "waiting_for_subtask" },
    { executionId: 1 },
  )
    .limit(limit)
    .lean();

  if (waiting.length === 0) return [];

  const woken: string[] = [];
  for (const parent of waiting) {
    const pendingChildren = await EngineExecution.countDocuments({
      parentExecutionId: parent.executionId,
      status: { $nin: TERMINAL_STATUSES },
    });
    if (pendingChildren > 0) continue;

    const res = await EngineExecution.updateOne(
      { executionId: parent.executionId, status: "waiting_for_subtask" },
      {
        $set: {
          status: "queued" as ExecutionStatus,
          workerId: null,
          heartbeatAt: null,
          scheduledFor: null,
        },
      },
    );
    if (res.modifiedCount > 0) woken.push(parent.executionId);
  }

  if (woken.length > 0) {
    log.info("padres re-encolados tras terminar sus subtareas", { count: woken.length });
  }
  return woken;
}

/**
 * Suelta una corrida de vuelta a la cola sin marcarla fallida. Lo usa el
 * apagado ordenado: es preferible que otro worker la retome a declararla
 * perdida por un despliegue.
 */
export async function release(executionId: string, workerId: string): Promise<void> {
  await EngineExecution.updateOne(
    { executionId, workerId, status: "running" },
    { $set: { status: "queued" as ExecutionStatus, workerId: null, heartbeatAt: null } },
  );
}

/** Profundidad de cola por carril, para el endpoint de capacidad. */
export async function queueDepth(): Promise<Record<string, number>> {
  const rows = await EngineExecution.aggregate<{ _id: { lane: string; status: string }; n: number }>([
    { $match: { status: { $in: [...IN_FLIGHT_STATUSES] } } },
    { $group: { _id: { lane: "$lane", status: "$status" }, n: { $sum: 1 } } },
  ]);

  const out: Record<string, number> = {};
  for (const row of rows) {
    out[`${row._id.lane}.${row._id.status}`] = row.n;
  }
  return out;
}

/** Inventario de trabajadores vistos recientemente. */
export async function activeWorkers(withinMs = 120_000): Promise<
  Array<{ workerId: string; running: number; lastHeartbeatAt: Date }>
> {
  const since = new Date(Date.now() - withinMs);
  const rows = await EngineExecution.aggregate<{
    _id: string;
    running: number;
    lastHeartbeatAt: Date;
  }>([
    { $match: { status: "running", heartbeatAt: { $gte: since }, workerId: { $ne: null } } },
    { $group: { _id: "$workerId", running: { $sum: 1 }, lastHeartbeatAt: { $max: "$heartbeatAt" } } },
  ]);
  return rows.map((r) => ({
    workerId: r._id,
    running: r.running,
    lastHeartbeatAt: r.lastHeartbeatAt,
  }));
}
