/**
 * `consultar_estado_turistico`: la tool interna para los turnos normales.
 *
 * Cuando el router no detectó una pregunta turística pero la charla lo
 * necesita ("bloqueá el próximo finde largo" y el modelo no sabe cuál es), el
 * modelo la llama en vez de buscar en la web. Mismo servicio y misma tarjeta
 * que el perfil turístico: nada se implementa dos veces.
 *
 * Como `propose_growth_plan`, el resultado que ve el modelo (`output`, un
 * bloque de texto) y el que persiste y dibuja la tarjeta (`card`) son
 * distintos a propósito.
 */

import type { ExperienceLevel } from "../../shared/agentAuth/userScope";
import type { AnthropicTool } from "../conversations/services/toolExecutor";
import { buildCard } from "./card";
import { getDossier } from "./dossier.service";
import { renderTourismBlock } from "./render";
import {
  TOURISM_FACETS,
  hubsForFacets,
  isTourismFacet,
  type TourismCardPayload,
  type TourismFacet,
} from "./tourism.types";

export const CONSULTAR_ESTADO_TURISTICO = "consultar_estado_turistico";

/** Un turno normal ya está pagando su propia latencia: un poco más de aire. */
const TOOL_BUDGET_MS = Number(process.env.TOURISM_TOOL_BUDGET_MS ?? 8000);

export const CONSULTAR_ESTADO_TURISTICO_TOOL: AnthropicTool = {
  name: CONSULTAR_ESTADO_TURISTICO,
  description:
    "Estado turístico REAL de la zona de la propiedad activa, leído de las fuentes del sistema: eventos cercanos " +
    "(cultura, deportes, congresos), interés online en el destino, feriados y fines de semana largos, recesos escolares, " +
    "temporada climática y entorno a pie. Usala en vez de buscar en la web cuando la conversación necesite ese contexto " +
    "(por ejemplo, para saber cuál es el próximo fin de semana largo). Devuelve un resumen y muestra una tarjeta con las cifras.",
  input_schema: {
    type: "object",
    properties: {
      facetas: {
        type: "array",
        // Enum de STRINGS: uno numérico vacía los argumentos de toda la tool
        // (trampa 9 de la migración a OpenRouter).
        items: { type: "string", enum: [...TOURISM_FACETS] },
        description:
          "Qué mirar, una o dos: movimiento (demanda de la zona), eventos, entorno (a pie) o estacionalidad (feriados, temporada, clima). Por defecto: movimiento.",
      },
    },
    required: [],
  },
};

export interface TourismToolContext {
  propertyId: string;
  level: ExperienceLevel;
}

export interface TourismToolOutcome {
  ok: boolean;
  output: unknown;
  card: TourismCardPayload | null;
  facets: TourismFacet[];
  reason?: string;
}

export async function runTourismTool(
  args: Record<string, unknown>,
  ctx: TourismToolContext,
): Promise<TourismToolOutcome> {
  const requested = Array.isArray(args.facetas) ? args.facetas.filter(isTourismFacet) : [];
  const facets: TourismFacet[] = requested.length ? [...new Set(requested)].slice(0, 2) : ["movimiento"];

  const result = await getDossier({
    propertyId: ctx.propertyId,
    hubs: hubsForFacets(facets),
    budgetMs: TOOL_BUDGET_MS,
  });
  if (!result.ok) {
    return { ok: false, output: { error: true, message: result.message }, card: null, facets, reason: result.reason };
  }

  const card = buildCard(result.dossier, facets);
  return {
    ok: true,
    output: {
      estado_turistico: renderTourismBlock(result.dossier, facets, { level: ctx.level }),
      nota:
        "La tarjeta con estas cifras ya se muestra en pantalla: interpretalas, no las repitas. Toda afirmación sobre la " +
        "zona (tendencias, demanda, perfil del turista, ranking de la ciudad) tiene que salir de este bloque; lo que no " +
        "está, el sistema no lo tiene: decilo así y no lo completes con conocimiento general.",
    },
    card,
    facets,
  };
}
