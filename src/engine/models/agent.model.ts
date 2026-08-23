/**
 * `engine_agents` — identidad estable del agente (§6.2).
 *
 * Un agente NO guarda configuración. Guarda un puntero a la versión vigente.
 * Esa separación es el invariante §35.1: editar un agente crea una versión
 * inmutable nueva y mueve el puntero; la fila del agente sólo cambia de
 * puntero. La consecuencia práctica es que una ejecución puede estampar el
 * `versionId` que corrió y ese registro nunca miente, por más que después se
 * edite el agente cien veces.
 */
import { Schema, model, type Model, type Types } from "mongoose";

export interface EngineAgentDoc {
  agentId: string;
  slug: string;
  name: string;
  description: string;
  imageUrl?: string | null;

  /**
   * Puntero a la versión vigente. Nulo sólo entre la creación del agente y la
   * de su primera versión (una ventana de milisegundos dentro del mismo
   * servicio); un agente sin versión activa no es ejecutable y así se reporta.
   */
  activeVersionId: string | null;

  /**
   * NULO = agente global de plataforma. En ese caso el ancla de ámbito pasa a
   * ser `organizationId`. No es "sin inquilino, ve todo": es "pertenece a la
   * plataforma, lo pueden ejecutar todos los inquilinos".
   */
  tenantId: string | null;
  organizationId: string | null;

  status: "draft" | "active" | "paused" | "archived";

  /** Bandera de superficie: aparece o no en los selectores de producto. */
  availableInCopilot: boolean;

  /**
   * `agentId` del módulo viejo, cuando este agente vino de la migración.
   *
   * No es decorativo: las sesiones de chat que ya existían guardan el id VIEJO,
   * y sin este puntero el resolver no las reconoce y cae a la colección
   * congelada. El síntoma sería el peor posible — las conversaciones en curso
   * seguirían corriendo la configuración vieja mientras la consola muestra la
   * nueva, sin ningún error a la vista.
   */
  legacyAgentId?: string | null;

  /** Cursor de cadencia de consolidación de memoria (§18). */
  lastDreamAt?: Date | null;

  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const agentSchema = new Schema<EngineAgentDoc>(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    slug: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: null },

    activeVersionId: { type: String, default: null, index: true },
    legacyAgentId: { type: String, default: null },

    tenantId: { type: String, default: null, index: true },
    organizationId: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ["draft", "active", "paused", "archived"],
      default: "draft",
      index: true,
    },
    availableInCopilot: { type: Boolean, default: false },
    lastDreamAt: { type: Date, default: null },

    createdByUserId: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "engine_agents" },
);

/**
 * El slug es único DENTRO del ámbito, no globalmente: dos inquilinos pueden
 * tener cada uno su agente `recepcion`. El índice parcial excluye los borrados
 * lógicos para que un slug se pueda reutilizar después de archivar.
 */
agentSchema.index(
  { tenantId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
agentSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });

/**
 * Resolución por id viejo. Va indexado y no como escaneo porque está en el
 * camino CALIENTE: cada mensaje de una conversación preexistente lo consulta.
 * Disperso, porque sólo los agentes migrados lo llevan.
 */
agentSchema.index(
  { legacyAgentId: 1 },
  { unique: true, partialFilterExpression: { legacyAgentId: { $type: "string" } } },
);

export const EngineAgent: Model<EngineAgentDoc> = model<EngineAgentDoc>(
  "EngineAgent",
  agentSchema,
);

/**
 * `engine_agent_shares` — concesiones de compartición (§2).
 *
 * Compartir concede LECTURA y EJECUCIÓN, jamás escritura (§35.9). Y el receptor
 * no ve con quién más se compartió: por eso las listas derivadas se calculan
 * desde esta tabla y se redactan cuando el lector no es el dueño, en vez de
 * vivir como un array en la fila del agente (donde cualquier lectura las
 * filtraría).
 */
export interface EngineAgentShareDoc {
  shareId: string;
  agentId: string;
  /** Dueño que otorga. Se guarda para poder revocar en masa si cambia de manos. */
  ownerTenantId: string | null;
  granteeTenantId?: string | null;
  granteeOrganizationId?: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const shareSchema = new Schema<EngineAgentShareDoc>(
  {
    shareId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    ownerTenantId: { type: String, default: null },
    granteeTenantId: { type: String, default: null, index: true },
    granteeOrganizationId: { type: String, default: null, index: true },
    createdByUserId: { type: String, required: true },
  },
  { timestamps: true, collection: "engine_agent_shares" },
);

shareSchema.index({ agentId: 1, granteeTenantId: 1 }, { unique: true, sparse: true });

export const EngineAgentShare: Model<EngineAgentShareDoc> = model<EngineAgentShareDoc>(
  "EngineAgentShare",
  shareSchema,
);

export function sanitizeAgent(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}

export type AgentObjectId = Types.ObjectId;
