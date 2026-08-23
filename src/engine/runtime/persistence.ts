/**
 * Persistencia conjunta de ejecución + pasos + asientos de uso (§10.4, §35.6).
 *
 * El invariante: costo, pasos y ejecución NO PUEDEN DIVERGIR. Una corrida que
 * figura exitosa sin su costo registrado es plata que se gastó y no se
 * facturó; una corrida con costo pero sin pasos es un número que nadie puede
 * auditar.
 *
 * Sobre PostgreSQL esto es una transacción y listo. Sobre MongoDB las
 * transacciones multi-documento existen pero EXIGEN un replica set: en un
 * `mongod` suelto (típico en desarrollo, y no infrecuente en despliegues
 * chicos) fallan con `IllegalOperation`. Por eso hay dos caminos:
 *
 *   1. TRANSACCIÓN, cuando el despliegue la soporta. Todo o nada.
 *   2. RESERVA ORDENADA, cuando no. Se escribe en el orden que hace que
 *      cualquier corte deje el sistema en un estado RECUPERABLE, no en uno
 *      corrupto:
 *
 *        pasos y asientos  ->  ejecución
 *
 *      Si el proceso muere en el medio, quedan pasos huérfanos y la ejecución
 *      sigue en `running`: el detector de zombies la marca expirada y se puede
 *      reintentar. El orden inverso produciría el estado que sí es corrupto —
 *      una ejecución "succeeded" con costo cero y sin evidencia — y ése no se
 *      detecta nunca porque no tiene ninguna señal.
 *
 * La capacidad se detecta UNA vez por proceso y se cachea: probar la
 * transacción en cada corrida agrega un viaje a la base y un error registrado
 * por corrida en los despliegues que no la soportan.
 */
import mongoose, { type ClientSession } from "mongoose";
import { createLogger, errField } from "../core/logger";
import { getEngineConfig } from "../core/config";
import {
  EngineExecution,
  type EngineExecutionDoc,
} from "../models/execution.model";
import { EngineExecutionStep } from "../models/executionStep.model";
import { EngineUsageRecord } from "../models/usageRecord.model";
import { EngineStepPayload, payloadExpiry } from "../models/executionPayload.model";
import type { StepRecorder } from "./stepRecorder";

const log = createLogger("engine:persistence");

/** null = todavía no se probó. */
let transactionsSupported: boolean | null = null;

async function withTransaction<T>(fn: (session: ClientSession | null) => Promise<T>): Promise<T> {
  if (transactionsSupported === false) return fn(null);

  let session: ClientSession | null = null;
  try {
    session = await mongoose.startSession();
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    transactionsSupported = true;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unsupported =
      /Transaction numbers are only allowed on a replica set|IllegalOperation|not supported|Transactions are not supported/i.test(
        message,
      );

    if (unsupported && transactionsSupported === null) {
      transactionsSupported = false;
      log.warn(
        "el despliegue de MongoDB no soporta transacciones multi-documento; " +
          "uso la reserva ordenada (pasos y asientos antes que la ejecución)",
      );
      return fn(null);
    }
    throw err;
  } finally {
    if (session) await session.endSession();
  }
}

export interface FinalizeInput {
  executionId: string;
  recorder: StepRecorder;
  /** Campos a estampar en la ejecución (estado, salida, diagnóstico). */
  patch: Partial<EngineExecutionDoc>;
  /** Índice del primer paso nuevo, para reanudaciones. */
  stepIndexOffset?: number;
}

/**
 * Escribe todo lo acumulado y estampa la ejecución. Devuelve el documento
 * final. Los totales de consumo se calculan acá y no los pasa el llamador: son
 * derivados de los pasos y calcularlos en otro lado permitiría que difieran.
 */
export async function finalizeExecution(input: FinalizeInput): Promise<EngineExecutionDoc | null> {
  const { executionId, recorder, patch } = input;
  const cfg = getEngineConfig();

  const steps = recorder.pendingSteps();
  const usage = recorder.pendingUsage();
  const payloads = recorder.pendingPayloads();
  const totals = recorder.totals();

  return withTransaction(async (session) => {
    const opts = session ? { session } : {};

    // 1. Evidencia primero.
    if (steps.length > 0) {
      await EngineExecutionStep.insertMany(steps, { ...opts, ordered: false });
    }
    if (usage.length > 0) {
      await EngineUsageRecord.insertMany(usage, { ...opts, ordered: false });
    }

    // 2. Ejecución después. Los contadores se INCREMENTAN, no se pisan: una
    //    corrida reanudada suma el tramo nuevo al ya gastado (§10.6). Pisarlos
    //    haría que una corrida que esperó una aprobación humana reportara sólo
    //    el costo del último tramo, y el presupuesto quedaría corto.
    const updated = await EngineExecution.findOneAndUpdate(
      { executionId },
      {
        $set: patch,
        $inc: {
          // Las fases se INCREMENTAN igual que el resto de los contadores. Con
          // `$set` una corrida reanudada perdía el desglose del primer tramo:
          // el tablero de latencia mostraría sólo lo que tardó después de que
          // el humano aprobó, y una corrida cara parecería barata.
          // `queueMs` no está acá porque lo estampa el reclamo, una sola vez.
          "phaseTimings.setupMs": recorder.timings.setupMs,
          "phaseTimings.llmMs": recorder.timings.llmMs,
          "phaseTimings.toolMs": recorder.timings.toolMs,
          "phaseTimings.overheadMs": recorder.timings.overheadMs,
          "phaseTimings.finalizeMs": recorder.timings.finalizeMs,
          tokensInput: totals.tokensInput,
          tokensOutput: totals.tokensOutput,
          cachedInputTokens: totals.cachedInputTokens,
          cacheCreationTokens: totals.cacheCreationTokens,
          reasoningTokens: totals.reasoningTokens,
          costUsd: totals.costUsd,
          costUsdNotional: totals.costUsdNotional,
          stepCount: totals.stepCount,
          activeMs: recorder.activeMs(),
        },
      },
      { new: true, ...opts },
    ).lean();

    // 3. Las cargas crudas van FUERA de la transacción conceptual: son
    //    diagnóstico con TTL, no evidencia contable. Que fallen no puede
    //    invalidar una corrida correcta.
    if (cfg.payloadsEnabled && payloads.length > 0) {
      void EngineStepPayload.insertMany(
        payloads.map((p) => ({
          stepId: p.stepId,
          executionId,
          tenantId: patch.tenantId ?? null,
          request: p.request,
          response: p.response,
          expiresAt: payloadExpiry(),
          createdAt: new Date(),
        })),
        { ordered: false },
      ).catch((err: unknown) => {
        log.warn("no se pudieron guardar las cargas crudas", { executionId, ...errField(err) });
      });
    }

    return (updated as EngineExecutionDoc) ?? null;
  });
}

/**
 * Red de seguridad del bucle de reclamo (§10.4). Si el corredor reventó antes
 * de confirmar, el bucle copia igual los campos de resultado para que la
 * corrida no quede colgada en `running` hasta que la barra el detector de
 * zombies (noventa segundos de una corrida que ya sabemos que falló).
 *
 * Es una actualización condicionada a `status: running`: si el corredor SÍ
 * llegó a confirmar, esto no toca nada.
 */
export async function safetyNetFinalize(
  executionId: string,
  patch: Partial<EngineExecutionDoc>,
): Promise<void> {
  try {
    await EngineExecution.updateOne(
      { executionId, status: "running" },
      { $set: { ...patch, completedAt: patch.completedAt ?? new Date() } },
    );
  } catch (err) {
    log.error("la red de seguridad no pudo estampar la ejecución", {
      executionId,
      ...errField(err),
    });
  }
}

/** Sólo para pruebas y diagnóstico. */
export function transactionSupport(): boolean | null {
  return transactionsSupported;
}
