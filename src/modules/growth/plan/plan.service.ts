/**
 * Ciclo de vida del plan: crearlo, marcar sus pasos, cerrarlo y medir el avance.
 */

import { randomUUID } from "crypto";
import {
  GrowthPlan,
  type GrowthPlanDoc,
  type StepStatus,
} from "./growthPlan.model";
import type { ValidatedStep } from "./plan.validate";
import type { FlatSnapshot, PropertySnapshot } from "../snapshot/snapshot.types";
import { flattenSnapshot } from "../snapshot/indicators";
import { upsertPlanMemory, clearPlanMemory } from "./planMemory";

export interface PlanScope {
  companyId?: string;
  propertyId: string;
  operativeSpaceId?: string;
  sessionId?: string;
  userId?: string;
}

type PlanLean = GrowthPlanDoc & { _id?: unknown };

/** El plan activo del espacio (o de la propiedad, si no hay espacio). */
export async function getActivePlan(scope: {
  operativeSpaceId?: string;
  propertyId?: string;
}): Promise<PlanLean | null> {
  const filter: Record<string, unknown> = { status: "activo" };
  if (scope.operativeSpaceId) filter.operativeSpaceId = scope.operativeSpaceId;
  else if (scope.propertyId) filter.propertyId = scope.propertyId;
  else return null;

  return GrowthPlan.findOne(filter).sort({ updatedAt: -1 }).lean<PlanLean>();
}

export async function getPlan(planId: string): Promise<PlanLean | null> {
  return GrowthPlan.findOne({ planId }).lean<PlanLean>();
}

/**
 * Crea el plan y cierra el anterior.
 *
 * El anterior queda `completado` si ya se había ejecutado la mayor parte, y
 * `abandonado` si no. La diferencia importa para el turno de seguimiento: no es
 * lo mismo "terminaste el plan y querés otro" que "dejaste el plan por la mitad
 * y arrancás de nuevo", y el agente lo tiene que poder decir.
 */
export async function createPlan(input: {
  scope: PlanScope;
  goal: string;
  horizonDays: number;
  diagnosis: string;
  evidence: string[];
  playbookIds: string[];
  steps: ValidatedStep[];
  kpiBaseline: FlatSnapshot;
  snapshotTakenAt: string;
}): Promise<PlanLean> {
  const previous = await getActivePlan({
    operativeSpaceId: input.scope.operativeSpaceId,
    propertyId: input.scope.propertyId,
  });
  if (previous) {
    const done = previous.steps.filter((s) => s.status === "ejecutado").length;
    const ratio = previous.steps.length > 0 ? done / previous.steps.length : 0;
    await GrowthPlan.updateOne(
      { planId: previous.planId },
      { $set: { status: ratio >= 0.7 ? "completado" : "abandonado" } },
    );
  }

  const doc = await GrowthPlan.create({
    planId: `plan-${randomUUID()}`,
    companyId: input.scope.companyId ?? null,
    propertyId: input.scope.propertyId,
    operativeSpaceId: input.scope.operativeSpaceId ?? null,
    sessionId: input.scope.sessionId ?? null,
    createdByUserId: input.scope.userId ?? null,
    goal: input.goal,
    horizonDays: input.horizonDays,
    diagnosis: input.diagnosis,
    evidence: input.evidence,
    playbookIds: input.playbookIds,
    steps: input.steps,
    kpiBaseline: input.kpiBaseline,
    snapshotTakenAt: input.snapshotTakenAt,
    status: "activo",
  });

  const plan = doc.toObject() as PlanLean;
  await upsertPlanMemory(plan);
  return plan;
}

/** Marca un paso. Devuelve el plan actualizado, o null si no existe. */
export async function markStep(input: {
  planId: string;
  stepId: string;
  status: StepStatus;
  messageId?: string;
  resultSummary?: string;
  errorCode?: string;
}): Promise<PlanLean | null> {
  const set: Record<string, unknown> = {
    "steps.$[s].status": input.status,
  };
  if (input.status === "ejecutado") set["steps.$[s].executedAt"] = new Date();
  if (input.messageId) set["steps.$[s].messageId"] = input.messageId;
  if (input.resultSummary) {
    set["steps.$[s].resultSummary"] = input.resultSummary.slice(0, 200);
  }
  if (input.errorCode) set["steps.$[s].errorCode"] = input.errorCode;

  await GrowthPlan.updateOne({ planId: input.planId }, { $set: set }, {
    arrayFilters: [{ "s.stepId": input.stepId }],
  });

  const plan = await getPlan(input.planId);
  if (!plan) return null;

  // Todos los pasos resueltos = el plan se cierra solo. Si quedó alguno
  // rechazado o fallido igual cuenta como completado: el usuario ya decidió
  // sobre cada uno, que es lo que el plan pedía.
  const pending = plan.steps.filter(
    (s) => s.status === "sugerido" || s.status === "aceptado",
  ).length;
  if (pending === 0 && plan.status === "activo") {
    await GrowthPlan.updateOne(
      { planId: input.planId },
      { $set: { status: "completado" } },
    );
    plan.status = "completado";
  }

  await upsertPlanMemory(plan);
  return plan;
}

export async function closePlan(
  planId: string,
  status: "completado" | "abandonado",
): Promise<void> {
  await GrowthPlan.updateOne({ planId }, { $set: { status } });
  const plan = await getPlan(planId);
  if (plan?.operativeSpaceId) await clearPlanMemory(plan.operativeSpaceId);
}

// ── Avance ───────────────────────────────────────────────────────────────────

export interface KpiDelta {
  path: string;
  label: string;
  before: number;
  after: number;
  /** Variación relativa. null si el baseline era 0 (no se puede dividir). */
  changeRatio: number | null;
}

const KPI_LABELS: Record<string, string> = {
  "demand.occ30": "ocupación de los próximos 30 días",
  "demand.adr": "tarifa promedio",
  "demand.revenueOtb30": "ingresos comprometidos a 30 días",
  "demand.otb30": "noches vendidas a 30 días",
  "demand.otb90": "noches vendidas a 90 días",
  "ops.reservationsCurrent": "reservas del período",
  "ops.directSharePct": "reservas por canal directo",
  "presence.visibilityScore": "score de visibilidad",
  "reputation.rating": "rating de reseñas",
  "reputation.reviews": "cantidad de reseñas",
};

/** Qué se movió desde que el plan arrancó. Sólo números, sólo lo que cambió. */
export function computeKpiDeltas(
  plan: Pick<GrowthPlanDoc, "kpiBaseline">,
  snapshot: PropertySnapshot,
): KpiDelta[] {
  const baseline = (plan.kpiBaseline ?? {}) as FlatSnapshot;
  const now = flattenSnapshot(snapshot);
  const deltas: KpiDelta[] = [];

  for (const [path, beforeRaw] of Object.entries(baseline)) {
    if (typeof beforeRaw !== "number") continue;
    const afterRaw = now[path];
    if (typeof afterRaw !== "number") continue;
    if (afterRaw === beforeRaw) continue;
    deltas.push({
      path,
      label: KPI_LABELS[path] ?? path,
      before: beforeRaw,
      after: afterRaw,
      changeRatio: beforeRaw !== 0 ? (afterRaw - beforeRaw) / beforeRaw : null,
    });
  }

  // Los movimientos más grandes primero: es lo que el usuario quiere oír.
  return deltas.sort(
    (a, b) => Math.abs(b.changeRatio ?? 0) - Math.abs(a.changeRatio ?? 0),
  );
}

function fmtKpi(path: string, value: number): string {
  // La ocupación viaja como 0..1 y se muestra en %; las cuotas de canal ya
  // vienen en % (0..100) y volver a multiplicarlas daría 4.000%.
  if (path === "demand.occ30") return `${Math.round(value * 100)}%`;
  if (path.endsWith("Pct")) return `${Math.round(value)}%`;
  if (path.endsWith("Score")) return `${Math.round(value)}/100`;
  if (path === "reputation.rating") return value.toFixed(2);
  return Math.round(value).toLocaleString("es-AR");
}

/**
 * Bloque "Plan activo" para el prompt.
 *
 * Va en TODOS los turnos del espacio, no sólo los estratégicos: así "hacé el
 * paso 2" o "¿cómo venimos?" funcionan en una conversación operativa normal,
 * que es donde el usuario los va a escribir.
 */
export function renderActivePlanBlock(
  plan: PlanLean,
  deltas: KpiDelta[] = [],
): string {
  const done = plan.steps.filter((s) => s.status === "ejecutado");
  const pending = plan.steps.filter(
    (s) => s.status === "sugerido" || s.status === "aceptado",
  );
  const rejected = plan.steps.filter((s) => s.status === "rechazado");
  const created = plan.snapshotTakenAt?.slice(0, 10) ?? "";

  const lines = [
    "## Plan de crecimiento activo",
    `Objetivo: ${plan.goal} · horizonte ${plan.horizonDays} días · creado ${created}.`,
    `Diagnóstico original: ${plan.diagnosis}`,
    `Progreso: ${done.length} de ${plan.steps.length} pasos ejecutados${rejected.length ? `, ${rejected.length} rechazados` : ""}.`,
  ];

  if (pending.length > 0) {
    lines.push(
      "Pasos pendientes (referilos por su número si el usuario pregunta):",
      ...pending.map((s, i) => `${i + 1}. ${s.title} — \`${s.tool}\` (${s.priority})`),
    );
  } else {
    lines.push("No quedan pasos pendientes.");
  }

  if (deltas.length > 0) {
    lines.push(
      "Cómo se movieron los números desde que arrancó el plan:",
      ...deltas
        .slice(0, 5)
        .map(
          (d) =>
            `- ${d.label}: ${fmtKpi(d.path, d.before)} → ${fmtKpi(d.path, d.after)}` +
            (d.changeRatio !== null
              ? ` (${d.changeRatio >= 0 ? "+" : ""}${Math.round(d.changeRatio * 100)}%)`
              : ""),
        ),
    );
  }

  lines.push(
    "Si el usuario vuelve a pedir crecimiento con el MISMO objetivo, no propongas un plan nuevo:",
    "reportá el avance y ofrecé seguir por los pasos pendientes.",
  );

  return lines.join("\n");
}
