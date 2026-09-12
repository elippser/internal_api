/**
 * La memoria del plan: UNA por espacio operativo, escrita por código.
 *
 * Por qué no se destila con el mecanismo normal (`distillFromExchange`):
 *
 *  1. **Es un hecho conocido, no uno que haya que inferir.** El plan está en la
 *     base con sus pasos y sus estados. Pagarle a un modelo para que lea el
 *     intercambio y adivine lo que ya sabemos es gasto y ruido.
 *  2. **La memoria del espacio está capada en 25 entradas.** Un destilado por
 *     cada cambio de estado de cada paso la llenaría de variantes de la misma
 *     frase y desplazaría las memorias que sí valen (preferencias del hotel,
 *     convenciones del equipo).
 *
 * Por eso: `memoryId` determinístico y upsert. Cada cambio REEMPLAZA, no suma.
 */

import { AgentMemory } from "../../memory/memory.model";
import type { GrowthPlanDoc } from "./growthPlan.model";

const GOAL_LABEL: Record<string, string> = {
  ocupacion: "aumentar la ocupación",
  adr: "mejorar la tarifa promedio",
  directo: "vender más por canal directo",
  visibilidad: "mejorar la visibilidad online",
  reputacion: "mejorar la reputación",
  arranque: "poner el alojamiento en marcha",
};

function memoryIdFor(operativeSpaceId: string): string {
  return `plan:${operativeSpaceId}`;
}

export function renderPlanMemory(plan: GrowthPlanDoc): string {
  const done = plan.steps.filter((s) => s.status === "ejecutado").length;
  const rejected = plan.steps.filter((s) => s.status === "rechazado").length;
  const next = plan.steps.find(
    (s) => s.status === "sugerido" || s.status === "aceptado",
  );
  const created = plan.snapshotTakenAt?.slice(0, 10) ?? "";
  const goal = GOAL_LABEL[plan.goal] ?? plan.goal;

  const parts = [
    `Plan de crecimiento ${plan.status} (${created}, objetivo: ${goal}, ${plan.horizonDays} días):`,
    `${plan.steps.length} pasos, ${done} ejecutados${rejected ? `, ${rejected} rechazados` : ""}.`,
  ];
  if (next) parts.push(`Siguiente: ${next.title} (${next.tool}).`);
  else parts.push("Sin pasos pendientes.");
  return parts.join(" ");
}

/**
 * Escribe (o pisa) la memoria del plan del espacio.
 *
 * Sin `operativeSpaceId` no hay dónde guardarla: la memoria es de equipo y el
 * espacio es su clave. Se sale en silencio, como el resto de la memoria, que es
 * best-effort por diseño.
 */
export async function upsertPlanMemory(plan: GrowthPlanDoc): Promise<void> {
  if (!plan.operativeSpaceId) return;
  try {
    await AgentMemory.updateOne(
      { memoryId: memoryIdFor(plan.operativeSpaceId) },
      {
        $set: {
          companyId: plan.companyId ?? null,
          propertyId: plan.propertyId ?? null,
          operativeSpaceId: plan.operativeSpaceId,
          content: renderPlanMemory(plan),
          kind: "context",
          sourceSessionId: plan.sessionId ?? null,
          createdByUserId: plan.createdByUserId ?? null,
        },
        $setOnInsert: { memoryId: memoryIdFor(plan.operativeSpaceId) },
      },
      { upsert: true },
    );
  } catch (err) {
    console.warn(
      "[growth/plan] no se pudo guardar la memoria del plan:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function clearPlanMemory(operativeSpaceId: string): Promise<void> {
  try {
    await AgentMemory.deleteOne({ memoryId: memoryIdFor(operativeSpaceId) });
  } catch {
    // best-effort, igual que el resto de la memoria
  }
}
