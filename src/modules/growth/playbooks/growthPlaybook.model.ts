/**
 * Playbooks de crecimiento: las estrategias que el agente puede proponer.
 *
 * Van versionados e inmutables igual que `engine_skills` y las versiones del
 * agente: "editar" es publicar N+1 y mover `activeVersion`. El motivo es el de
 * siempre — una respuesta del agente tiene que poder explicarse con la versión
 * exacta de la estrategia que la produjo.
 *
 * LA REGLA QUE DEFINE ESTE MÓDULO: el playbook lo elige el CÓDIGO
 * (`resolveApplicablePlaybooks`) evaluando reglas contra la foto de la
 * propiedad. El modelo recibe como mucho 3 y sólo combina y redacta. Si algún
 * día alguien "mejora" esto dejando que el modelo elija la estrategia libremente,
 * vuelve exactamente el problema que esto arregla: consejos genéricos que no
 * miran los datos del hotel.
 */

import { Schema, model, type InferSchemaType } from "mongoose";

export const PLAYBOOK_GOALS = [
  "ocupacion",
  "adr",
  "directo",
  "visibilidad",
  "reputacion",
  "arranque",
] as const;
export type PlaybookGoal = (typeof PLAYBOOK_GOALS)[number];

export const RULE_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "missing",
  "present",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const EFFORTS = ["min", "horas", "dias"] as const;
export type Effort = (typeof EFFORTS)[number];

export const IMPACTS = ["alto", "medio", "bajo"] as const;
export type Impact = (typeof IMPACTS)[number];

/**
 * Una condición sobre la foto aplanada: `{ path: "ops.occ30", op: "gt", value: 0.75 }`.
 *
 * `missing` / `present` preguntan por la EXISTENCIA del dato, que no es lo
 * mismo que su valor: "no sabemos si vende" y "no vende" piden estrategias
 * distintas.
 */
export interface ApplicabilityRule {
  path: string;
  op: RuleOp;
  value?: unknown;
  /** Peso para ordenar por especificidad. Default 1. */
  weight?: number;
}

export interface PlaybookLever {
  /**
   * El `name` de la tool (`create_promo`), NO su `toolId` (`tool-118`).
   *
   * El catálogo tiene los dos: `toolId` es el identificador estable que sobrevive
   * renombres, y `name` es lo único que el modelo ve y escribe. Un plan
   * referencia lo que el modelo puede nombrar, así que acá va el name. La
   * traducción a toolId la hace `leverIndex` contra el catálogo real.
   */
  tool: string;
  /** Args que ya se pueden inferir sin datos del usuario. */
  argsTemplate?: Record<string, unknown>;
  effort: Effort;
  impact: Impact;
}

const ruleSchema = new Schema(
  {
    path: { type: String, required: true },
    op: { type: String, enum: RULE_OPS, required: true },
    value: { type: Schema.Types.Mixed },
    weight: { type: Number, default: 1 },
  },
  { _id: false },
);

const leverSchema = new Schema(
  {
    tool: { type: String, required: true },
    argsTemplate: { type: Schema.Types.Mixed, default: undefined },
    effort: { type: String, enum: EFFORTS, default: "horas" },
    impact: { type: String, enum: IMPACTS, default: "medio" },
  },
  { _id: false },
);

const playbookSchema = new Schema(
  {
    playbookId: { type: String, required: true, index: true },
    version: { type: Number, required: true, default: 1 },
    name: { type: String, required: true },
    /** Una línea. Es el nivel 1 que ve el modelo antes de decidir. */
    summary: { type: String, required: true },
    /** El instructivo completo (≤ 600 tokens), con el esqueleto fijo de §3.3. */
    body: { type: String, required: true },
    goal: { type: String, enum: PLAYBOOK_GOALS, required: true },
    applicability: { type: [ruleSchema], default: [] },
    levers: { type: [leverSchema], default: [] },
    /** Paths de la foto que miden el éxito de este playbook. */
    kpis: { type: [String], default: [] },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: "growth_playbooks" },
);

// Una versión por playbook: publicar es insertar la N+1, no editar la N.
playbookSchema.index({ playbookId: 1, version: 1 }, { unique: true });

export type GrowthPlaybookDoc = InferSchemaType<typeof playbookSchema>;
export const GrowthPlaybook = model("GrowthPlaybook", playbookSchema);

/** Forma plana que consume el resolver (sin Mongoose encima). */
export interface Playbook {
  playbookId: string;
  version: number;
  name: string;
  summary: string;
  body: string;
  goal: PlaybookGoal;
  applicability: ApplicabilityRule[];
  levers: PlaybookLever[];
  kpis: string[];
}

/**
 * Los playbooks activos, quedándose con la versión más alta de cada uno.
 *
 * Se hace en memoria y no con un pipeline de agregación porque son seis
 * documentos: la query que ahorraría 2 ms cuesta media hora de lectura cuando
 * alguien tenga que entender por qué un playbook viejo sigue apareciendo.
 */
export async function loadActivePlaybooks(): Promise<Playbook[]> {
  const docs = await GrowthPlaybook.find({ active: true }).lean();
  const latest = new Map<string, Playbook>();
  for (const d of docs) {
    const current = latest.get(d.playbookId);
    if (!current || d.version > current.version) {
      latest.set(d.playbookId, {
        playbookId: d.playbookId,
        version: d.version,
        name: d.name,
        summary: d.summary,
        body: d.body,
        goal: d.goal as PlaybookGoal,
        applicability: (d.applicability ?? []) as ApplicabilityRule[],
        levers: (d.levers ?? []) as PlaybookLever[],
        kpis: d.kpis ?? [],
      });
    }
  }
  return [...latest.values()];
}
