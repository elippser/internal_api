/**
 * Perfil de turno: los parámetros del loop que dejan de ser constantes.
 *
 * Hasta acá el runner tenía UNA forma de correr un turno: cinco iteraciones,
 * todas las tools, sin `tool_choice`, y el mensaje "no pude terminar" cuando se
 * acababan las vueltas. Eso alcanzaba mientras todos los turnos fueran la misma
 * clase de turno.
 *
 * El turno estratégico no lo es: llega con la foto de la propiedad ya resuelta
 * en código, necesita menos vueltas, tiene que terminar SÍ o SÍ con un plan
 * estructurado, y no puede cerrar con "reformulá tu pedido" después de haber
 * gastado el turno entero leyendo.
 *
 * El perfil `default` reproduce el comportamiento anterior byte por byte: si
 * este archivo se borrara y el runner usara sus constantes, nada cambiaría para
 * los turnos normales. Eso es a propósito — un refactor que cambia lo que ya
 * funcionaba no es un refactor, es un riesgo.
 */

import type { AnthropicTool } from "./toolExecutor";

export type TurnProfileId = "default" | "estrategico" | "paso_de_plan" | "turistico";

/**
 * `tool_choice` del pedido. Se elige POR ITERACIÓN porque lo que el turno
 * necesita cambia: en la primera el modelo puede querer leer algo, en la
 * segunda ya tiene que entregar.
 *
 * `{type:"any"}` = obligatorio usar alguna tool. `{type:"tool"}` = esa tool.
 * `undefined` = el modelo decide (lo de siempre).
 */
export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | undefined;

export interface TurnProfile {
  id: TurnProfileId;
  /** Tope de vueltas del loop de tools. */
  maxIterations: number;
  /**
   * Al agotar las iteraciones, hacer una pasada final SIN tools para que el
   * modelo cierre con lo que juntó, en vez de tirar el trabajo.
   *
   * Es la corrección más barata de todo el rediseño: hoy un turno que llega al
   * tope devuelve "Estoy procesando varias cosas a la vez y no pude terminar"
   * y DESCARTA todo lo leído. El usuario ve un turno de 40 segundos que no
   * contesta nada, y el trabajo ya estaba pago.
   */
  finalizeWithoutTools: boolean;
  /** Presupuesto de razonamiento. undefined = como estaba (sin bloque). */
  thinkingBudget?: number;
  /** `tool_choice` por número de iteración (0-based). */
  toolChoiceFor?: (iteration: number, state: TurnState) => ToolChoice;
  /** Tools internas extra que este perfil ofrece (además de las de siempre). */
  internalTools?: AnthropicTool[];
}

/** Lo que el loop sabe de sí mismo cuando tiene que decidir el `tool_choice`. */
export interface TurnState {
  /** Nombres de tools ya ejecutadas en este turno. */
  used: string[];
}

export const DEFAULT_MAX_ITERATIONS = Number(
  process.env.MAX_TOOL_ITERATIONS ?? 5,
);

/**
 * El perfil de siempre.
 *
 * `finalizeWithoutTools` arranca en true incluso acá: el cierre digno no es una
 * necesidad del turno estratégico, es un arreglo que a todos les sirve. Se
 * puede apagar con `TURN_FINALIZE_WITHOUT_TOOLS=false` si alguna vez molesta.
 */
export function defaultProfile(): TurnProfile {
  return {
    id: "default",
    maxIterations: DEFAULT_MAX_ITERATIONS,
    finalizeWithoutTools:
      (process.env.TURN_FINALIZE_WITHOUT_TOOLS ?? "true").toLowerCase() !== "false",
  };
}
