/**
 * El turno del estado turístico.
 *
 * Tres modos, según lo que decidió el router:
 *
 *  - profile   — la pregunta es SÓLO contexto turístico ("¿hay algo grande
 *                cerca este finde?"). Perfil propio: una vuelta, sin tools, sin
 *                web, tier barato. El código arma la tarjeta y el modelo escribe
 *                dos a cuatro líneas. Es el caso más frecuente y el más barato.
 *  - enriched  — la pregunta mezcla contexto con análisis u operación ("¿cómo
 *                aprovecho el finde largo en mis tarifas?"). El turno normal
 *                sigue con sus tools; el dossier entra precargado al prompt.
 *  - strategic — un objetivo abierto ("quiero más reservas"). El dossier es un
 *                insumo más de la foto del turno estratégico, con presupuesto
 *                corto para no demorar el plan.
 *
 * En los tres, la tarjeta sale del código y se emite antes de que el modelo
 * empiece a escribir. El modelo nunca redacta un número de la tarjeta.
 */

import type { ExperienceLevel } from "../../shared/agentAuth/userScope";
import type { TurnProfile } from "../conversations/services/turnProfile";
import { modelFor } from "../../shared/llm/provider";
import { buildCard } from "./card";
import { getDossier, type DossierDeps } from "./dossier.service";
import { buildHeader, loadPropertyDoc } from "./location";
import { mentionedOtherPlace } from "./otherPlace";
import { renderTourismBlock } from "./render";
import {
  hubsForFacets,
  type TourismCardPayload,
  type TourismFacet,
  type TourismHub,
} from "./tourism.types";

/** Nombre del bloque de la tarjeta en `agentMeta.toolsExecuted` y en el front. */
export const TOURISM_STATUS_BLOCK = "estado_turistico";
export const TOURISM_STEP_LABEL = "Leyendo el estado turístico de la zona…";

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Lo que el perfil turístico espera a las fuentes antes de contestar. */
export const TOURISM_PREP_BUDGET_MS = envNum("TOURISM_PREP_BUDGET_MS", 6000);
/** Dentro del turno estratégico: el mismo techo que cada fuente de la foto. */
export const TOURISM_STRATEGIC_BUDGET_MS = envNum("TOURISM_STRATEGIC_BUDGET_MS", 2500);
export const STRATEGIC_TOURISM_FACETS: TourismFacet[] = ["movimiento", "estacionalidad"];

export type TourismMode = "profile" | "enriched" | "strategic" | "tool";

export interface TourismTurnMeta {
  mode: TourismMode;
  facets: TourismFacet[];
  prepMs: number;
  missing: string[];
  /** Hubs que no estaban en el dossier y hubo que leer (o quedaron leyéndose). */
  hubsCold: TourismHub[];
  locationSource: string;
  cardShown: boolean;
  otherPlace: string | null;
  failure: string | null;
}

export interface TourismTurnContext {
  mode: TourismMode;
  facets: TourismFacet[];
  card: TourismCardPayload | null;
  /** Bloque para el prompt (vacío si no hubo dossier). */
  block: string;
  /** Mensaje para el usuario cuando la propiedad no se pudo ubicar. */
  failureMessage: string | null;
  meta: TourismTurnMeta;
}

export interface PrepareTourismInput {
  propertyId: string;
  facets: TourismFacet[];
  mode: Exclude<TourismMode, "tool">;
  message: string;
  level: ExperienceLevel;
  budgetMs: number;
  deps?: DossierDeps;
}

export async function prepareTourismContext(input: PrepareTourismInput): Promise<TourismTurnContext> {
  const t0 = Date.now();
  const facets = input.facets.length ? input.facets : ["movimiento" as TourismFacet];
  const meta = (over: Partial<TourismTurnMeta>): TourismTurnMeta => ({
    mode: input.mode,
    facets,
    prepMs: Date.now() - t0,
    missing: [],
    hubsCold: [],
    locationSource: "",
    cardShown: false,
    otherPlace: null,
    failure: null,
    ...over,
  });

  // Otro lugar: sólo en el perfil puro. En los otros modos el turno sigue su
  // camino y el dossier es contexto, no la respuesta.
  if (input.mode === "profile") {
    const load = input.deps?.loadProperty ?? loadPropertyDoc;
    const doc = await load(input.propertyId).catch(() => null);
    const other = doc ? mentionedOtherPlace(input.message, buildHeader(doc)) : null;
    if (other) {
      return { mode: input.mode, facets, card: null, block: "", failureMessage: null, meta: meta({ otherPlace: other }) };
    }
  }

  const result = await getDossier(
    { propertyId: input.propertyId, hubs: hubsForFacets(facets), budgetMs: input.budgetMs },
    input.deps,
  );
  if (!result.ok) {
    return {
      mode: input.mode,
      facets,
      card: null,
      block: "",
      failureMessage: result.message,
      meta: meta({ failure: result.reason }),
    };
  }

  const d = result.dossier;
  const card = buildCard(d, facets);
  // Sólo en el perfil turístico la tarjeta ES la respuesta y lleva la síntesis
  // adentro; en los otros modos acompaña un texto largo y va arriba de él.
  if (input.mode === "profile") card.layout = "lead";
  const shown = card.metrics.length > 0 || card.alert !== null;
  return {
    mode: input.mode,
    facets,
    card: shown ? card : null,
    block: renderTourismBlock(d, facets, { level: input.level }),
    failureMessage: null,
    meta: meta({
      missing: card.missing,
      hubsCold: [...d.meta.computed, ...d.meta.pending],
      locationSource: d.location.source,
      cardShown: shown,
    }),
  };
}

// ── Perfil ───────────────────────────────────────────────────────────────────

/**
 * Una sola vuelta y ninguna tool: todo lo que el modelo necesita ya está en el
 * prompt. Sin tools el pedido no lleva definiciones, que en un turno normal son
 * ~46.000 tokens.
 */
export function tourismProfile(): TurnProfile {
  return { id: "turistico", maxIterations: 1, finalizeWithoutTools: false };
}

/** Interpretar dos a cuatro líneas no necesita el tier caro. */
export function tourismModel(): string {
  return process.env.LLM_MODEL_TOURISM ?? modelFor("cheap");
}

/** Se suma al bloque cuando el dossier entra a un turno que no es el turístico. */
export const TOURISM_ENRICH_NOTE =
  "El estado turístico de arriba son datos reales del sistema y su tarjeta ya está en pantalla, arriba de tu respuesta. " +
  "Toda afirmación sobre la zona (tendencias, demanda, eventos, perfil o comportamiento del turista, ranking de la ciudad) " +
  "tiene que salir de ese bloque. Lo que no está ahí, el sistema no lo tiene: decilo así, y no lo completes con " +
  "conocimiento general ni lo presentes como tendencia. No lo busques en la web ni repitas sus cifras.";

const LEVEL_NOTE: Record<ExperienceLevel, string> = {
  sin_experiencia:
    "El usuario nunca operó un alojamiento: palabras comunes, y si usás un término (fin de semana largo, receso escolar), explicalo en media línea.",
  basico: "El usuario opera hace poco: podés hablar de ocupación y temporada, explicá cualquier otro término la primera vez.",
  intermedio: "El usuario maneja el negocio: directo a qué significa para su alojamiento.",
  avanzado: "El usuario es experto: sin definiciones, directo a la lectura y a la oportunidad.",
};

export function tourismSpecialization(ctx: TourismTurnContext, level: ExperienceLevel): string {
  const lines = ["## Modo: Estado turístico"];

  if (ctx.meta.otherPlace) {
    lines.push(
      `El usuario preguntó por "${ctx.meta.otherPlace}", que no es la zona de su propiedad. Los datos del sistema son de la zona`,
      "de la propiedad, así que no tenés datos verificados de ese lugar. No inventes: en una o dos líneas aclarale que lo que",
      "tenés es de su zona y preguntale si quiere eso, o si necesita algo puntual de ese lugar (en ese caso, en el próximo",
      "mensaje se puede buscar en la web, aclarando que no es un dato verificado por el sistema).",
    );
    return lines.join("\n");
  }

  if (ctx.meta.failure) {
    lines.push(
      ctx.meta.failure === "no_location"
        ? "No se pudo ubicar la propiedad en el mapa: no tiene coordenadas cargadas y la dirección no alcanzó. Decile en una o dos " +
            "líneas que para ver el movimiento, los eventos y el entorno de su zona necesita cargar la ubicación de la propiedad " +
            "(coordenadas o una dirección completa) en la configuración de la propiedad. No inventes datos de la zona."
        : "No se pudo leer el estado turístico en este momento. Decilo en una línea y proponé volver a preguntar en un rato. " +
            "No inventes datos de la zona ni contestes con conocimiento general.",
    );
    return lines.join("\n");
  }

  lines.push(
    "El usuario preguntó por el contexto turístico de su zona. Las cifras principales YA están en una tarjeta en pantalla,",
    "justo encima de tu texto. Tu trabajo es INTERPRETARLAS para este alojamiento (su tipo y su ubicación) y para lo que preguntó.",
    "- Dos a cuatro líneas, sin títulos ni listas. No repitas las cifras de la tarjeta ni las redondees distinto: decí qué significan.",
    "- Si hace falta más detalle, cerrá con: \"En 'Ver más de mi estatus turístico' tenés el detalle.\"",
    "- Lo marcado [estimado] es una referencia general de tablas curadas, no un dato en vivo: si lo usás, decilo en lenguaje llano.",
    "- Lo que figura en \"Sin datos\" no lo tenés: decilo en media línea. Nunca lo completes con conocimiento general ni lo des por cero.",
    "- Si la pregunta apunta a vender más (tarifas, promos, ocupación), cerrá con UNA línea ofreciendo armar un plan para aprovecharlo.",
  );
  if (!ctx.card) {
    lines.push("- Esta vez no hubo cifras suficientes para la tarjeta: contá lo que sí hay en el bloque y qué falta, sin inventar.");
  }
  lines.push(LEVEL_NOTE[level]);
  return lines.join("\n");
}
