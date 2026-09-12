/**
 * `propose_growth_plan`: la tool interna con la que el agente entrega un plan.
 *
 * No pega a ningún microservicio. Recibe la propuesta del modelo, la valida
 * (plan.validate), la persiste y devuelve el plan normalizado como
 * `tool_result` — que es exactamente lo que la tarjeta del chat dibuja.
 *
 * Por qué una tool y no "que el modelo escriba el plan en prosa": porque un
 * plan en prosa no se puede validar contra permisos, no se puede ejecutar con
 * un click y no se puede medir después. La estructura no es burocracia, es lo
 * que convierte un consejo en algo que la plataforma puede hacer.
 *
 * OJO CON LOS SCHEMAS: toda propiedad `array` lleva `items`. Google devuelve
 * 400 al REQUEST COMPLETO si falta, y como las declaraciones viajan todas
 * juntas, una sola propiedad mal declarada tumba el turno entero — no la tool.
 */

import type { AnthropicTool } from "../../conversations/services/toolExecutor";
import { PLAYBOOK_GOALS, EFFORTS } from "../playbooks/growthPlaybook.model";
import { PRIORITIES } from "./growthPlan.model";
import {
  validatePlan,
  MAX_STEPS,
  MIN_EVIDENCE,
  MIN_STEPS,
  type RawPlanInput,
} from "./plan.validate";
import { createPlan, type PlanScope } from "./plan.service";
import type { LeverIndex } from "../playbooks/leverIndex";
import type { PropertySnapshot } from "../snapshot/snapshot.types";
import type { UserScope } from "../../../shared/agentAuth/userScope";

export const PROPOSE_GROWTH_PLAN = "propose_growth_plan";

export const PROPOSE_GROWTH_PLAN_TOOL: AnthropicTool = {
  name: PROPOSE_GROWTH_PLAN,
  description:
    "Entrega el plan de crecimiento como resultado estructurado: diagnóstico, evidencia y pasos concretos. " +
    "Usala UNA vez, al final del turno estratégico, cuando ya tengas el diagnóstico. " +
    "Cada paso nombra una herramienta del índice de palancas; el usuario las ejecuta desde la tarjeta. " +
    "No ejecuta nada por sí misma. La interfaz dibuja el plan, así que no repitas los pasos en el texto.",
  input_schema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        enum: [...PLAYBOOK_GOALS],
        description:
          "El objetivo dominante del plan. Uno solo: si el pedido toca varios, elegí el que destraba a los demás.",
      },
      horizonDays: {
        type: "number",
        // SIN `enum`. Un enum sobre una propiedad NUMÉRICA hace que Google
        // devuelva la llamada con TODOS los argumentos vacíos: no da 400, no
        // avisa, simplemente manda `{}` y el turno se cae en la validación con
        // "Falta el diagnóstico". Medido el 12-09-2026 aislando la tool contra
        // gemini-3.8-flash. El valor se acota en `validatePlan`, que es donde
        // corresponde. Ver `normalizeToolSchema`, que ahora los saca en la
        // frontera para todo el catálogo.
        description:
          "En cuántos días se espera ver el efecto del plan completo. Usá 30, 60 o 90.",
      },
      diagnosis: {
        type: "string",
        description:
          "Por qué este plan y no otro, en 2 frases como mucho. Calibrado al nivel de experiencia del usuario.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description:
          `Entre ${MIN_EVIDENCE} y 5 líneas, cada una citando un dato CONCRETO de la foto con su número ` +
          `(ej. "la ocupación de los próximos 30 días es 41%"). Sin números no se acepta el plan.`,
      },
      playbookIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Los ids de las estrategias aplicables que usaste. Sólo de las que te ofrecieron.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description:
                "Nombre exacto de la herramienta del índice de palancas (ej. create_promo).",
            },
            title: {
              type: "string",
              description: "Qué hay que hacer, en lenguaje del usuario. Sin jerga técnica.",
            },
            reason: {
              type: "string",
              description: "Por qué este paso, atado a un dato de la foto.",
            },
            priority: { type: "string", enum: [...PRIORITIES] },
            effort: {
              type: "string",
              enum: [...EFFORTS],
              description: "min = minutos, horas = una tarde, dias = varios días.",
            },
            expectedImpact: {
              type: "string",
              description: "Qué se espera que pase, en una línea. Sin prometer números que no podés saber.",
            },
            suggestedArgs: {
              type: "object",
              description:
                "Argumentos que ya podés inferir de la foto. Omitilos si hay que preguntarle al usuario.",
            },
            kpi: {
              type: "string",
              description:
                "Path del indicador que este paso debería mover (ej. demand.occ30, presence.visibilityScore).",
            },
          },
          required: ["tool", "title", "reason", "priority", "effort"],
        },
        description: `Entre ${MIN_STEPS} y ${MAX_STEPS} pasos, ordenados por lo que harías primero.`,
      },
    },
    required: ["goal", "diagnosis", "evidence", "steps"],
  },
};

/** Contexto que el runner le pasa al handler. Lo arma `strategicTurn.prepare`. */
export interface PlanToolContext {
  index: LeverIndex;
  snapshot: PropertySnapshot;
  scope: UserScope | null;
  offeredPlaybookIds: string[];
  planScope: PlanScope;
}

export interface PlanToolOutcome {
  /** Lo que ve el modelo como tool_result. */
  output: unknown;
  ok: boolean;
  /** Motivo del rechazo, para el log y la traza. */
  reason?: string;
  planId?: string;
  stepsProposed: number;
  stepsDropped: number;
}

/**
 * Ejecuta la tool: valida, persiste y devuelve el plan para la tarjeta.
 *
 * Si la validación rechaza, el `tool_result` explica exactamente qué corregir.
 * El runner deja una iteración más para eso; si vuelve a fallar, el turno cierra
 * en prosa con el diagnóstico, que sigue siendo útil — nunca con una tarjeta
 * vacía.
 */
export async function runProposeGrowthPlan(
  args: Record<string, unknown>,
  ctx: PlanToolContext,
): Promise<PlanToolOutcome> {
  if (process.env.GROWTH_DEBUG_ARGS) {
    console.log(`[growth/plan] args crudos: ${JSON.stringify(args).slice(0, 1500)}`);
  }
  const result = await validatePlan({
    raw: args as RawPlanInput,
    index: ctx.index,
    scope: ctx.scope,
    snapshot: ctx.snapshot,
    offeredPlaybookIds: ctx.offeredPlaybookIds,
    propertyId: ctx.planScope.propertyId,
    companyId: ctx.planScope.companyId,
  });

  if (!result.ok || !result.plan) {
    const why =
      (result.error ?? "El plan no pasó la validación.") +
      (result.dropped.length
        ? ` Descartados: ${result.dropped.map((d) => `${d.tool} (${d.reason})`).join("; ")}.`
        : "");
    // Al log del servidor Y al execMeta. Un "no pasó la validación" sin motivo
    // obliga a reproducir el turno entero para averiguar qué falló — y los
    // turnos con modelo cuestan plata y no son deterministas.
    console.warn(`[growth/plan] plan rechazado: ${why}`);
    return {
      ok: false,
      reason: why,
      output: {
        error: true,
        message: result.error ?? "El plan no pasó la validación.",
        // El modelo tiene que saber qué se cayó para no volver a proponerlo ni
        // mencionarlo como "pendiente de permisos".
        descartados: result.dropped,
      },
      stepsProposed: 0,
      stepsDropped: result.dropped.length,
    };
  }

  const plan = await createPlan({
    scope: ctx.planScope,
    goal: result.plan.goal,
    horizonDays: result.plan.horizonDays,
    diagnosis: result.plan.diagnosis,
    evidence: result.plan.evidence,
    playbookIds: result.plan.playbookIds,
    steps: result.plan.steps,
    kpiBaseline: result.plan.kpiBaseline,
    snapshotTakenAt: ctx.snapshot.takenAt,
  });

  return {
    ok: true,
    planId: plan.planId,
    stepsProposed: result.plan.steps.length,
    stepsDropped: result.dropped.length,
    output: {
      // `kind` es lo que el front usa para elegir el renderer de la tarjeta.
      kind: "growth_plan",
      planId: plan.planId,
      goal: plan.goal,
      horizonDays: plan.horizonDays,
      diagnosis: plan.diagnosis,
      evidence: plan.evidence,
      steps: result.plan.steps.map((s, i) => ({
        n: i + 1,
        stepId: s.stepId,
        tool: s.tool,
        title: s.title,
        reason: s.reason,
        priority: s.priority,
        effort: s.effort,
        expectedImpact: s.expectedImpact,
        confirmationLevel: s.confirmationLevel,
        status: s.status,
      })),
      // Se le dice al modelo, explícitamente, que ya está dibujado: sin esto
      // vuelve a listar los pasos en el texto y el usuario lee todo dos veces.
      nota:
        "El plan ya está dibujado como tarjeta en el chat. Cerrá con 1-2 frases: " +
        "por dónde empezar y qué vas a mirar para saber si funcionó. No repitas los pasos.",
      ...(result.dropped.length
        ? {
            descartados: result.dropped,
            notaDescartados:
              "Estos pasos no entraron (permisos o herramienta inválida). No los menciones.",
          }
        : {}),
    },
  };
}
