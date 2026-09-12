/**
 * Validación del plan que propone el modelo.
 *
 * Acá se decide qué sobrevive de lo que el modelo escribió. El criterio de
 * fondo: **el modelo propone, el código promete**. Un paso que el usuario no
 * puede ejecutar no llega a la pantalla — no porque el modelo se haya portado
 * mal, sino porque un botón que falla al tocarlo es peor que un plan más corto.
 *
 * Cinco controles, en orden:
 *   1. la tool existe, está activa y está en el índice de palancas ofrecido;
 *   2. el usuario puede ejecutarla (misma función que corta en el turno real);
 *   3. los args sugeridos son del schema (los que no, se descartan; el paso vive);
 *   4. forma del plan: evidencia suficiente, 3-7 pasos, sin repetidos;
 *   5. el código completa lo que el modelo no debe inventar (nivel de
 *      confirmación, baseline de KPI, orden final).
 */

import { randomUUID } from "crypto";
import { Tool } from "../../tools/tools.model";
import { checkToolCall } from "../../conversations/services/toolAccess";
import { confirmationFor } from "../../conversations/services/confirmationPolicy";
import type { UserScope } from "../../../shared/agentAuth/userScope";
import type { LeverIndex } from "../playbooks/leverIndex";
import type { FlatSnapshot, PropertySnapshot } from "../snapshot/snapshot.types";
import { flattenSnapshot } from "../snapshot/indicators";
import { PLAYBOOK_GOALS, EFFORTS } from "../playbooks/growthPlaybook.model";
import { PRIORITIES, type Priority, type StepStatus } from "./growthPlan.model";

export const MIN_STEPS = 3;
export const MAX_STEPS = 7;
export const MIN_EVIDENCE = 3;

/** Lo que el modelo manda en `propose_growth_plan`. Todo sin validar todavía. */
export interface RawPlanInput {
  goal?: unknown;
  horizonDays?: unknown;
  diagnosis?: unknown;
  evidence?: unknown;
  playbookIds?: unknown;
  steps?: unknown;
}

export interface ValidatedStep {
  stepId: string;
  tool: string;
  title: string;
  reason: string;
  priority: Priority;
  effort: (typeof EFFORTS)[number];
  expectedImpact: string;
  suggestedArgs?: Record<string, unknown>;
  kpi: string | null;
  confirmationLevel: "none" | "card" | "typed";
  status: StepStatus;
}

export interface ValidationResult {
  ok: boolean;
  /** Por qué se rechazó. Va al tool_result para que el modelo corrija. */
  error?: string;
  plan?: {
    goal: string;
    horizonDays: number;
    diagnosis: string;
    evidence: string[];
    playbookIds: string[];
    steps: ValidatedStep[];
    kpiBaseline: FlatSnapshot;
  };
  /** Pasos descartados y por qué. El modelo los ve para no mencionarlos. */
  dropped: Array<{ tool: string; reason: string }>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

const PRIORITY_ORDER: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };
const EFFORT_ORDER: Record<string, number> = { min: 0, horas: 1, dias: 2 };

/**
 * ¿La evidencia cita la foto de verdad?
 *
 * Se exige que al menos `MIN_EVIDENCE` líneas contengan un número. No es una
 * prueba formal de que el número salga del snapshot, pero corta el modo de
 * falla real: la "evidencia" que dice "el hotel tiene poca visibilidad online"
 * sin un solo dato. Con el número adentro, el usuario puede contrastarlo contra
 * la tarjeta y el equipo puede auditarlo.
 */
function evidenceCitesData(evidence: string[]): boolean {
  return evidence.filter((e) => /\d/.test(e)).length >= MIN_EVIDENCE;
}

/**
 * Cómo se traen las definiciones de las tools del plan.
 *
 * Es un parámetro para que el test pueda correr sin base: la validación es la
 * pieza que impide que el agente prometa cosas que el usuario no puede hacer, y
 * un control así tiene que poder testearse en cada commit, no sólo cuando hay
 * una Mongo a mano.
 */
export type ToolLoader = (names: string[]) => Promise<ToolDoc[]>;

export interface ToolDoc {
  name: string;
  displayName?: string | null;
  category: string;
  inputSchema?: { properties?: Record<string, unknown> } | null;
  execution: { method: string };
  permissions?: Record<string, unknown> | null;
}

const loadToolsFromDb: ToolLoader = async (names) => {
  if (names.length === 0) return [];
  return Tool.find({ name: { $in: names }, status: "active" }).lean() as never;
};

export async function validatePlan(input: {
  raw: RawPlanInput;
  index: LeverIndex;
  scope: UserScope | null;
  snapshot: PropertySnapshot;
  offeredPlaybookIds: string[];
  propertyId?: string;
  companyId?: string;
  loadTools?: ToolLoader;
}): Promise<ValidationResult> {
  const { raw, index, scope, snapshot } = input;
  const dropped: ValidationResult["dropped"] = [];

  const diagnosis = str(raw.diagnosis);
  if (!diagnosis) {
    return { ok: false, error: "Falta el diagnóstico.", dropped };
  }

  const evidence = strList(raw.evidence);
  if (evidence.length < MIN_EVIDENCE || !evidenceCitesData(evidence)) {
    return {
      ok: false,
      error:
        `La evidencia tiene que ser al menos ${MIN_EVIDENCE} líneas y cada una citar un dato ` +
        `CONCRETO de la foto (con su número). Reescribila usando los valores reales que tenés arriba.`,
      dropped,
    };
  }

  const goal = str(raw.goal);
  if (!PLAYBOOK_GOALS.includes(goal as never)) {
    return {
      ok: false,
      error: `"goal" tiene que ser uno de: ${PLAYBOOK_GOALS.join(", ")}.`,
      dropped,
    };
  }

  const horizonRaw = Number(raw.horizonDays);
  const horizonDays = [30, 60, 90].includes(horizonRaw) ? horizonRaw : 90;

  // Playbooks: sólo los que se ofrecieron. Si el modelo cita uno que no estaba,
  // se descarta la cita (no el plan): el contenido puede seguir siendo válido,
  // pero la atribución no.
  const playbookIds = strList(raw.playbookIds).filter((id) =>
    input.offeredPlaybookIds.includes(id),
  );

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length === 0) {
    return { ok: false, error: "El plan no trae pasos.", dropped };
  }

  // Un solo viaje a la base por todas las tools del plan.
  const wanted = [
    ...new Set(
      rawSteps
        .map((s) => str((s as Record<string, unknown>)?.tool))
        .filter(Boolean),
    ),
  ];
  const docs = await (input.loadTools ?? loadToolsFromDb)(wanted);
  const byName = new Map(docs.map((d) => [d.name, d]));

  const steps: ValidatedStep[] = [];
  const seen = new Set<string>();

  for (const rawStep of rawSteps) {
    const s = (rawStep ?? {}) as Record<string, unknown>;
    const tool = str(s.tool);
    if (!tool) {
      dropped.push({ tool: "(sin nombre)", reason: "el paso no nombra ninguna herramienta" });
      continue;
    }
    if (seen.has(tool)) {
      dropped.push({ tool, reason: "repetido: ya había un paso con esta herramienta" });
      continue;
    }
    const doc = byName.get(tool);
    if (!doc) {
      dropped.push({ tool, reason: "no existe en el catálogo o está inactiva" });
      continue;
    }
    if (!index.allowed.has(tool)) {
      dropped.push({ tool, reason: "no está en el índice de palancas de este turno" });
      continue;
    }

    // Args sugeridos: sólo los declarados en el schema de la tool. Un arg
    // inventado no invalida el paso — se tira y el usuario completa al
    // ejecutar, que es lo que iba a pasar igual.
    const schemaProps =
      (doc.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
    const rawArgs =
      s.suggestedArgs && typeof s.suggestedArgs === "object" && !Array.isArray(s.suggestedArgs)
        ? (s.suggestedArgs as Record<string, unknown>)
        : {};
    const suggestedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (k in schemaProps) suggestedArgs[k] = v;
    }

    // Permisos, con los args que realmente se van a usar.
    if (scope) {
      const decision = checkToolCall(doc as never, suggestedArgs, scope, {
        propertyId: input.propertyId,
        companyId: input.companyId,
      });
      if (!decision.allowed) {
        dropped.push({
          tool,
          reason: decision.message ?? "el usuario no tiene permiso para esta acción",
        });
        continue;
      }
    }

    seen.add(tool);
    const priority = (PRIORITIES as readonly string[]).includes(str(s.priority))
      ? (str(s.priority) as Priority)
      : "media";
    const effort = (EFFORTS as readonly string[]).includes(str(s.effort))
      ? (str(s.effort) as (typeof EFFORTS)[number])
      : "horas";

    steps.push({
      stepId: `step-${randomUUID().slice(0, 8)}`,
      tool,
      title: str(s.title) || doc.displayName || tool,
      reason: str(s.reason),
      priority,
      effort,
      expectedImpact: str(s.expectedImpact),
      suggestedArgs: Object.keys(suggestedArgs).length ? suggestedArgs : undefined,
      kpi: str(s.kpi) || null,
      // El nivel de confirmación NO lo elige el modelo: sale de la misma
      // función que gobierna el gate en el runner. Un paso irreversible sigue
      // exigiendo confirmación escrita aunque el plan diga que es trivial.
      confirmationLevel: confirmationFor(doc as never, suggestedArgs).level,
      status: "sugerido",
    });
  }

  if (steps.length < MIN_STEPS) {
    const why = dropped.length
      ? ` Se descartaron: ${dropped.map((d) => `${d.tool} (${d.reason})`).join("; ")}.`
      : "";
    return {
      ok: false,
      error:
        `Quedaron ${steps.length} pasos válidos y hacen falta al menos ${MIN_STEPS}.${why} ` +
        `Proponé otros usando SÓLO nombres del índice de palancas.`,
      dropped,
    };
  }

  // Orden final por criterio del código: primero lo urgente, y dentro de lo
  // urgente lo que se resuelve más rápido. Un plan que arranca por lo más caro
  // no lo empieza nadie.
  steps.sort((a, b) => {
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    return (EFFORT_ORDER[a.effort] ?? 1) - (EFFORT_ORDER[b.effort] ?? 1);
  });

  return {
    ok: true,
    dropped,
    plan: {
      goal,
      horizonDays,
      diagnosis,
      evidence: evidence.slice(0, 5),
      playbookIds,
      steps: steps.slice(0, MAX_STEPS),
      kpiBaseline: pickBaseline(snapshot, steps),
    },
  };
}

/**
 * Baseline de KPI: los valores de la foto contra los que se va a medir.
 *
 * Se guardan los KPI que los pasos declararon más un puñado fijo de los que
 * casi cualquier plan mueve. Guardar la foto entera sería más simple pero
 * convierte cada plan en un documento grande y hace ruido al comparar.
 */
function pickBaseline(
  snapshot: PropertySnapshot,
  steps: ValidatedStep[],
): FlatSnapshot {
  const flat = flattenSnapshot(snapshot);
  const keys = new Set<string>([
    // Comerciales: salen de las filas de pace, no del reporte de dashboard.
    "demand.occ30",
    "demand.adr",
    "demand.revenueOtb30",
    "demand.otb30",
    "demand.otb90",
    // Operativos y de canal.
    "ops.reservationsCurrent",
    "ops.directSharePct",
    // Presencia y reputación.
    "presence.visibilityScore",
    "reputation.rating",
    "reputation.reviews",
  ]);
  for (const s of steps) if (s.kpi) keys.add(s.kpi);

  const baseline: FlatSnapshot = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(flat, k)) baseline[k] = flat[k];
  }
  return baseline;
}
