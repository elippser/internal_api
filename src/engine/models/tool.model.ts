/**
 * `engine_tools` — catálogo de herramientas creadas por API (§12).
 *
 * Es el nivel 2 y 3 de la resolución (catálogo del inquilino y catálogo global,
 * distinguidos por `tenantId`). El nivel 1 es el registro en memoria y el nivel
 * 4 es el puente al catálogo de herramientas del PMS que ya existe en
 * `modules/tools`.
 *
 * `config` es una bolsa JSON discriminada por `type`. Deliberado: cada tipo de
 * herramienta necesita campos distintos (una `http` necesita URL y plantilla de
 * cuerpo, una `search` necesita proveedor y cuota) y modelarlos como columnas
 * obligaría a migrar la colección cada vez que se agrega un tipo. La validación
 * vive en la capa de aplicación, donde puede dar un mensaje útil.
 */
import { Schema, model, type Model } from "mongoose";
import {
  CONCURRENCY_MODES,
  TOOL_SCOPES,
  TOOL_TYPES,
  type ConcurrencyMode,
  type ToolScope,
  type ToolType,
} from "./enums";

export interface EngineToolDoc {
  toolId: string;
  /** Nombre con el que lo ve el modelo. Único por ámbito. */
  name: string;
  displayName: string;
  description: string;

  type: ToolType;
  scope: ToolScope;
  /** NULO = catálogo global de plataforma. */
  tenantId: string | null;
  /** Sólo para el ámbito `user`: corre con las credenciales del dueño. */
  ownerUserId?: string | null;

  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };

  /** Configuración específica del tipo. Validada por esquema en el servicio. */
  config: Record<string, unknown>;

  permissions: {
    /** Piso de rol. Por debajo, la herramienta se retira con negación explicativa. */
    roleFloor: string | null;
    requiresConfirmation: boolean;
    isDestructive: boolean;
  };

  /**
   * Clase de concurrencia. Si es nula, el resolutor la infiere: destructiva ->
   * exclusiva, escritura -> escritura, resto -> lectura.
   */
  concurrency: ConcurrencyMode | null;

  status: "active" | "disabled";
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const toolSchema = new Schema<EngineToolDoc>(
  {
    toolId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    displayName: { type: String, default: "" },
    description: { type: String, default: "" },

    type: { type: String, enum: TOOL_TYPES, required: true },
    scope: { type: String, enum: TOOL_SCOPES, default: "tenant" },
    tenantId: { type: String, default: null, index: true },
    ownerUserId: { type: String, default: null },

    inputSchema: {
      type: new Schema(
        {
          type: { type: String, default: "object" },
          properties: { type: Schema.Types.Mixed, default: {} },
          required: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: () => ({ type: "object", properties: {}, required: [] }),
    },

    config: { type: Schema.Types.Mixed, default: {} },

    permissions: {
      type: new Schema(
        {
          roleFloor: { type: String, default: null },
          requiresConfirmation: { type: Boolean, default: false },
          isDestructive: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: () => ({}),
    },

    concurrency: { type: String, enum: [...CONCURRENCY_MODES, null], default: null },

    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    createdByUserId: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "engine_tools" },
);

/**
 * El nombre es único POR ÁMBITO, no globalmente: un inquilino puede definir su
 * propia `buscar_reservas` sin colisionar con la global. La resolución decide
 * cuál gana (el catálogo del inquilino sombrea al global).
 */
toolSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const EngineTool: Model<EngineToolDoc> = model<EngineToolDoc>("EngineTool", toolSchema);

export function sanitizeTool(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
