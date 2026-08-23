/**
 * `engine_usage_records` — un asiento INMUTABLE por llamada al modelo (§24).
 *
 * Una fila por llamada, no por turno ni por ejecución. La granularidad importa
 * porque un turno puede hacer cinco llamadas con tres modelos distintos (el
 * padre en Opus, un sub-agente en Haiku, el auto-titulado en Haiku), y agregar
 * antes de guardar pierde para siempre la capacidad de responder "¿qué me está
 * costando caro?".
 *
 * La propiedad clave es la INSTANTÁNEA DE TARIFAS (`pricingSnapshot`). El costo
 * se congela con la tarifa vigente al momento de la llamada. Sin eso, cambiar
 * la tabla de precios reescribiría retroactivamente la historia de costos y las
 * facturas del mes pasado dejarían de cuadrar.
 */
import { Schema, model, type Model } from "mongoose";

export interface PricingSnapshot {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  /** Etiqueta de la tarjeta de tarifas usada, para auditar de dónde salió. */
  source: string;
}

/** De dónde salió la cifra de costo. Cambia cómo se interpreta el número. */
export type CostOrigin = "engine" | "harness" | "computed";
export type BillingMode = "api" | "subscription";

export interface EngineUsageRecordDoc {
  usageId: string;
  executionId: string;
  stepId?: string | null;
  tenantId: string | null;
  organizationId: string | null;
  agentId: string;
  /** Sub-agente que hizo la llamada, si no fue el agente raíz. */
  executedByAgentId?: string | null;

  model: string;
  provider: string;

  // Desglose columnar: permite sumar por tipo de token sin recalcular.
  tokensInput: number;
  tokensOutput: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;

  costInputUsd: number;
  costOutputUsd: number;
  costCacheReadUsd: number;
  costCacheWriteUsd: number;
  costTotalUsd: number;
  /**
   * Equivalente de API cuando el gasto lo cubre una suscripción. NUNCA se suma
   * a `costTotalUsd` ni al presupuesto.
   */
  costNotionalUsd: number;

  costOrigin: CostOrigin;
  billingMode: BillingMode;
  pricingSnapshot: PricingSnapshot;

  latencyMs: number;
  occurredAt: Date;
  createdAt: Date;
}

const pricingSnapshotSchema = new Schema<PricingSnapshot>(
  {
    inputPerMTok: { type: Number, required: true },
    outputPerMTok: { type: Number, required: true },
    cacheWritePerMTok: { type: Number, required: true },
    cacheReadPerMTok: { type: Number, required: true },
    source: { type: String, required: true },
  },
  { _id: false },
);

const usageSchema = new Schema<EngineUsageRecordDoc>(
  {
    usageId: { type: String, required: true, unique: true, index: true },
    executionId: { type: String, required: true, index: true },
    stepId: { type: String, default: null },
    tenantId: { type: String, default: null, index: true },
    organizationId: { type: String, default: null },
    agentId: { type: String, required: true, index: true },
    executedByAgentId: { type: String, default: null },

    model: { type: String, required: true, index: true },
    provider: { type: String, required: true },

    tokensInput: { type: Number, default: 0 },
    tokensOutput: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheCreationTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },

    costInputUsd: { type: Number, default: 0 },
    costOutputUsd: { type: Number, default: 0 },
    costCacheReadUsd: { type: Number, default: 0 },
    costCacheWriteUsd: { type: Number, default: 0 },
    costTotalUsd: { type: Number, default: 0 },
    costNotionalUsd: { type: Number, default: 0 },

    costOrigin: {
      type: String,
      enum: ["engine", "harness", "computed"],
      default: "computed",
    },
    billingMode: { type: String, enum: ["api", "subscription"], default: "api" },
    pricingSnapshot: { type: pricingSnapshotSchema, required: true },

    latencyMs: { type: Number, default: 0 },
    occurredAt: { type: Date, required: true, index: true },
  },
  // Ledger inmutable: sin `updatedAt`, sin TTL. Es dato de plata.
  { timestamps: { createdAt: true, updatedAt: false }, collection: "engine_usage_records" },
);

usageSchema.index({ tenantId: 1, occurredAt: -1 });
usageSchema.index({ agentId: 1, occurredAt: -1 });
usageSchema.index({ tenantId: 1, model: 1, occurredAt: -1 });

export const EngineUsageRecord: Model<EngineUsageRecordDoc> = model<EngineUsageRecordDoc>(
  "EngineUsageRecord",
  usageSchema,
);

export function sanitizeUsage(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
