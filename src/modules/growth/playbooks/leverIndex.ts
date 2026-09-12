/**
 * Índice de palancas: el catálogo que el turno estratégico SÍ necesita.
 *
 * El problema que resuelve: un turno normal manda las 357 definiciones de tools
 * (~46k tokens) en cada iteración. Un turno estratégico no va a ejecutar casi
 * ninguna — va a REFERENCIARLAS en un plan. Una definición completa con su JSON
 * Schema cuesta ~130 tokens; una línea de índice cuesta ~40, y para nombrar un
 * paso del plan alcanza con la línea.
 *
 * Entonces el turno recibe dos cosas distintas:
 *
 *  - **tools ofrecidas** (`DRILLDOWN_TOOLS`): pocas, de lectura, con su schema
 *    completo, porque el modelo las va a LLAMAR para confirmar el diagnóstico.
 *  - **índice de palancas**: una línea por tool que el modelo puede NOMBRAR en
 *    un paso del plan. No se pueden llamar en este turno; se ejecutan después,
 *    desde la tarjeta, por el camino normal de `executeTool`.
 *
 * Todo pasa por los permisos del usuario ANTES de renderizarse: una palanca que
 * el usuario no puede ejecutar no aparece, así el plan no la propone y no hay
 * botón que falle.
 */

import { Tool } from "../../tools/tools.model";
import { checkToolCall } from "../../conversations/services/toolAccess";
import type { UserScope } from "../../../shared/agentAuth/userScope";
import type { Playbook } from "./growthPlaybook.model";

/**
 * Lecturas que el modelo puede llamar en un turno estratégico para confirmar el
 * diagnóstico. Son las que la foto NO cubre: la foto trae agregados, y a veces
 * hace falta el detalle (la curva de una fecha, la grilla del comp-set).
 *
 * Deliberadamente cortas. Cada tool ofrecida es schema completo en el prompt y
 * una invitación a gastar una iteración.
 */
export const DRILLDOWN_TOOLS = [
  "get_pace_curve",
  "get_pace_pickup",
  "get_compset_rates",
  "list_market_events",
  "get_promos",
  "get_rate_plans",
  "list_property_reviews",
  "get_linkhub_analytics",
  "get_availability_calendar",
] as const;

/**
 * Palancas de base: las que casi cualquier plan de crecimiento termina usando,
 * independientemente del playbook que haya aplicado. Van siempre para que el
 * modelo pueda armar un plan coherente aunque los playbooks cubran sólo parte
 * del diagnóstico.
 */
export const CORE_LEVERS = [
  // Canal directo
  "update_engine_settings",
  "create_rate_plan",
  "update_rate_plan",
  "create_promo",
  "toggle_promo",
  "set_day_restrictions",
  // Presencia
  "publish_site_changes",
  "update_site_seo_geo",
  "update_site_metadata",
  "publish_linkhub",
  "update_linkhub_meta",
  "update_gbp_profile",
  "publish_gbp_profile",
  "generate_gbp_description",
  "update_ota_profile",
  "generate_ota_description",
  "upsert_social_connection",
  "generate_social_assets",
  // Reputación
  "respond_review",
  "import_reviews",
  // Revenue
  "create_pricing_rule",
  "update_pricing_rule",
  "accept_rate_recommendation",
  "update_compset",
] as const;

export interface Lever {
  /** El `name`, que es lo que el modelo escribe en un paso del plan. */
  tool: string;
  toolId: string;
  displayName: string;
  description: string;
  /** Argumentos que el modelo debería completar (sin los que inyecta el runtime). */
  args: string[];
  /** Si es irreversible o borra, el plan lo tiene que decir al proponerlo. */
  irreversible: boolean;
  destructive: boolean;
}

export interface LeverIndex {
  levers: Lever[];
  /** Nombres permitidos, para validar los pasos de un plan sin re-consultar. */
  allowed: Set<string>;
  /** Palancas que el playbook pedía pero el usuario no puede ejecutar. */
  droppedByPolicy: string[];
}

/** Args que el runtime inyecta solo: no son del modelo y ensucian el índice. */
const IMPLICIT_ARGS = new Set(["propertyId", "companyId", "userId"]);

/**
 * Índice de palancas para este usuario y estos playbooks.
 *
 * El filtro de permisos es `checkToolCall` con args vacíos — la misma función
 * que corta en el turno real. Se evalúa sin argumentos a propósito: en este
 * punto el plan todavía no existe, y lo que se pregunta es "¿esta persona puede
 * usar esta herramienta acá?", no "¿puede hacer esta llamada concreta?". La
 * llamada concreta se vuelve a validar cuando el plan se valida y otra vez
 * cuando el paso se ejecuta.
 */
export async function buildLeverIndex(input: {
  playbooks: Playbook[];
  scope: UserScope | null;
  propertyId?: string;
  companyId?: string;
}): Promise<LeverIndex> {
  const wanted = new Set<string>(CORE_LEVERS);
  for (const p of input.playbooks) {
    for (const lever of p.levers) wanted.add(lever.tool);
  }

  const docs = await Tool.find({
    name: { $in: [...wanted] },
    status: "active",
  }).lean();

  const levers: Lever[] = [];
  const droppedByPolicy: string[] = [];

  for (const doc of docs) {
    if (input.scope) {
      const decision = checkToolCall(doc as never, {}, input.scope, {
        propertyId: input.propertyId,
        companyId: input.companyId,
      });
      if (!decision.allowed) {
        droppedByPolicy.push(doc.name);
        continue;
      }
    }
    const properties =
      (doc.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
    levers.push({
      tool: doc.name,
      toolId: doc.toolId,
      displayName: doc.displayName ?? doc.name,
      description: (doc.description ?? "").split(/(?<=\.)\s/)[0] ?? "",
      args: Object.keys(properties).filter((k) => !IMPLICIT_ARGS.has(k)),
      irreversible: doc.permissions?.irreversible === true,
      destructive: doc.permissions?.isDestructive === true,
    });
  }

  levers.sort((a, b) => a.tool.localeCompare(b.tool));

  return {
    levers,
    allowed: new Set(levers.map((l) => l.tool)),
    droppedByPolicy,
  };
}

/**
 * El índice como texto: una línea por palanca.
 *
 * Va en el prefijo ESTÁTICO del perfil estratégico: cambia sólo cuando se
 * publican playbooks nuevos o cuando cambia el perfil de permisos del usuario,
 * así que es seguro para caché entre turnos.
 */
export function renderLeverIndex(index: LeverIndex): string {
  if (index.levers.length === 0) return "";

  const lines = index.levers.map((l) => {
    const flags: string[] = [];
    if (l.irreversible) flags.push("IRREVERSIBLE");
    else if (l.destructive) flags.push("borra datos");
    const args = l.args.length > 0 ? ` · args: ${l.args.join(", ")}` : "";
    const flag = flags.length > 0 ? ` · ${flags.join(", ")}` : "";
    return `- \`${l.tool}\` — ${l.description}${args}${flag}`;
  });

  return [
    "## Índice de palancas (para los pasos del plan)",
    "Estas son las acciones que PODÉS proponer como pasos de un plan. No las podés",
    "ejecutar en este turno: el usuario las acepta desde la tarjeta y recién ahí corren,",
    "con su confirmación si la necesitan. Usá el nombre exacto en `tool` de cada paso.",
    "Si algo que querías proponer no está en esta lista, es porque este usuario no tiene",
    "permiso para hacerlo: no lo propongas ni lo menciones como pendiente.",
    "",
    ...lines,
  ].join("\n");
}
