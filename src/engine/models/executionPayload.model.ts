/**
 * Tablas FRÍAS con TTL: cargas crudas del proveedor y diario de eventos (§6.3).
 *
 * Están separadas del paso "caliente" por una razón de costo, no de prolijidad.
 * La petición y respuesta exactas del proveedor son lo único que permite
 * depurar de verdad ("¿qué le mandamos realmente?"), y a la vez son enormes y
 * dejan de importar a los pocos días. Si vivieran en `engine_execution_steps`,
 * cada listado de pasos arrastraría megabytes y el índice de la colección
 * caliente no entraría en memoria.
 *
 * El TTL lo aplica Mongo con un índice `expireAfterSeconds: 0` sobre
 * `expiresAt`: la fila se borra sola, sin barrendero propio.
 */
import { Schema, model, type Model } from "mongoose";
import { getEngineConfig } from "../core/config";

// ---------------------------------------------------------------------------
// Cargas crudas de proveedor
// ---------------------------------------------------------------------------

export interface EngineStepPayloadDoc {
  stepId: string;
  executionId: string;
  tenantId: string | null;
  /** Cuerpo exacto enviado al proveedor, ya redactado de secretos. */
  request: unknown;
  /** Cuerpo exacto recibido. */
  response: unknown;
  expiresAt: Date;
  createdAt: Date;
}

const payloadSchema = new Schema<EngineStepPayloadDoc>(
  {
    stepId: { type: String, required: true, unique: true, index: true },
    executionId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null },
    request: { type: Schema.Types.Mixed, default: null },
    response: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "engine_execution_step_payloads",
  },
);

payloadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EngineStepPayload: Model<EngineStepPayloadDoc> = model<EngineStepPayloadDoc>(
  "EngineStepPayload",
  payloadSchema,
);

export function payloadExpiry(): Date {
  const days = getEngineConfig().observability.payloadTtlDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Diario de eventos
// ---------------------------------------------------------------------------

/**
 * `engine_execution_events` — diario ORDENADO de eventos de streaming.
 *
 * Permite reproducir a posteriori una corrida histórica sin depender del bus:
 * el bus es efímero y sólo sirve a quien estaba conectado en ese momento.
 *
 * EXCLUYE deliberadamente los deltas de alta frecuencia (`token`,
 * `thinking_delta`, `tool_call_delta`). Persistirlos multiplicaría por cien el
 * volumen de la colección para reconstruir un texto que ya está guardado
 * entero en el paso y en la salida de la ejecución.
 */
export interface EngineExecutionEventDoc {
  eventId: string;
  executionId: string;
  tenantId: string | null;
  /** Orden monotónico dentro de la ejecución. Es la clave de la reproducción. */
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: Date;
  expiresAt: Date;
}

const eventSchema = new Schema<EngineExecutionEventDoc>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    executionId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null },
    seq: { type: Number, required: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "engine_execution_events" },
);

eventSchema.index({ executionId: 1, seq: 1 }, { unique: true });
eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EngineExecutionEvent: Model<EngineExecutionEventDoc> =
  model<EngineExecutionEventDoc>("EngineExecutionEvent", eventSchema);

export function eventExpiry(): Date {
  const days = getEngineConfig().observability.eventJournalTtlDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
