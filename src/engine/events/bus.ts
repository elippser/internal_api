/**
 * Bus de eventos + diario persistido (§22).
 *
 * Topología elegida: worker in-process, así que el bus es un EventEmitter por
 * proceso. El documento describe Redis como transporte entre procesos, y la
 * frontera está preparada para eso: `publish` y `subscribe` son las dos únicas
 * funciones que un adaptador Redis tendría que reimplementar. El resto del
 * motor no sabe qué transporte hay debajo.
 *
 * Propiedad heredada del diseño con Redis y que conviene conservar: el bus
 * FALLA ABIERTO. Un suscriptor que revienta, un diario que no puede escribir o
 * un canal saturado no pueden tumbar la ejecución. Publicar es "mejor esfuerzo";
 * la verdad durable es la fila de la ejecución y sus pasos, no el stream.
 *
 * La reconexión es reenganche de mejor esfuerzo, sin reproducción: quien se
 * reconecta pide el diario por HTTP y después se suscribe. El evento terminal
 * es siempre `done`.
 */
import { EventEmitter } from "events";
import { createLogger, errField } from "../core/logger";
import { getEngineConfig } from "../core/config";
import { newId } from "../core/ids";
import {
  EngineExecutionEvent,
  eventExpiry,
} from "../models/executionPayload.model";
import {
  isPersistable,
  makeEvent,
  type EngineEvent,
  type EventType,
} from "./protocol";

const log = createLogger("engine:bus");

/**
 * Sin tope de escuchas: hay un canal por ejecución y varios clientes pueden
 * mirar la misma corrida (la consola, el chat embebido, un SDK). El aviso de
 * fuga de Node dispararía con 11 espectadores, que es un caso normal.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Secuencia monotónica POR ejecución. Es lo que ordena el diario. */
const sequences = new Map<string, number>();

function nextSeq(executionId: string): number {
  const next = (sequences.get(executionId) ?? 0) + 1;
  sequences.set(executionId, next);
  return next;
}

function channel(executionId: string): string {
  return `exec:${executionId}`;
}

export type EventListener = (event: EngineEvent) => void;

/**
 * Publica un evento. Nunca lanza ni espera: el corredor llama a esto en el
 * camino caliente y no puede quedar bloqueado por un espectador lento ni por
 * la base.
 */
export function publish(
  executionId: string,
  type: EventType,
  payload: { text?: string; data?: Record<string, unknown> } = {},
  tenantId: string | null = null,
): EngineEvent | null {
  let event: EngineEvent;
  try {
    event = makeEvent(type, executionId, nextSeq(executionId), payload);
  } catch (err) {
    log.error("evento malformado descartado", { type, ...errField(err) });
    return null;
  }

  try {
    emitter.emit(channel(executionId), event);
  } catch (err) {
    // Un suscriptor que revienta no puede llevarse la ejecución puesta.
    log.warn("un suscriptor falló al recibir", { type, ...errField(err) });
  }

  // El diario se escribe en segundo plano y sólo para lo que vale la pena
  // reproducir. Los deltas quedan fuera por volumen (ver protocol.ts).
  if (getEngineConfig().eventJournalEnabled && isPersistable(type)) {
    void persistEvent(event, tenantId);
  }

  return event;
}

async function persistEvent(event: EngineEvent, tenantId: string | null): Promise<void> {
  try {
    await EngineExecutionEvent.create({
      eventId: newId("evt"),
      executionId: event.executionId,
      tenantId,
      seq: event.seq,
      type: event.type,
      payload: { text: event.text, ...(event.data ?? {}) },
      at: new Date(event.ts),
      expiresAt: eventExpiry(),
    });
  } catch (err) {
    // Falla abierta: sin diario se pierde la reproducción histórica, no la corrida.
    log.warn("no se pudo persistir el evento en el diario", {
      executionId: event.executionId,
      type: event.type,
      ...errField(err),
    });
  }
}

/** Se suscribe a una ejecución. Devuelve la función para darse de baja. */
export function subscribe(executionId: string, listener: EventListener): () => void {
  const ch = channel(executionId);
  emitter.on(ch, listener);
  return () => {
    emitter.off(ch, listener);
  };
}

/** Cantidad de espectadores de una ejecución. Lo usa el endpoint de salud. */
export function subscriberCount(executionId: string): number {
  return emitter.listenerCount(channel(executionId));
}

/**
 * Libera la secuencia de una ejecución terminada. Sin esto el mapa crece
 * monotónicamente durante toda la vida del proceso: una fuga lenta que sólo se
 * nota a los meses, cuando el worker lleva cientos de miles de corridas.
 *
 * Se llama DESPUÉS de publicar el evento terminal, con un retraso corto para
 * que un suscriptor que llega tarde todavía vea el `done`.
 */
export function releaseExecution(executionId: string): void {
  setTimeout(() => {
    sequences.delete(executionId);
    emitter.removeAllListeners(channel(executionId));
  }, 5_000).unref();
}

/** Lee el diario persistido de una corrida histórica, en orden. */
export async function replay(executionId: string, limit = 2_000): Promise<EngineEvent[]> {
  const docs = await EngineExecutionEvent.find({ executionId })
    .sort({ seq: 1 })
    .limit(limit)
    .lean();

  return docs.map((d) => {
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const { text, ...data } = payload;
    return {
      v: 1,
      type: d.type as EventType,
      executionId: d.executionId,
      seq: d.seq,
      ts: new Date(d.at).toISOString(),
      ...(typeof text === "string" ? { text } : {}),
      ...(Object.keys(data).length ? { data } : {}),
    };
  });
}

/** Sólo para pruebas: limpia estado del proceso. */
export function resetBus(): void {
  sequences.clear();
  emitter.removeAllListeners();
}
