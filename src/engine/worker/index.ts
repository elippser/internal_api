/**
 * Proceso trabajador (§3, §10.2, §10.5).
 *
 * El trabajador es SIN ESTADO: su única memoria es la base. Escala
 * horizontalmente sumando procesos y la concurrencia interna se controla por
 * carriles. Nada de lo que hay acá asume ser el único worker vivo.
 *
 * Cinco bucles conviven:
 *   - RECLAMO, uno por carril, cada uno con su conteo de ranuras propio.
 *   - LATIDO, que refresca las corridas en vuelo de este worker.
 *   - DETECTOR DE ZOMBIES, que barre corridas de workers muertos.
 *   - DESPERTADOR, que re-encola padres cuyos hijos terminaron.
 *   - ARCHIVO DE SALUD, para la sonda del orquestador de contenedores.
 *
 * El apagado es ORDENADO y esa parte importa más de lo que parece: en un
 * despliegue rodante, un worker que muere de golpe deja sus corridas colgadas
 * en `running` hasta que el detector de zombies las barra noventa segundos
 * después. Drenar el trabajo en vuelo (y soltar a la cola lo que no llegue a
 * terminar) convierte un despliegue en una operación invisible.
 */
import { writeFile } from "fs/promises";
import { getEngineConfig } from "../core/config";
import { createLogger, errField } from "../core/logger";
import { EXECUTION_LANES, type ExecutionLane } from "../models/enums";
import {
  activeWorkers,
  beat,
  claimNext,
  queueDepth,
  release,
  sweepZombies,
  wakeParentsWithFinishedChildren,
} from "../repositories/execution.repository";
import { runExecution } from "../runtime/runner";

const log = createLogger("engine:worker");

interface WorkerState {
  running: boolean;
  draining: boolean;
  /** Corridas que este worker tiene adentro ahora mismo. */
  inFlight: Map<string, Promise<unknown>>;
  /** Ranuras ocupadas POR CARRIL. Carriles disjuntos, conteos disjuntos. */
  slotsUsed: Record<ExecutionLane, number>;
  timers: NodeJS.Timeout[];
}

const state: WorkerState = {
  running: false,
  draining: false,
  inFlight: new Map(),
  slotsUsed: { root: 0, sub_agent: 0, coding: 0 },
  timers: [],
};

export function isWorkerRunning(): boolean {
  return state.running;
}

export function workerSnapshot(): Record<string, unknown> {
  const cfg = getEngineConfig();
  return {
    workerId: cfg.worker.id,
    running: state.running,
    draining: state.draining,
    inFlight: state.inFlight.size,
    slots: { used: { ...state.slotsUsed }, total: cfg.worker.slots },
  };
}

/**
 * Arranca el trabajador. Idempotente: en la topología in-process la API y el
 * worker son el mismo proceso y el arranque puede llegar por dos caminos.
 */
export function startWorker(): void {
  const cfg = getEngineConfig();
  if (!cfg.worker.enabled) {
    log.info("trabajador deshabilitado por configuración (ENGINE_WORKER_ENABLED=false)");
    return;
  }
  if (state.running) return;

  state.running = true;
  log.info("trabajador arrancando", { workerId: cfg.worker.id, slots: cfg.worker.slots });

  // --- Bucles de reclamo, uno por carril --------------------------------
  for (const lane of EXECUTION_LANES) {
    const timer = setInterval(() => {
      void claimLoopTick(lane);
    }, cfg.worker.pollIntervalMs);
    timer.unref();
    state.timers.push(timer);
  }

  // --- Latido ------------------------------------------------------------
  const heartbeat = setInterval(() => {
    void beat(cfg.worker.id, [...state.inFlight.keys()]).catch(() => undefined);
    void writeHealthFile();
  }, cfg.worker.heartbeatIntervalMs);
  heartbeat.unref();
  state.timers.push(heartbeat);

  // --- Detector de zombies -----------------------------------------------
  const zombies = setInterval(() => {
    void sweepZombies().catch((err: unknown) => {
      log.error("el barrido de zombies falló", errField(err));
    });
  }, cfg.worker.zombieSweepIntervalMs);
  zombies.unref();
  state.timers.push(zombies);

  // --- Despertador de subtareas -----------------------------------------
  // Más frecuente que el barrido de zombies: acá hay un padre esperando y cada
  // segundo de retraso es latencia que el usuario percibe.
  const waker = setInterval(() => {
    void wakeParentsWithFinishedChildren().catch((err: unknown) => {
      log.error("el despertador falló", errField(err));
    });
  }, Math.max(2_000, cfg.worker.pollIntervalMs * 3));
  waker.unref();
  state.timers.push(waker);

  installShutdownHandlers();
}

/**
 * Un tick de reclamo. Reclama hasta llenar las ranuras libres del carril y
 * lanza cada corrida sin esperarla: el bucle tiene que volver enseguida para
 * poder reclamar la siguiente.
 */
async function claimLoopTick(lane: ExecutionLane): Promise<void> {
  if (!state.running || state.draining) return;

  const cfg = getEngineConfig();
  const total = cfg.worker.slots[lane] ?? 0;

  while (state.slotsUsed[lane] < total) {
    if (state.draining) return;

    let claimed;
    try {
      claimed = await claimNext(lane, cfg.worker.id);
    } catch (err) {
      log.error("el reclamo falló", { lane, ...errField(err) });
      return;
    }
    if (!claimed) return;

    // La ranura se ocupa ANTES de lanzar. Si se ocupara después del await, dos
    // ticks concurrentes podrían reclamar de más y el carril dejaría de acotar
    // nada.
    state.slotsUsed[lane] += 1;

    const promise = runExecution(claimed)
      .catch((err: unknown) => {
        // `runExecution` no debería lanzar nunca; si lo hace es un defecto del
        // motor y no puede tumbar el bucle de reclamo.
        log.error("el corredor dejó escapar una excepción", {
          executionId: claimed.executionId,
          ...errField(err),
        });
      })
      .finally(() => {
        state.slotsUsed[lane] -= 1;
        state.inFlight.delete(claimed.executionId);
      });

    state.inFlight.set(claimed.executionId, promise);
  }
}

/**
 * Archivo de salud para la sonda del orquestador. Se escribe junto con el
 * latido y no en su propio bucle: si el latido se detuvo, el archivo TIENE que
 * dejar de refrescarse, porque son la misma señal de vida.
 */
async function writeHealthFile(): Promise<void> {
  const path = getEngineConfig().worker.healthFilePath;
  if (!path) return;
  try {
    await writeFile(
      path,
      JSON.stringify({ ...workerSnapshot(), at: new Date().toISOString() }),
      "utf8",
    );
  } catch (err) {
    log.warn("no se pudo escribir el archivo de salud", errField(err));
  }
}

// ---------------------------------------------------------------------------
// Apagado ordenado
// ---------------------------------------------------------------------------

let shutdownInstalled = false;

function installShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void shutdownWorker(sig);
    });
  }
}

/**
 * Deja de reclamar y drena el trabajo en vuelo dentro del límite configurable,
 * que debe quedar POR DEBAJO del tope duro del orquestador (si el orquestador
 * mata a los 30s y el drenado espera 60s, el drenado nunca termina y el apagado
 * ordenado no sirvió de nada).
 *
 * Lo que no alcanza a terminar se SUELTA de vuelta a la cola: que otro worker
 * la retome es mejor que declararla perdida por un despliegue.
 */
export async function shutdownWorker(reason = "manual"): Promise<void> {
  if (!state.running || state.draining) return;

  const cfg = getEngineConfig();
  state.draining = true;
  log.info("apagado ordenado: dejo de reclamar y drenó lo que hay en vuelo", {
    reason,
    inFlight: state.inFlight.size,
    graceMs: cfg.worker.shutdownGraceMs,
  });

  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];

  const pending = [...state.inFlight.entries()];
  if (pending.length > 0) {
    const drained = await Promise.race([
      Promise.allSettled(pending.map(([, p]) => p)).then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), cfg.worker.shutdownGraceMs),
      ),
    ]);

    if (!drained) {
      // Se acabó el margen: soltar a la cola lo que sigue adentro.
      const stragglers = [...state.inFlight.keys()];
      log.warn("se agotó el margen de drenado; suelto las corridas a la cola", {
        count: stragglers.length,
      });
      await Promise.allSettled(stragglers.map((id) => release(id, cfg.worker.id)));
    }
  }

  state.running = false;
  state.draining = false;
  log.info("trabajador detenido");
}

// ---------------------------------------------------------------------------
// Diagnóstico expuesto por la API
// ---------------------------------------------------------------------------

export async function workerHealth(): Promise<Record<string, unknown>> {
  const [depth, workers] = await Promise.all([queueDepth(), activeWorkers()]);
  return {
    self: workerSnapshot(),
    queueDepth: depth,
    workers,
  };
}
