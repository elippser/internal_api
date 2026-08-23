/**
 * Resolución de habilidades y revelación progresiva (§19).
 *
 * Resuelve por ámbito con la regla "gana el más específico"
 * (agente → usuario → inquilino → global) y arma el bloque de NIVEL 1 que va al
 * prompt: una línea por habilidad, nombre y descripción, nada más.
 *
 * El nivel 2 lo carga la herramienta `load_skill` cuando el modelo decide que
 * le sirve. Esa asimetría es todo el diseño: el costo de tener una habilidad
 * disponible es una línea; el costo de usarla se paga sólo cuando se usa.
 */
import { createLogger } from "../core/logger";
import {
  EngineSkill,
  EngineSkillVersion,
  SKILL_SCOPE_RANK,
  type EngineSkillDoc,
} from "../models/skill.model";

const log = createLogger("engine:skills");

export interface ResolvedSkill {
  skillId: string;
  name: string;
  description: string;
  scope: EngineSkillDoc["scope"];
  activeVersionId: string | null;
}

export interface SkillResolutionOptions {
  tenantId: string | null;
  agentId: string;
  userId?: string | null;
  /** Nombres declarados en la versión del agente. Vacío = todas las del ámbito. */
  declared?: string[];
}

/**
 * Devuelve las habilidades visibles, ya desambiguadas por precedencia.
 *
 * Cuando dos ámbitos definen el mismo NOMBRE, gana el más específico y el otro
 * se descarta en silencio — que es lo que el autor espera: definir `redactar` a
 * nivel agente es exactamente la forma de sobrescribir la del inquilino.
 */
export async function resolveSkills(opts: SkillResolutionOptions): Promise<ResolvedSkill[]> {
  const candidates = await EngineSkill.find({
    status: "active",
    deletedAt: null,
    activeVersionId: { $ne: null },
    $or: [
      { scope: "global" },
      { scope: "tenant", tenantId: opts.tenantId },
      ...(opts.userId ? [{ scope: "user" as const, ownerUserId: opts.userId }] : []),
      { scope: "agent", agentId: opts.agentId },
    ],
  }).lean();

  const byName = new Map<string, EngineSkillDoc>();
  for (const skill of candidates) {
    const current = byName.get(skill.name);
    if (!current || SKILL_SCOPE_RANK[skill.scope] > SKILL_SCOPE_RANK[current.scope]) {
      byName.set(skill.name, skill as EngineSkillDoc);
    }
  }

  let resolved = [...byName.values()];

  // La lista declarada en la versión actúa como SELECTOR: un agente que declara
  // habilidades explícitas no recibe todas las de su inquilino.
  if (opts.declared && opts.declared.length > 0) {
    const wanted = new Set(opts.declared);
    resolved = resolved.filter((s) => wanted.has(s.name));

    const missing = opts.declared.filter((n) => !byName.has(n));
    if (missing.length > 0) {
      log.warn("habilidades declaradas que no resuelven en este ámbito", { missing });
    }
  }

  return resolved.map((s) => ({
    skillId: s.skillId,
    name: s.name,
    description: s.description,
    scope: s.scope,
    activeVersionId: s.activeVersionId,
  }));
}

/**
 * Bloque de NIVEL 1 para el prompt. Es deliberadamente escueto: si acá entrara
 * el cuerpo, la revelación progresiva no existiría.
 *
 * Va en el prefijo ESTABLE del prompt (seguro para caché): el conjunto de
 * habilidades no cambia entre turnos de la misma conversación.
 */
export function renderSkillsBlock(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return "";

  return [
    "## Habilidades disponibles",
    "Cada una es un instructivo que podés cargar con la herramienta `load_skill` " +
      "cuando la tarea lo amerite. No las cargues por las dudas: cargá la que necesitás.",
    ...skills.map((s) => `- **${s.name}**: ${s.description}`),
  ].join("\n");
}

/** Nivel 2: el cuerpo. Lo pide `load_skill`. */
export async function loadSkillBody(
  name: string,
  opts: SkillResolutionOptions,
): Promise<{ ok: boolean; name: string; body?: string; error?: string }> {
  const visible = await resolveSkills(opts);
  const skill = visible.find((s) => s.name === name);

  if (!skill) {
    return {
      ok: false,
      name,
      error:
        `La habilidad "${name}" no está disponible para este agente. ` +
        `Disponibles: ${visible.map((s) => s.name).join(", ") || "ninguna"}.`,
    };
  }
  if (!skill.activeVersionId) {
    return { ok: false, name, error: `La habilidad "${name}" no tiene versión activa.` };
  }

  const version = await EngineSkillVersion.findOne({
    versionId: skill.activeVersionId,
  }).lean();
  if (!version) {
    return { ok: false, name, error: `No se encontró el cuerpo de "${name}".` };
  }

  return { ok: true, name, body: version.body };
}
