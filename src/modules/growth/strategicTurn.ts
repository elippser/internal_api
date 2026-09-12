/**
 * Armado del turno estratégico.
 *
 * Acá se paga, en código y en paralelo, todo lo que antes el modelo descubría a
 * fuerza de llamar tools de a una: la foto de la propiedad, qué estrategias
 * aplican, qué palancas tiene permitidas el usuario y en qué anda el plan
 * anterior. El modelo recibe todo eso resuelto y le queda lo único que sabe
 * hacer mejor que el código: diagnosticar, elegir y explicar.
 *
 * Presupuesto del turno: ~24k tokens de entrada contra los 200k-320k que gasta
 * hoy un turno `analista` con las 357 definiciones de tools por iteración. Esa
 * diferencia es lo que permite usar un modelo mejor sin que el turno salga más
 * caro que el que hoy contesta mal.
 */

import type { UserScope, ExperienceLevel } from "../../shared/agentAuth/userScope";
import type { AnthropicTool } from "../conversations/services/toolExecutor";
import type { TurnProfile, ToolChoice } from "../conversations/services/turnProfile";
import {
  buildPropertySnapshot,
  renderSnapshotBlock,
} from "./snapshot/snapshot.service";
import { flattenSnapshot } from "./snapshot/indicators";
import type { PropertySnapshot } from "./snapshot/snapshot.types";
import { loadActivePlaybooks } from "./playbooks/growthPlaybook.model";
import {
  renderPlaybooksBlock,
  resolveApplicablePlaybooks,
  type PlaybookMatch,
} from "./playbooks/resolver";
import {
  buildLeverIndex,
  renderLeverIndex,
  DRILLDOWN_TOOLS,
  type LeverIndex,
} from "./playbooks/leverIndex";
import {
  PROPOSE_GROWTH_PLAN,
  PROPOSE_GROWTH_PLAN_TOOL,
  type PlanToolContext,
} from "./plan/planTool";
import {
  computeKpiDeltas,
  getActivePlan,
  renderActivePlanBlock,
} from "./plan/plan.service";
import { Tool } from "../tools/tools.model";

/** Razonamiento del turno estratégico: es la parte que justifica el tier caro. */
const THINKING_BUDGET = Number(process.env.GROWTH_THINKING_BUDGET ?? 4096);

/** Modelo del turno estratégico. Por defecto, el tier de análisis. */
export function strategicModel(fallback: string): string {
  return process.env.LLM_MODEL_STRATEGIC ?? fallback;
}

export interface StrategicTurnInput {
  propertyId: string;
  companyId?: string;
  operativeSpaceId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  scope: UserScope | null;
  /** Tools que el usuario tiene permitidas (ya filtradas por el service). */
  allowedToolIds: string[];
  /** Modelo que eligió el router; se usa como piso si no hay tier propio. */
  routedModel: string;
}

export interface StrategicTurnPlan {
  profile: TurnProfile;
  /** Se concatena al bloque DINÁMICO del prompt (foto, playbooks, plan activo). */
  dynamicBlock: string;
  /** Se concatena al bloque ESTÁTICO (índice de palancas: estable, cacheable). */
  staticBlock: string;
  /** Reemplaza la especialización del sub-agente para este turno. */
  specialization: string;
  /** Tools de lectura ofrecidas (pocas, para drill-down). */
  toolIds: string[];
  planContext: PlanToolContext;
  model: string;
  meta: {
    snapshotMs: number;
    missing: string[];
    playbookIds: string[];
    leverCount: number;
  };
}

/**
 * Prepara el turno. Devuelve `null` si no se pudo armar la foto — en ese caso
 * el service sigue con el turno normal, que contestará peor pero contestará.
 */
export async function prepareStrategicTurn(
  input: StrategicTurnInput,
): Promise<StrategicTurnPlan | null> {
  const t0 = Date.now();

  const snapshot = await buildPropertySnapshot({
    propertyId: input.propertyId,
    companyId: input.companyId,
    userId: input.userId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    // Fresco: si hay un plan activo, el avance se mide contra el baseline y una
    // foto cacheada de hace diez minutos mostraría un progreso que no es.
    fresh: true,
  });
  if (!snapshot) return null;

  const flat = flattenSnapshot(snapshot);
  const level: ExperienceLevel = input.scope?.experienceLevel ?? "basico";

  const [allPlaybooks, activePlan] = await Promise.all([
    loadActivePlaybooks(),
    getActivePlan({
      operativeSpaceId: input.operativeSpaceId,
      propertyId: input.propertyId,
    }),
  ]);
  const matches = resolveApplicablePlaybooks(allPlaybooks, flat);

  const index = await buildLeverIndex({
    playbooks: matches.map((m) => m.playbook),
    scope: input.scope,
    propertyId: input.propertyId,
    companyId: input.companyId,
  });

  // Drill-downs: sólo los que existen, están activos y el usuario tiene.
  const allowed = new Set(input.allowedToolIds);
  const drilldownDocs = await Tool.find(
    { name: { $in: [...DRILLDOWN_TOOLS] }, status: "active" },
    { toolId: 1, name: 1 },
  ).lean();
  const toolIds = drilldownDocs
    .map((d) => d.toolId)
    .filter((id) => allowed.size === 0 || allowed.has(id));

  const dynamicParts = [
    renderSnapshotBlock(snapshot, level),
    renderPlaybooksBlock(matches),
    renderExperienceBlock(level),
  ];

  if (activePlan) {
    const deltas = computeKpiDeltas(activePlan, snapshot);
    dynamicParts.push(renderActivePlanBlock(activePlan, deltas));
  }

  const planContext: PlanToolContext = {
    index,
    snapshot,
    scope: input.scope,
    offeredPlaybookIds: matches.map((m) => m.playbook.playbookId),
    planScope: {
      companyId: input.companyId,
      propertyId: input.propertyId,
      operativeSpaceId: input.operativeSpaceId,
      sessionId: input.sessionId,
      userId: input.userId,
    },
  };

  return {
    profile: buildProfile([PROPOSE_GROWTH_PLAN_TOOL]),
    dynamicBlock: dynamicParts.filter(Boolean).join("\n\n---\n\n"),
    staticBlock: renderLeverIndex(index),
    specialization: specializationFor(level, matches, snapshot, !!activePlan),
    toolIds,
    planContext,
    model: strategicModel(input.routedModel),
    meta: {
      snapshotMs: Date.now() - t0,
      missing: snapshot.missing,
      playbookIds: matches.map((m) => m.playbook.playbookId),
      leverCount: index.levers.length,
    },
  };
}

// ── Perfil del turno ─────────────────────────────────────────────────────────

const MAX_ITERATIONS = Number(process.env.GROWTH_MAX_ITERATIONS ?? 4);

/**
 * Cuatro iteraciones, no cinco: con la foto resuelta el modelo no tiene que
 * descubrir nada. Alcanza para diagnosticar, confirmar un detalle si hace
 * falta, entregar el plan y cerrar.
 *
 * SOBRE EL `tool_choice`, que costó un turno real entender: la primera versión
 * forzaba `{type:"any"}` en la iteración 0 para que el modelo no contestara con
 * tres párrafos de consejos. El efecto fue el contrario y peor — obligado a
 * llamar algo ANTES de haber pensado, el modelo emitió
 * `propose_growth_plan` con los argumentos vacíos, la validación lo rechazó
 * ("Falta el diagnóstico") y el turno se fue por la ventana de reintentos.
 *
 * Forzar una herramienta no hace que el modelo piense: hace que conteste antes
 * de pensar. Así que la primera vuelta es libre (el prompt ya le dice qué tiene
 * que entregar) y el `tool_choice` forzado queda como RED al final, cuando ya
 * razonó y sólo falta que lo estructure.
 */
function buildProfile(internalTools: AnthropicTool[]): TurnProfile {
  return {
    id: "estrategico",
    maxIterations: MAX_ITERATIONS,
    finalizeWithoutTools: true,
    thinkingBudget: THINKING_BUDGET,
    internalTools,
    toolChoiceFor: (iteration, state): ToolChoice => {
      // Ya entregó el plan: que cierre en prosa, sin tools.
      if (state.used.includes(PROPOSE_GROWTH_PLAN)) return undefined;
      // Última vuelta útil sin plan: ahora sí, el plan o nada.
      if (iteration >= MAX_ITERATIONS - 2) {
        return { type: "tool", name: PROPOSE_GROWTH_PLAN };
      }
      return undefined;
    },
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const LEVEL_GUIDANCE: Record<ExperienceLevel, string> = {
  sin_experiencia:
    "El usuario NUNCA operó un alojamiento. No des por sabido nada: explicá cada término técnico " +
    "la primera vez que lo uses, en media línea y con palabras comunes. Máximo 4 pasos, y el primero " +
    "tiene que ser de esfuerzo 'min' para que arranque con una victoria.",
  basico:
    "El usuario opera hace poco. Conoce la operación diaria pero no el vocabulario comercial: " +
    "podés hablar de ocupación y tarifas, pero explicá pace, ADR o comp-set la primera vez.",
  intermedio:
    "El usuario maneja el negocio. Podés usar el vocabulario comercial sin explicarlo. " +
    "Enfocate en el porqué de cada palanca, no en definiciones.",
  avanzado:
    "El usuario es experto. Directo al análisis: números, causa y recomendación. " +
    "Explicarle qué es el RevPAR le hace perder el tiempo y te resta credibilidad.",
};

function renderExperienceBlock(level: ExperienceLevel): string {
  return [
    "## Nivel del usuario",
    `Experiencia en hotelería: **${level.replace("_", " ")}**.`,
    LEVEL_GUIDANCE[level],
  ].join("\n");
}

function specializationFor(
  level: ExperienceLevel,
  matches: PlaybookMatch[],
  snapshot: PropertySnapshot,
  hasActivePlan: boolean,
): string {
  const lines = [
    "## Modo: Planificación estratégica",
    "El usuario planteó un objetivo de negocio abierto. No es una consulta ni una operación:",
    "tenés que diagnosticar con los datos que ya tenés arriba y entregar un PLAN ejecutable.",
    "",
    "La foto de la propiedad ya está resuelta arriba: son datos REALES, leídos hace segundos.",
    "No vuelvas a pedirlos con herramientas. Usá una lectura sólo si te falta un detalle puntual",
    "que la foto no trae y que cambia el diagnóstico — nunca 'para confirmar'.",
    "",
    "Estructura de tu respuesta, en este orden:",
    "1. DIAGNÓSTICO en 2 frases como mucho, con 2 o 3 números concretos de la foto.",
    "   Nada de 'depende' ni de generalidades: decí qué está frenando el negocio y por qué.",
    "2. El PLAN con `propose_growth_plan`. La interfaz lo dibuja como tarjeta.",
    "3. CIERRE en 1 o 2 frases: por dónde empezar y qué número vas a mirar para saber si funcionó.",
    "",
    "Reglas que no se negocian:",
    "- Cada línea de `evidence` cita un dato de la foto CON su número. Sin números, el plan se rechaza.",
    "- Los pasos usan SÓLO nombres del índice de palancas. Si algo no está ahí, el usuario no tiene",
    "  permiso: no lo propongas ni lo menciones como pendiente.",
    "- No repitas los pasos en el texto: ya están en la tarjeta y el usuario los lee dos veces.",
    "- No prometas números que no podés saber ('vas a subir 20% la ocupación'). Decí qué esperás",
    "  que mejore y por qué.",
  ];

  if (snapshot.missing.length > 0) {
    lines.push(
      "- Hay bloques de la foto sin datos. No afirmes nada sobre esos temas y, si son relevantes",
      "  para el objetivo, decilo en una línea del cierre.",
    );
  }
  if (matches.length === 0) {
    lines.push(
      "- Ninguna estrategia del catálogo aplicó. Diagnosticá desde la foto y proponé pasos del",
      "  índice de palancas, pero no inventes una estrategia con nombre propio.",
    );
  }
  if (hasActivePlan) {
    lines.push(
      "",
      "YA HAY UN PLAN ACTIVO (está arriba). Si el objetivo del usuario es el MISMO, no propongas",
      "uno nuevo: reportá el avance con los números que se movieron y ofrecé seguir por los pasos",
      "pendientes. Sólo armá un plan nuevo si el objetivo cambió de verdad.",
    );
  }

  lines.push("", LEVEL_GUIDANCE[level]);
  return lines.join("\n");
}

export type { LeverIndex };
