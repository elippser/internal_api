/**
 * Protocolo de eventos de streaming, VERSIONADO (§22).
 *
 * Este archivo es un contrato, no una utilidad. Lo consumen el worker (que
 * publica), la API (que reenvía por SSE/WebSocket), la consola (que renderiza)
 * y el diario persistido (que reproduce corridas históricas). Cambiar la forma
 * de un evento sin subir `PROTOCOL_VERSION` rompe clientes desplegados de forma
 * silenciosa: el cliente viejo lee un campo que ya no está y muestra vacío.
 *
 * La distinción operativa más importante del archivo es `HIGH_FREQUENCY_EVENTS`.
 * Los deltas (`token`, `thinking_delta`, `tool_call_delta`) llegan por el bus
 * pero NO se persisten: son cientos por turno y su contenido ya está guardado
 * completo en el paso y en la salida de la ejecución. Persistirlos multiplicaría
 * el volumen del diario por dos órdenes de magnitud para reconstruir un texto
 * que ya tenemos.
 */

export const PROTOCOL_VERSION = 1;

export const EVENT_TYPES = [
  // Ciclo de vida
  "status",
  "done",
  "error",
  // Texto y razonamiento
  "token",
  "thinking_delta",
  /**
   * El texto emitido hasta ahora se DESCARTA: la iteración terminó pidiendo
   * herramientas, así que ese preámbulo no forma parte de la respuesta final
   * (el cierre sólo toma el texto de la última iteración).
   *
   * Sin este evento, un cliente que acumula deltas muestra el preámbulo pegado
   * a la respuesta y termina enseñando algo que NO es lo que se persistió —
   * dos textos distintos para el mismo turno, y el que el usuario leyó no queda
   * en ningún lado.
   */
  "text_reset",
  "llm_response",
  // Herramientas
  "tool_call",
  "tool_call_delta",
  "tool_result",
  // Delegación
  "sub_agent_started",
  "sub_agent_completed",
  // Interrupción humana
  "interrupt",
  // Memoria (reservados para §17; el bus ya los transporta)
  "memory_recall",
  "memory_write",
  "memory_gap",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Eventos de alta frecuencia: se publican, NO se persisten. Un evento nuevo
 * que sea un delta se agrega SÓLO acá y el diario lo excluye automáticamente.
 */
export const HIGH_FREQUENCY_EVENTS: readonly EventType[] = [
  "token",
  "thinking_delta",
  "tool_call_delta",
  // `text_reset` sólo tiene sentido para quien está mirando en vivo: en una
  // reproducción histórica el texto final ya está resuelto y persistirlo sería
  // guardar una instrucción sobre un buffer que no existe.
  "text_reset",
];

const HIGH_FREQ_SET: ReadonlySet<string> = new Set(HIGH_FREQUENCY_EVENTS);

export function isPersistable(type: string): boolean {
  return !HIGH_FREQ_SET.has(type);
}

/** El evento terminal. Cerrar el socket con cualquier otro es un defecto. */
export const TERMINAL_EVENT: EventType = "done";

export interface EngineEvent {
  /** Versión del protocolo. El cliente la valida antes de interpretar. */
  v: number;
  type: EventType;
  executionId: string;
  /** Orden monotónico por ejecución. Permite deduplicar en la reconexión. */
  seq: number;
  ts: string;
  /** Texto asociado (delta, mensaje de estado, error legible). */
  text?: string;
  data?: Record<string, unknown>;
}

/** Códigos de cierre del WebSocket. Definidos para que el cliente los distinga. */
export const CLOSE_CODES = {
  /** Cierre normal tras el evento terminal. */
  NORMAL: 1000,
  /** Trama de autenticación inválida o ausente. */
  AUTH_FAILED: 4401,
  /** La ejecución no existe o no pertenece al ámbito del llamador. */
  NOT_FOUND: 4404,
  /** El servidor se está apagando; el cliente puede reintentar. */
  SHUTTING_DOWN: 4503,
} as const;

let counter = 0;

/**
 * Construye un evento validado. Se valida ANTES de serializar (y no en el
 * cliente) para que un evento malformado falle donde se produjo, con el stack
 * del productor, en vez de aparecer como un render roto sin causa aparente.
 */
export function makeEvent(
  type: EventType,
  executionId: string,
  seq: number,
  payload: { text?: string; data?: Record<string, unknown> } = {},
): EngineEvent {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`[engine:protocol] tipo de evento desconocido: "${type}"`);
  }
  if (!executionId) {
    throw new Error(`[engine:protocol] evento "${type}" sin executionId`);
  }
  counter += 1;
  return {
    v: PROTOCOL_VERSION,
    type,
    executionId,
    seq,
    ts: new Date().toISOString(),
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.data !== undefined ? { data: payload.data } : {}),
  };
}

/**
 * Contrato serializable, para generación de SDK y verificación de deriva. La
 * consola y cualquier SDK lo piden a `/engine/system/event-protocol` y comparan
 * contra lo que tienen compilado.
 */
export function protocolContract(): Record<string, unknown> {
  return {
    version: PROTOCOL_VERSION,
    eventTypes: EVENT_TYPES,
    highFrequencyEvents: HIGH_FREQUENCY_EVENTS,
    terminalEvent: TERMINAL_EVENT,
    closeCodes: CLOSE_CODES,
    messageShape: {
      v: "number",
      type: "EventType",
      executionId: "string",
      seq: "number",
      ts: "ISO-8601 string",
      text: "string?",
      data: "object?",
    },
  };
}

/** Sólo para diagnóstico: cuántos eventos construyó este proceso. */
export function eventsProduced(): number {
  return counter;
}
