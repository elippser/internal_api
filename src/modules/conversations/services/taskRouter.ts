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
import type { TourismFacet } from "../../tourism/tourism.types";
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
  /**
   * Pregunta de contexto turistico de la zona (movimiento, eventos, entorno,
   * temporada). El service arma el dossier en codigo y, si la pregunta es solo
   * eso, la contesta con el perfil turistico en vez del loop de tools + web.
   */
  tourism: { facets: TourismFacet[] } | null;
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

// ── Pregunta TURISTICA ──────────────────────────────────────────────────────
//
// "¿Como viene el movimiento en mi zona?", "¿hay algo grande cerca este
// finde?", "¿que tan bien ubicado estoy?", "¿se viene una temporada fuerte?".
// Antes caian en WEB_INTENT (evento/clima/cerca) y se contestaban buscando en
// Google, o en DEEP por "tendencia". Ahora las contestan los hubs de /global,
// leidos en codigo (ver modules/tourism).

const TOURISM_STRONG =
  /\b(movimiento\s+tur[ií]stic\w*|turismo|turistas?|tur[ií]stic[oa]s?\b|estacionalidad|fin(?:es)?\s+de\s+semana\s+largos?|findes?\s+largos?|feriados?|puentes?\s+tur[ií]stic\w*|vacaciones\s+(?:de\s+)?(?:invierno|verano|escolares)|receso\s+escolar|eventos?\s+(?:cerca|pr[oó]xim\w*|grandes?|importantes?|en\s+(?:la|mi)\s+(?:zona|ciudad|provincia))|(?:congresos?|ferias?|festival(?:es)?|recitales?|conciertos?|partidos?|maratones?|shows?)\s+(?:cerca|pr[oó]xim\w*|en\s+(?:la|mi)\s+(?:zona|ciudad|provincia))|(?:algo|qu[eé])\b[^.?!]{0,25}\b(?:pasando|pasa|hay)\b[^.?!]{0,25}\bcerca\b|mi\s+(?:zona|ubicaci[oó]n|entorno|barrio|ciudad|provincia|regi[oó]n|destino|localidad)|tendencias?\s+(?:tur[ií]stic\w*|de\s+(?:la\s+)?(?:zona|ciudad|demanda)|en\s+(?:la|mi)\s+(?:zona|ciudad|provincia|regi[oó]n))|bien\s+ubicad[oa]|caminab\w*|mejor\s+[eé]poca|clima\s+(?:de|en)\s+(?:la|mi)\s+zona|c[oó]mo\s+(?:viene|est[aá]|anda)\s+(?:el\s+)?(?:movimiento|turismo|la\s+zona|la\s+temporada|la\s+demanda)|va\s+a\s+haber\s+(?:mucho\s+|m[aá]s\s+)?(?:turismo|gente|movimiento))/i;

// "Temporada" sola es ambigua: en el PMS es tambien un concepto de tarifas
// ("carga la tarifa de temporada alta"). Solo cuenta sin contexto de precios.
const TOURISM_SEASON =
  /\btemporadas?\s+(?:alta|baja|fuerte|floja|tur[ií]stica|de\s+(?:verano|invierno))|\b(?:se\s+viene|viene|llega)\s+(?:la\s+|una\s+)?temporada/i;
const RATE_CONTEXT =
  /\b(tarifas?|precios?|plan(?:es)?\s+tarifari\w*|rate\s*plan|m[ií]nimo\s+de\s+noches|restricci\w*)\b/i;

// Pedido EXPLICITO de buscar en la web: gana sobre turismo. "Busca en google
// que eventos hay" quiere Google, no el dossier.
const WEB_EXPLICIT =
  /\b(busc\w*\s+(en\s+)?(la\s+)?(web|internet|google|l[ií]nea|online)|googlea\w*|en\s+(la\s+)?(web|internet))\b/i;

// Curar los eventos del RMS (aprobar/descartar sugeridos) es una operacion de
// revenue, no una pregunta de contexto.
const MARKET_EVENTS_ADMIN =
  /\beventos?\s+(?:de\s+mercado|sugeridos?|aprobados?|descartados?)|\b(?:aprob|descart|sincroniz)\w*\s+(?:el\s+|los\s+|un\s+|este\s+)?eventos?/i;

const FACET_PATTERNS: Array<[TourismFacet, RegExp]> = [
  ["entorno", /\b(ubicad|ubicaci[oó]n|entorno|barrio|caminab|a\s+pie|transporte|colectivo|subte|parada|ruido|restaurantes?|gastronom|qu[eé]\s+(?:hay|tengo)\s+cerca)/i],
  // Con límite de palabra al final: sin él, "ferias?" matchea "feriado".
  ["eventos", /\b(eventos?|congresos?|ferias?|festival(?:es)?|recitales?|conciertos?|partidos?|marat[oó]n|maratones|shows?|espect[aá]culos?|pasando\s+cerca|pasa\s+cerca)\b/i],
  ["estacionalidad", /\b(temporadas?|estacionalidad|feriados?|fin(?:es)?\s+de\s+semana\s+largos?|findes?\s+largos?|puentes?|vacaciones|receso|clima|mejor\s+[eé]poca|invierno|verano|primavera|oto[ñn]o|lluvias?)\b/i],
  ["movimiento", /\b(movimiento|turismo|turistas?|gente|demanda|inter[eé]s|b[uú]squedas?|tendencias?|c[oó]mo\s+(?:viene|est[aá]|anda))\b/i],
];

export function isTourismQuestion(message: string): boolean {
  if (WEB_EXPLICIT.test(message) || MARKET_EVENTS_ADMIN.test(message)) return false;
  if (TOURISM_STRONG.test(message)) return true;
  return TOURISM_SEASON.test(message) && !RATE_CONTEXT.test(message);
}

/**
 * Facetas pedidas, como mucho dos. "movimiento" es el comodin: si hay una
 * faceta especifica, esa manda. Sin ninguna, "movimiento".
 */
export function tourismFacets(message: string): TourismFacet[] {
  const hit = FACET_PATTERNS.filter(([, re]) => re.test(message)).map(([f]) => f);
  if (hit.length === 0) return ["movimiento"];
  const specific = hit.filter((f) => f !== "movimiento");
  return (specific.length ? specific : hit).slice(0, 2);
}

interface HeuristicHit {
  id: SubAgentId;
  /** Pedido de objetivo abierto: dispara el perfil de turno estrategico. */
  strategic?: boolean;
  /** Pregunta de contexto turistico: facetas pedidas. */
  tourism?: TourismFacet[];
}

function heuristicSubAgent(message: string): HeuristicHit | null {
  const t = message.trim();
  if (!t) return null;
  const tourism = isTourismQuestion(t) ? tourismFacets(t) : undefined;
  // ESTRATEGICO va PRIMERO, antes que DEEP. "quiero mejorar mi estrategia de
  // ocupacion" matchea DEEP por la palabra "estrateg" y terminaria como un
  // analisis suelto: el modelo leeria cinco tools sin estructura y contestaria
  // el parrafo generico de siempre. Con el objetivo abierto detectado primero,
  // el turno arranca con la foto del hotel ya resuelta.
  if (STRATEGIC_INTENT.test(t) && !ENTITY_REF.test(t)) {
    return { id: "analista", strategic: true, tourism };
  }
  // TURISTICO va antes que DEEP/REVENUE/WEB: "¿se viene una temporada fuerte?"
  // no es un analisis ni una busqueda en Google, es una lectura de los hubs.
  // Si ademas pide analizar u operar, conserva ese sub-agente con el dossier
  // precargado; si es solo contexto, lo atiende el perfil turistico (consulta).
  if (tourism) {
    if (DEEP_INTENT.test(t) || REVENUE_INTENT.test(t)) return { id: "analista", tourism };
    if (WRITE_INTENT.test(t)) return { id: "operativo", tourism };
    return { id: "consulta", tourism };
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
  "  que probablemente derive en una accion, o que requiera BUSCAR EN LA WEB algo",
  "  puntual con nombre propio (una noticia, un lugar concreto, una cotizacion):",
  "  eso necesita web_search, que solo existe en standard o deep.",
  '- "turistico": pregunta por el CONTEXTO de la zona del alojamiento: movimiento',
  "  o demanda turistica, eventos cercanos, feriados, fines de semana largos,",
  "  temporada o clima de la zona, o como es el entorno y la ubicacion. NO es",
  "  turistico si pide buscar algo en la web ni si es una operacion del PMS.",
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
function parseTier(
  text: string,
): { tier: SubAgentTier; strategic: boolean; tourism: boolean } | null {
  const t = text.toLowerCase();
  if (t.includes("estrategico") || t.includes("estratégico")) {
    return { tier: "deep", strategic: true, tourism: false };
  }
  // "turistico" tampoco es un tier: es consulta + dossier turistico.
  if (t.includes("turistico") || t.includes("turístico")) {
    return { tier: "quick", strategic: false, tourism: true };
  }
  if (t.includes("deep")) return { tier: "deep", strategic: false, tourism: false };
  if (t.includes("quick")) return { tier: "quick", strategic: false, tourism: false };
  if (t.includes("standard")) return { tier: "standard", strategic: false, tourism: false };
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
      ...(parsed.tourism ? { tourism: tourismFacets(message) } : {}),
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
      tourism: null,
    };
  }

  const flags = (h: HeuristicHit) =>
    `${h.strategic ? "+estrategico" : ""}${h.tourism ? `+turistico(${h.tourism.join(",")})` : ""}`;

  let hit = heuristicSubAgent(input.userMessage);
  let reason = hit ? `heuristica:${hit.id}${flags(hit)}` : "";

  if (!hit && routerLlmEnabled()) {
    hit = await classifyWithLLM(input.userMessage, input.recentContext);
    reason = hit ? `clasificador:${hit.id}${flags(hit)}` : "";
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
    tourism: hit.tourism?.length ? { facets: hit.tourism } : null,
  };
}
