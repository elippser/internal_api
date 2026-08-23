/**
 * `engine_agent_versions` — instantánea INMUTABLE de configuración (§6.2).
 *
 * Nada de esta colección se actualiza jamás. El servicio de agentes sólo hace
 * `create`; "editar" significa crear la versión N+1 y mover el puntero del
 * agente. Eso da tres cosas gratis: reproducibilidad (una ejecución sabe
 * exactamente qué corrió), reversión (mover el puntero atrás es una escritura)
 * y comparación (repetir una corrida con la versión original vs. la vigente).
 *
 * Las bolsas JSON (`config`, `graphConfig`, `modelParams`, `outputSchema`) son
 * la frontera de extensión: se validan por esquema en la capa de aplicación,
 * para que agregar una opción de política no requiera tocar el modelo.
 */
import { Schema, model, type Model } from "mongoose";
import {
  COMPLEXITY_TIERS,
  CONCURRENCY_MODES,
  GRAPH_TYPES,
  RUNTIME_CAPABILITIES,
  SUB_AGENT_MODES,
  type ComplexityTier,
  type ConcurrencyMode,
  type GraphType,
  type RuntimeCapability,
  type SubAgentMode,
} from "./enums";

/** Referencia a un sub-agente cableado como herramienta (§14). */
export interface SubAgentRef {
  /** Nombre con el que se expone al modelo padre. Debe ser único en la versión. */
  name: string;
  /** Agente destino. Se valida la propiedad al guardar: el runtime lo EJECUTA. */
  agentId: string;
  description: string;
  mode: SubAgentMode;
  /**
   * Menú de modelos por complejidad. Cuando tiene entradas, la herramienta
   * expone un argumento `complexity` y el runtime resuelve el primer modelo
   * disponible de esa etiqueta (la lista es la cadena de reserva). Una elección
   * explícita por llamada gana siempre.
   */
  models: Array<{ tier: ComplexityTier; model: string }>;
  maxDepth?: number | null;
  timeoutSeconds?: number | null;
  /** Subconjunto de herramientas del hijo visible en esta delegación. */
  toolAllowlist?: string[];
}

export interface ContextProviderRef {
  type: string;
  config?: Record<string, unknown>;
}

/** Regla declarativa de interrupción de aprobación (§15.3). */
export interface InterruptionRule {
  trigger: "tool_call" | "turn_count";
  /** Obligatorio para `tool_call`: el emparejamiento es por nombre exacto. */
  toolName?: string;
  /** Obligatorio para `turn_count`: entero ≥ 1. */
  everyNTurns?: number;
  message?: string;
}

export interface AgentVersionConfig {
  capabilities?: Partial<Record<RuntimeCapability, boolean>>;
  interruptions?: InterruptionRule[];
  guardrails?: { input?: string[]; output?: string[]; tool?: string[] };
  hooks?: { preRun?: string[]; postRun?: string[]; preTool?: string[]; postTool?: string[] };
  context?: {
    historyWindowMessages?: number;
    maxHistoryTokens?: number;
    /** TTL extendido del prefijo cacheable. */
    cacheTtl?: "5m" | "1h";
  };
  /** Modelo alternativo al que se enrutan los turnos con imagen. */
  visionModel?: string | null;
  /** Clase de concurrencia por herramienta, cuando el catálogo no alcanza. */
  toolConcurrency?: Record<string, ConcurrencyMode>;
  [key: string]: unknown;
}

export interface EngineAgentVersionDoc {
  versionId: string;
  agentId: string;
  /** Entero incremental, único por agente. Es lo que ve el humano. */
  version: number;

  graphType: GraphType;
  systemPrompt: string;

  /** Nombres de herramienta. El catálogo resuelve; acá sólo viven referencias. */
  tools: string[];
  skills: string[];
  subAgents: SubAgentRef[];

  /** Cualificado por proveedor: `anthropic/claude-opus-5`. */
  modelName: string;
  modelParams: Record<string, unknown>;

  outputSchema?: Record<string, unknown> | null;
  contextSchema?: Record<string, unknown> | null;
  contextProviders: ContextProviderRef[];
  /** Nombres de credencial requeridos. NUNCA valores: §35.8. */
  credentials: string[];

  graphConfig: Record<string, unknown>;
  config: AgentVersionConfig;

  timeoutSeconds: number;
  maxDurationSeconds: number;
  maxRetries: number;

  /** Nota de cambio de una línea, para el historial de versiones. */
  changeNote?: string | null;
  createdByUserId: string;
  createdAt: Date;
}

const subAgentRefSchema = new Schema<SubAgentRef>(
  {
    name: { type: String, required: true },
    agentId: { type: String, required: true },
    description: { type: String, default: "" },
    mode: { type: String, enum: SUB_AGENT_MODES, default: "inline" },
    models: {
      type: [
        new Schema(
          {
            tier: { type: String, enum: COMPLEXITY_TIERS, required: true },
            model: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    maxDepth: { type: Number, default: null },
    timeoutSeconds: { type: Number, default: null },
    toolAllowlist: { type: [String], default: [] },
  },
  { _id: false },
);

const contextProviderSchema = new Schema<ContextProviderRef>(
  {
    type: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const versionSchema = new Schema<EngineAgentVersionDoc>(
  {
    versionId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    version: { type: Number, required: true },

    graphType: { type: String, enum: GRAPH_TYPES, default: "react_loop" },
    systemPrompt: { type: String, default: "" },

    tools: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    subAgents: { type: [subAgentRefSchema], default: [] },

    modelName: { type: String, required: true },
    modelParams: { type: Schema.Types.Mixed, default: {} },

    outputSchema: { type: Schema.Types.Mixed, default: null },
    contextSchema: { type: Schema.Types.Mixed, default: null },
    contextProviders: { type: [contextProviderSchema], default: [] },
    credentials: { type: [String], default: [] },

    graphConfig: { type: Schema.Types.Mixed, default: {} },
    config: { type: Schema.Types.Mixed, default: {} },

    timeoutSeconds: { type: Number, default: 300 },
    maxDurationSeconds: { type: Number, default: 1800 },
    maxRetries: { type: Number, default: 0 },

    changeNote: { type: String, default: null },
    createdByUserId: { type: String, required: true },
  },
  // Sin `updatedAt`: la fila es inmutable, un campo que promete mutación
  // mentiría. Sin borrado suave: es historia.
  { timestamps: { createdAt: true, updatedAt: false }, collection: "engine_agent_versions" },
);

/**
 * Único por (agente, número). Es lo que hace segura la asignación del número:
 * dos guardados concurrentes calculan el mismo N+1 y uno de los dos choca con
 * este índice en vez de crear dos "versión 4" distintas.
 */
versionSchema.index({ agentId: 1, version: -1 }, { unique: true });

export const EngineAgentVersion: Model<EngineAgentVersionDoc> = model<EngineAgentVersionDoc>(
  "EngineAgentVersion",
  versionSchema,
);

export function sanitizeVersion(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}

/** Capacidad activa en una versión. Todas apagadas por defecto (§13). */
export function hasCapability(
  version: Pick<EngineAgentVersionDoc, "config">,
  capability: RuntimeCapability,
): boolean {
  return version.config?.capabilities?.[capability] === true;
}

export const ALL_CAPABILITIES = RUNTIME_CAPABILITIES;
export { CONCURRENCY_MODES };
