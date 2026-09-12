// Router de tareas de roombir-IA.
//
// Decide, por turno y dentro del mismo chat, a que sub-agente delegar (ver
// subAgents.ts). Estrategia en dos pasos, barata y robusta:
//   1) Heuristicas (regex, costo cero): resuelven los casos obvios — saludos,
//      pedidos claros de escritura, pedidos claros de analisis.
//   2) Clasificador LLM (tier barato, salida de 1 palabra): solo para los casos
//      ambiguos que la heuristica no cierra. Si falla, caemos al default.
//
// Sesgo de diseno: ante la duda NUNCA elegimos el tier mas debil. El default y
// el fallback son "operativo" (tier estandar, todas las tools). El sub-agente
// "consulta" (tier barato, solo-lectura) se elige solo cuando hay confianza de que la
// tarea es trivial / de solo-lectura.

import {
  getLlmClient,
  modelFor,
  thinkingBlockFor,
  withReasoningHeadroom,
} from "../../../shared/llm/provider";
import { filterReadOnlyToolIds } from "./toolExecutor";
import {
  SUB_AGENTS,
  DEFAULT_SUB_AGENT,
  TIER_TO_SUB_AGENT,
  type SubAgentId,
  type SubAgentProfile,
  type SubAgentTier,
} from "./subAgents";

const ROUTER_MODEL = process.env.ROUTER_MODEL ?? modelFor("cheap");
// Permite desactivar el clasificador LLM y operar solo con heuristicas+default.
//
// Se lee en cada llamada y no al cargar el modulo: leido al importar, el env
// queda congelado antes de que cualquier test pueda tocarlo, asi que las
// pruebas de la heuristica terminaban pagando el clasificador (o, sin API key,
// cayendo al default y midiendo otra cosa). El costo de leer un env por turno
// es cero al lado de eso.
function routerLlmEnabled(): boolean {
  return (process.env.ROUTER_LLM_CLASSIFIER ?? "true").toLowerCase() !== "false";
}

export interface RouteDecision {
  subAgent: SubAgentProfile;
  /** Tools efectivas del turno (acotadas si el sub-agente es de solo-lectura). */
  toolIds: string[];
  /** Como se decidio (telemetria/log). */
  reason: string;
  /**
   * Objetivo de negocio abierto: el turno se arma con el perfil estrategico
   * (foto de la propiedad + playbooks + plan) en vez del loop de tools normal.
   */
  strategicRequest: boolean;
  /** Numero de paso de un plan que el usuario nombro ("hace el paso 2"). */
  planStepNumber: number | null;
}

// ── Heuristicas ──────────────────────────────────────────────────────────────

// Mensaje puramente social / de cortesia (sin pedido real).
const TRIVIAL =
  /^(\s*(hola|holaa+|buenas|buen d[ií]a|buenas tardes|buenas noches|gracias|muchas gracias|ok|oka|dale|listo|perfecto|genial|barbaro|s[ií]|no|chau|adios|saludos)\b[\s!.,¡¿?]*)+$/i;

// Intencion clara de ESCRIBIR/OPERAR (crear, cancelar, check-in/out, etc.).
const WRITE_INTENT =
  /\b(crea(r|me|)|cancel(a|ar|á|me)|confirm(a|ar|á|o)|check[ -]?in|check[ -]?out|modific|edit(a|ar|á)|elimin|borr(a|ar|á)|asign|reasign|actualiz|bloque(a|ar|á)|desbloque|dar de (baja|alta)|registr(a|ar|á)|gener(a|ar|á) (la|una) reserva|pon[eé]r? en (limpieza|mantenimiento)|public(a|ar|á|ame)|despublic|sincroniz|duplic(a|ar|á)|mov(e|er|é|eme|amos) (la|una|esa|esta) reserva|cerr(a|ar|á) (la )?(venta|fecha)|agreg(a|ar|á|ame)|quit(a|ar|á|ame)|sub(i|ir|í|ime) (la|una|esta|esa) (imagen|foto|logo))\w*/i;

// Intencion clara de ANALISIS / razonamiento multi-paso.
const DEEP_INTENT =
  /\b(analiz|comparativa|compar(a|ar|á)|optimiz|recomend|sugerenci|mejor (opci|tarifa|estrategia)|por qu[eé]|estrateg|proyect|tendenci|pron[oó]stic|forecast|evalu(a|ar|á)|diagnostic|auditor|rentabilidad|ocupaci[oó]n hist|paso a paso|varios pasos|m[uú]ltiples)\w*/i;

// Jerga de REVENUE (rms-app). Va al tier deep aunque el pedido parezca simple:
// leer un pace_index o una grilla de comp-set sin sacar conclusion no le sirve a
// nadie, y decidir sobre tarifas con el tier mas barato es la forma cara de
// ahorrar. `analista` tiene toolScope "all", asi que tambien puede ejecutar los
// writes de revenue (aceptar recomendaciones, crear reglas) sin re-enrutar.
// Deliberadamente NO incluye "tarifa" ni "ocupacion" sueltas: son palabras de
// uso diario en el PMS y mandarian consultas triviales al tier caro.
const REVENUE_INTENT =
  /\b(revenue|revpar|rev\s?par|\badr\b|pick[\s-]?up|booking\s*pace|\bpace\b|pace[\s_-]?index|comp[\s-]?set|compset|competidor\w*|competencia|pricing|yield|benchmark|rms|tarifa[s]?\s+(sugerid|recomendad)\w*|recomendaci\w*\s+de\s+tarifa|regla[s]?\s+de\s+(pricing|tarifa)|ventana\s+de\s+reserva|booking\s*window|guardrail\w*|paridad\s+tarifaria)\b/i;

// ── Pedido ESTRATEGICO ──────────────────────────────────────────────────────
//
// "Quiero aumentar mis reservas", "no se por donde arrancar", "como hago para
// llenar el hotel en temporada baja". Un objetivo de negocio ABIERTO, sin una
// accion concreta ni una entidad identificada.
//
// Es el pedido que peor contestaba el agente: sin estructura devolvia consejos
// genericos elegidos sin mirar los datos del hotel. Ahora dispara el turno
// estrategico (foto de la propiedad + playbooks + plan), que es otro perfil de
// turno, no otro runtime.
const STRATEGIC_INTENT =
  /\b(quiero|quisiera|necesito|me gustaria|c[oó]mo\s+(hago|puedo|logro|consigo|mejoro|aumento)|qu[eé]\s+(puedo|podr[ií]a)\s+hacer|ayud[aá](me|nos)?|no\s+s[eé]\s+(por\s+d[oó]nde|c[oó]mo|qu[eé])|dame\s+(ideas|un\s+plan)|arm[aá](me)?\s+un\s+plan)\b[^.!?]{0,80}\b(aument|mejor|crec|sub[ií]r?|m[aá]s\s+(reservas|hu[eé]spedes|ventas|ocupaci[oó]n|clientes|gente)|vender|llen|posicion|visib|arranc|empez|despeg|factur|rendir|destac)/i;

// Señales de que el pedido NO es abierto: hay una entidad concreta sobre la
// mesa. "Quiero mejorar la tarifa del 24/12" es una operacion puntual, no un
// plan de crecimiento — y responderle con un plan de 5 pasos seria no
// escucharlo.
const ENTITY_REF =
  /\b(reserva\s+[A-Z0-9][A-Z0-9-]{3,}|habitaci[oó]n\s+\d+|unidad\s+\d+|\d{1,2}\/\d{1,2}(\/\d{2,4})?|20\d\d-\d\d-\d\d|tarifa\s+(del|de\s+la|para\s+el)\s|promo(ci[oó]n)?\s+["“][^"”]+["”])/i;

// Referencia a un paso de un plan ya propuesto: "hace el paso 2", "dale con el
// punto tres". Va al perfil de ejecucion de paso, que resuelve la tool concreta
// sin volver a diagnosticar nada.
const PLAN_STEP_REF =
  /\b(paso|punto)\s+(\d{1,2}|uno|dos|tres|cuatro|cinco|seis|siete)\b/i;

const STEP_WORDS: Record<string, number> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
};

/** Numero de paso mencionado, si lo hay (1-based, como lo ve el usuario). */
export function planStepNumber(message: string): number | null {
  const m = PLAN_STEP_REF.exec(message);
  if (!m) return null;
  const token = m[2].toLowerCase();
  const n = /^\d+$/.test(token) ? Number(token) : STEP_WORDS[token];
  return n && n > 0 ? n : null;
}

// Intencion de BUSQUEDA WEB / informacion actual del mundo real. Debe ir a un
// tier con web_search (operativo/analista), nunca a consulta (barato, sin tool).
const WEB_INTENT =
  /\b(busc\w*\s+(en\s+)?(la\s+)?(web|internet|google|l[ií]nea|online)|en\s+(la\s+)?(web|internet)|googlea\w*|noticias?|evento|eventos|cartelera|clima|pron[oó]stico\s+del\s+tiempo|cotizaci\w*|d[oó]lar|cerca\s+(de|m[ií]o|tuy)|cerca\s+de\s+(donde|mi|aqu[ií]|ac[aá])|qu[eé]\s+hacer\b|restaurante|hotel(es)?\s+cerca)/i;

interface HeuristicHit {
  id: SubAgentId;
  /** Pedido de objetivo abierto: dispara el perfil de turno estrategico. */
  strategic?: boolean;
}

function heuristicSubAgent(message: string): HeuristicHit | null {
  const t = message.trim();
  if (!t) return null;
  // ESTRATEGICO va PRIMERO, antes que DEEP. "quiero mejorar mi estrategia de
  // ocupacion" matchea DEEP por la palabra "estrateg" y terminaria como un
  // analisis suelto: el modelo leeria cinco tools sin estructura y contestaria
  // el parrafo generico de siempre. Con el objetivo abierto detectado primero,
  // el turno arranca con la foto del hotel ya resuelta.
  if (STRATEGIC_INTENT.test(t) && !ENTITY_REF.test(t)) {
    return { id: "analista", strategic: true };
  }
  // El analisis manda sobre la escritura: "analiza si conviene cancelar..." es
  // razonamiento, no una orden de cancelar.
  if (DEEP_INTENT.test(t)) return { id: "analista" };
  // Revenue: mismo criterio. Antes que WRITE para que "crea una regla de
  // pricing" no caiga en operativo — decidir sobre precios es analisis.
  if (REVENUE_INTENT.test(t)) return { id: "analista" };
  // Busqueda web → operativo (tiene web_search). Antes que WRITE para que
  // "busca eventos cerca" no caiga en consulta por no matchear write.
  if (WEB_INTENT.test(t)) return { id: "operativo" };
  if (WRITE_INTENT.test(t)) return { id: "operativo" };
  // Trivial solo si es corto: evita clasificar como saludo un texto largo que
  // arranca con "hola, necesito que...".
  if (t.length <= 40 && TRIVIAL.test(t)) return { id: "consulta" };
  return null;
}

// ── Clasificador LLM (solo casos ambiguos) ──────────────────────────────────

const CLASSIFIER_SYSTEM = [
  "Sos un router de un asistente de hoteleria (PMS). Clasifica el ULTIMO mensaje",
  "del usuario en exactamente UNO de estos niveles y responde SOLO con esa",
  "palabra, sin nada mas:",
  "",
  '- "quick": consulta simple de solo-lectura, dato puntual, saludo o pregunta',
  "  de informacion general/politicas. No requiere crear ni modificar nada ni",
  "  razonar en varios pasos.",
  '- "standard": ejecutar una operacion del PMS (crear/editar/cancelar/asignar/',
  "  cambiar estado, gestionar reservas o habitaciones, configurar), una consulta",
  "  que probablemente derive en una accion, o que requiera BUSCAR INFORMACION",
  "  ACTUAL/EXTERNA en la web (eventos, noticias, clima, lugares, datos del mundo",
  "  real): eso necesita web_search, que solo existe en standard o deep.",
  '- "deep": requiere razonamiento de varios pasos: analizar, comparar, optimizar,',
  "  recomendar la mejor opcion, diagnosticar o cruzar datos de varias fuentes.",
  "  TODO lo de revenue management entra aca aunque suene simple: pace, pickup,",
  "  comp-set/competencia, RevPAR/ADR, reglas de pricing, recomendaciones de",
  "  tarifa, guardrails. Leer esos numeros sin interpretarlos no sirve.",
  '- "estrategico": el usuario plantea un OBJETIVO DE NEGOCIO ABIERTO sin decir',
  "  que accion quiere ni sobre que entidad concreta: quiere mas reservas, mas",
  "  ocupacion, crecer, vender mas, no sabe por donde arrancar, pide un plan o",
  "  ideas para mejorar. Si menciona una reserva, una fecha o una tarifa puntual,",
  "  NO es estrategico.",
  "",
  "Ante la duda entre quick y standard, elegi standard. Nunca expliques.",
].join("\n");

/**
 * "estrategico" NO es un tier nuevo: es una sub-etiqueta de deep que ademas
 * prende el flag `strategicRequest`. El modelo y el alcance de tools los sigue
 * poniendo el sub-agente analista; lo que cambia es como se arma el turno.
 */
function parseTier(text: string): { tier: SubAgentTier; strategic: boolean } | null {
  const t = text.toLowerCase();
  if (t.includes("estrategico") || t.includes("estratégico")) {
    return { tier: "deep", strategic: true };
  }
  if (t.includes("deep")) return { tier: "deep", strategic: false };
  if (t.includes("quick")) return { tier: "quick", strategic: false };
  if (t.includes("standard")) return { tier: "standard", strategic: false };
  return null;
}

async function classifyWithLLM(
  message: string,
  recentContext?: string,
): Promise<HeuristicHit | null> {
  try {
    const client = getLlmClient();
    const userContent = recentContext
      ? `Contexto previo (asistente): ${recentContext}\n\nMensaje del usuario: ${message}`
      : `Mensaje del usuario: ${message}`;
    // Ocho tokens alcanzaban para una palabra cuando el modelo contestaba
    // directo. Los del catalogo nuevo RAZONAN antes de escribir y ese
    // razonamiento sale del mismo presupuesto: con 8, el turno se terminaba
    // pensando y volvia sin bloque de texto, asi que el clasificador contestaba
    // null SIEMPRE y el router caia al default en cada mensaje ambiguo —
    // pagando el pedido sin obtener la clasificacion. Se apaga el razonamiento
    // donde el modelo lo permite y se deja aire donde no.
    const thinking = thinkingBlockFor(ROUTER_MODEL, { enabled: false });
    const res = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: withReasoningHeadroom(ROUTER_MODEL, 16),
      ...(thinking ? { thinking } : {}),
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    const text =
      (res.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text ?? "";
    const parsed = parseTier(text);
    if (!parsed) return null;
    return {
      id: TIER_TO_SUB_AGENT[parsed.tier],
      strategic: parsed.strategic,
    };
  } catch (err) {
    console.warn(
      "[taskRouter] clasificador LLM fallo; uso default:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Entrada principal ────────────────────────────────────────────────────────

export async function routeTurn(input: {
  userMessage: string;
  /** Resumen del ultimo turno del asistente, para desambiguar follow-ups. */
  recentContext?: string;
  enabledToolIds: string[];
  /**
   * Hay un plan de crecimiento activo en este espacio. Sin esto, "hace el paso
   * 2" no significa nada y no hay que tratarlo como referencia a un plan.
   */
  hasActivePlan?: boolean;
}): Promise<RouteDecision> {
  // Un paso de un plan ya propuesto no necesita clasificarse ni diagnosticarse
  // de nuevo: es una ejecucion concreta. Se resuelve arriba de todo para no
  // gastar el clasificador en algo que la conversacion ya decidio.
  const stepNumber = input.hasActivePlan
    ? planStepNumber(input.userMessage)
    : null;
  if (stepNumber !== null) {
    return {
      subAgent: SUB_AGENTS.operativo,
      toolIds: input.enabledToolIds,
      reason: `paso-de-plan:${stepNumber}`,
      strategicRequest: false,
      planStepNumber: stepNumber,
    };
  }

  let hit = heuristicSubAgent(input.userMessage);
  let reason = hit ? `heuristica:${hit.id}${hit.strategic ? "+estrategico" : ""}` : "";

  if (!hit && routerLlmEnabled()) {
    hit = await classifyWithLLM(input.userMessage, input.recentContext);
    reason = hit ? `clasificador:${hit.id}${hit.strategic ? "+estrategico" : ""}` : "";
  }

  if (!hit) {
    hit = { id: DEFAULT_SUB_AGENT };
    reason = reason || "default";
  }

  const profile = SUB_AGENTS[hit.id];
  const toolIds =
    profile.toolScope === "read"
      ? await filterReadOnlyToolIds(input.enabledToolIds)
      : input.enabledToolIds;

  return {
    subAgent: profile,
    toolIds,
    reason,
    strategicRequest: hit.strategic === true,
    planStepNumber: null,
  };
}
