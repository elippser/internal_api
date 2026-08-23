/**
 * Nodo de herramientas PARTICIONADO (§11.2).
 *
 * El modelo puede pedir varias herramientas en un mismo turno. Ejecutarlas
 * siempre en serie es correcto pero lento: cinco lecturas independientes al PMS
 * tardan cinco veces lo que la más lenta. Ejecutarlas siempre en paralelo es
 * rápido pero incorrecto: dos escrituras concurrentes sobre la misma reserva
 * producen una carrera que aparece una vez cada mil turnos.
 *
 * La partición es el punto medio: se clasifica cada llamada y se agrupa en
 * lotes que respetan la exclusividad.
 *
 *   - `read`      -> se agrupan las CONSECUTIVAS y corren en paralelo.
 *   - `write`     -> lote propio. Se serializan entre sí y respecto de las lecturas.
 *   - `exclusive` -> lote propio, sola.
 *
 * Las escrituras no se mezclan con lecturas del mismo turno a propósito: una
 * lectura que corre en paralelo con la escritura que la afecta devuelve un
 * estado que ya no es cierto cuando el modelo lo lee, y el modelo afirma cosas
 * falsas sin que nada falle.
 *
 * El ORDEN ORIGINAL de los resultados se conserva siempre: el proveedor exige
 * que los `tool_result` vuelvan emparejados con sus `tool_use`, y romper ese
 * orden rompe el turno.
 */
import type { ConcurrencyMode } from "../models/enums";

export interface PartitionableCall<T> {
  item: T;
  concurrency: ConcurrencyMode;
}

export interface PartitionBatch<T> {
  mode: ConcurrencyMode;
  /** Índices en el arreglo ORIGINAL, para reensamblar en orden. */
  indices: number[];
  items: T[];
}

/**
 * Agrupa llamadas en lotes ejecutables. Preserva el orden relativo: un lote
 * nunca adelanta una llamada por encima de una escritura anterior.
 */
export function partitionCalls<T>(calls: PartitionableCall<T>[]): PartitionBatch<T>[] {
  const batches: PartitionBatch<T>[] = [];
  let current: PartitionBatch<T> | null = null;

  calls.forEach((call, index) => {
    if (call.concurrency === "read") {
      if (current && current.mode === "read") {
        current.indices.push(index);
        current.items.push(call.item);
        return;
      }
      current = { mode: "read", indices: [index], items: [call.item] };
      batches.push(current);
      return;
    }

    // Escritura o exclusiva: siempre lote propio, y corta la racha de lecturas.
    batches.push({ mode: call.concurrency, indices: [index], items: [call.item] });
    current = null;
  });

  return batches;
}

/**
 * Ejecuta los lotes en orden y devuelve los resultados en el ORDEN ORIGINAL.
 *
 * `runner` nunca debe rechazar: los errores de herramienta vuelven al modelo
 * como datos. Aun así se envuelve cada llamada, porque una promesa rechazada
 * dentro de un `Promise.all` tumbaría el lote entero y perdería los resultados
 * de las herramientas que sí funcionaron.
 */
export async function executePartitioned<T, R>(
  calls: PartitionableCall<T>[],
  runner: (item: T, index: number) => Promise<R>,
  onError: (item: T, index: number, err: unknown) => R,
): Promise<R[]> {
  const results = new Array<R>(calls.length);

  for (const batch of partitionCalls(calls)) {
    await Promise.all(
      batch.items.map(async (item, i) => {
        const originalIndex = batch.indices[i];
        try {
          results[originalIndex] = await runner(item, originalIndex);
        } catch (err) {
          results[originalIndex] = onError(item, originalIndex, err);
        }
      }),
    );
  }

  return results;
}

/** Resumen del plan de partición, para dejarlo en el paso del grafo. */
export function describePartition<T>(batches: PartitionBatch<T>[]): {
  batches: number;
  parallelism: number;
  modes: ConcurrencyMode[];
} {
  return {
    batches: batches.length,
    parallelism: batches.reduce((max, b) => Math.max(max, b.items.length), 0),
    modes: batches.map((b) => b.mode),
  };
}
