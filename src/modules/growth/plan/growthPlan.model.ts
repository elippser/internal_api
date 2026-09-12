/**
 * El plan de crecimiento como ESTADO, no como texto en un mensaje.
 *
 * Un plan que vive sólo en la respuesta del agente se pierde en el scroll y no
 * se puede retomar: el turno siguiente vuelve a proponer cinco cosas desde
 * cero. Persistido, el agente puede decir "de los 5 pasos hiciste 2, seguimos
 * por el 3" y medir si la ocupación se movió desde que el plan arrancó.
 *
 * Un plan ACTIVO por espacio operativo. Proponer otro cierra el anterior.
 */

import { Schema, model, type InferSchemaType } from "mongoose";
import { PLAYBOOK_GOALS, EFFORTS } from "../playbooks/growthPlaybook.model";

export const STEP_STATUSES = [
  "sugerido",
  "aceptado",
  "ejecutado",
  "rechazado",
  "fallido",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PLAN_STATUSES = ["activo", "completado", "abandonado"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PRIORITIES = ["alta", "media", "baja"] as const;
export type Priority = (typeof PRIORITIES)[number];

const stepSchema = new Schema(
  {
    stepId: { type: String, required: true },
    /** `name` de la tool del catálogo (ver PlaybookLever.tool). */
    tool: { type: String, required: true },
    title: { type: String, required: true },
    reason: { type: String, default: "" },
    priority: { type: String, enum: PRIORITIES, default: "media" },
    effort: { type: String, enum: EFFORTS, default: "horas" },
    expectedImpact: { type: String, default: "" },
    suggestedArgs: { type: Schema.Types.Mixed, default: undefined },
    /** Path de la foto que este paso debería mover. */
    kpi: { type: String, default: null },
    /**
     * Nivel de confirmación que va a exigir al ejecutarse, calculado por el
     * CÓDIGO con `confirmationFor()` — no por el modelo. La tarjeta lo muestra
     * para que el usuario sepa de antemano qué le va a pedir.
     */
    confirmationLevel: { type: String, enum: ["none", "card", "typed"], default: "none" },
    status: { type: String, enum: STEP_STATUSES, default: "sugerido" },
    executedAt: { type: Date, default: null },
    /** Mensaje del chat donde se ejecutó, para poder volver al hilo. */
    messageId: { type: String, default: null },
    resultSummary: { type: String, default: null },
    errorCode: { type: String, default: null },
  },
  { _id: false },
);

const planSchema = new Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    companyId: { type: String, default: null, index: true },
    propertyId: { type: String, required: true, index: true },
    operativeSpaceId: { type: String, default: null, index: true },
    sessionId: { type: String, default: null },
    createdByUserId: { type: String, default: null },

    goal: { type: String, enum: PLAYBOOK_GOALS, required: true },
    horizonDays: { type: Number, default: 90 },
    diagnosis: { type: String, required: true },
    /** Las líneas de evidencia que el modelo citó de la foto. */
    evidence: { type: [String], default: [] },
    playbookIds: { type: [String], default: [] },
    steps: { type: [stepSchema], default: [] },

    /**
     * Valores de la foto al momento de crear el plan. Es contra esto que se
     * mide el avance en los turnos de seguimiento: sin baseline, "mejoró" es
     * una opinión.
     */
    kpiBaseline: { type: Schema.Types.Mixed, default: {} },
    snapshotTakenAt: { type: String, default: null },

    status: { type: String, enum: PLAN_STATUSES, default: "activo", index: true },
  },
  { timestamps: true, collection: "growth_plans" },
);

planSchema.index({ operativeSpaceId: 1, status: 1, updatedAt: -1 });
planSchema.index({ propertyId: 1, status: 1, updatedAt: -1 });

export type GrowthPlanDoc = InferSchemaType<typeof planSchema>;
export const GrowthPlan = model("GrowthPlan", planSchema);

export function sanitizePlan(doc: unknown): Record<string, unknown> {
  if (!doc || typeof doc !== "object") return {};
  const obj =
    "toObject" in (doc as Record<string, unknown>)
      ? (doc as { toObject: () => Record<string, unknown> }).toObject()
      : ({ ...(doc as Record<string, unknown>) } as Record<string, unknown>);
  delete obj._id;
  delete obj.__v;
  return obj;
}
