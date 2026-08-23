/**
 * `engine_skills` + `engine_skill_versions` — habilidades (§19).
 *
 * Una habilidad es una capacidad modular cargable con REVELACIÓN PROGRESIVA en
 * dos niveles:
 *
 *   Nivel 1 (siempre visible)  nombre + descripción, inyectados en el prompt.
 *   Nivel 2 (bajo demanda)     el cuerpo en marcado, cargado por una herramienta
 *                              de runtime cuando el modelo decide que le sirve.
 *
 * Los dos niveles existen por presupuesto de contexto: veinte habilidades con
 * su cuerpo completo consumen el contexto entero antes de que el agente lea el
 * mensaje del usuario. Con la revelación progresiva, veinte habilidades cuestan
 * veinte líneas.
 *
 * La DESCRIPCIÓN es obligatoria y no es burocracia: es lo único que el modelo ve
 * en el nivel 1, así que una habilidad sin descripción jamás puede ser elegida.
 * Existir sin poder ser elegida es peor que no existir, porque ocupa contexto.
 */
import { Schema, model, type Model } from "mongoose";

export const SKILL_SCOPES = ["agent", "user", "tenant", "global"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/**
 * Precedencia: gana el MÁS ESPECÍFICO. Un agente puede sobrescribir una
 * habilidad del inquilino sin pedirle permiso a nadie, que es lo que hace la
 * personalización viable.
 */
export const SKILL_SCOPE_RANK: Record<SkillScope, number> = {
  agent: 4,
  user: 3,
  tenant: 2,
  global: 1,
};

export interface EngineSkillDoc {
  skillId: string;
  /** Lo ve el modelo. Único por ámbito. */
  name: string;
  displayName: string;
  /** OBLIGATORIA: es el nivel 1. Sin ella la habilidad es inelegible. */
  description: string;

  scope: SkillScope;
  tenantId: string | null;
  /** Ancla del ámbito `agent`. */
  agentId?: string | null;
  /** Ancla del ámbito `user`. */
  ownerUserId?: string | null;

  activeVersionId: string | null;
  status: "active" | "disabled";
  tags: string[];

  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const skillSchema = new Schema<EngineSkillDoc>(
  {
    skillId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    displayName: { type: String, default: "" },
    description: { type: String, required: true },

    scope: { type: String, enum: SKILL_SCOPES, default: "tenant", index: true },
    tenantId: { type: String, default: null, index: true },
    agentId: { type: String, default: null, index: true },
    ownerUserId: { type: String, default: null },

    activeVersionId: { type: String, default: null },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    tags: { type: [String], default: [] },

    createdByUserId: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "engine_skills" },
);

/**
 * Índices únicos PARCIALES por ámbito. Uno solo sobre `(name, scope)` no
 * alcanza: dos agentes distintos tienen que poder definir su propia `redactar`
 * de ámbito `agent`, y eso exige que el ancla entre en la clave.
 */
skillSchema.index(
  { name: 1, scope: 1, agentId: 1 },
  { unique: true, partialFilterExpression: { scope: "agent", deletedAt: null } },
);
skillSchema.index(
  { name: 1, scope: 1, ownerUserId: 1 },
  { unique: true, partialFilterExpression: { scope: "user", deletedAt: null } },
);
skillSchema.index(
  { name: 1, scope: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { scope: "tenant", deletedAt: null } },
);
skillSchema.index(
  { name: 1, scope: 1 },
  { unique: true, partialFilterExpression: { scope: "global", deletedAt: null } },
);

export const EngineSkill: Model<EngineSkillDoc> = model<EngineSkillDoc>(
  "EngineSkill",
  skillSchema,
);

/** Versión inmutable del cuerpo. Mismo modelo de versionado que los agentes. */
export interface EngineSkillVersionDoc {
  versionId: string;
  skillId: string;
  version: number;
  /** Nivel 2: el cuerpo en marcado. */
  body: string;
  /** Copia de la descripción vigente al guardar, para poder diffear. */
  description: string;
  changeNote?: string | null;
  createdByUserId: string;
  createdAt: Date;
}

const skillVersionSchema = new Schema<EngineSkillVersionDoc>(
  {
    versionId: { type: String, required: true, unique: true, index: true },
    skillId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    body: { type: String, default: "" },
    description: { type: String, default: "" },
    changeNote: { type: String, default: null },
    createdByUserId: { type: String, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "engine_skill_versions",
  },
);

skillVersionSchema.index({ skillId: 1, version: -1 }, { unique: true });

export const EngineSkillVersion: Model<EngineSkillVersionDoc> = model<EngineSkillVersionDoc>(
  "EngineSkillVersion",
  skillVersionSchema,
);

export function sanitizeSkill(doc: unknown): Record<string, unknown> | null {
  if (!doc) return null;
  const obj = (doc as { toObject?: () => Record<string, unknown> }).toObject
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
