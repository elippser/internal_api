// Router de tareas de bookfer-IA.
//
// Decide, por turno y dentro del mismo chat, a que sub-agente delegar (ver
// subAgents.ts). Estrategia en dos pasos, barata y robusta:
//   1) Heuristicas (regex, costo cero): resuelven los casos obvios — saludos,
//      pedidos claros de escritura, pedidos claros de analisis.
//   2) Clasificador LLM (Haiku, salida de 1 palabra): solo para los casos
//      ambiguos que la heuristica no cierra. Si falla, caemos al default.
//
// Sesgo de diseno: ante la duda NUNCA elegimos el tier mas debil. El default y
// el fallback son "operativo" (Sonnet, todas las tools). El sub-agente
// "consulta" (Haiku, solo-lectura) se elige solo cuando hay confianza de que la
// tarea es trivial / de solo-lectura.

import { getAnthropic } from "./anthropicClient";
import { filterReadOnlyToolIds } from "./toolExecutor";
import {
  SUB_AGENTS,
  DEFAULT_SUB_AGENT,
  TIER_TO_SUB_AGENT,
  type SubAgentId,
  type SubAgentProfile,
  type SubAgentTier,
} from "./subAgents";

const ROUTER_MODEL =
  process.env.ROUTER_MODEL ?? "claude-haiku-4-5-20251001";
// Permite desactivar el clasificador LLM y operar solo con heuristicas+default.
const ROUTER_LLM_ENABLED =
  (process.env.ROUTER_LLM_CLASSIFIER ?? "true").toLowerCase() !== "false";

export interface RouteDecision {
  subAgent: SubAgentProfile;
  /** Tools efectivas del turno (acotadas si el sub-agente es de solo-lectura). */
  toolIds: string[];
  /** Como se decidio (telemetria/log). */
  reason: string;
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
// uso diario en el PMS y mandarian consultas triviales a Opus.
const REVENUE_INTENT =
  /\b(revenue|revpar|rev\s?par|\badr\b|pick[\s-]?up|booking\s*pace|\bpace\b|pace[\s_-]?index|comp[\s-]?set|compset|competidor\w*|competencia|pricing|yield|benchmark|rms|tarifa[s]?\s+(sugerid|recomendad)\w*|recomendaci\w*\s+de\s+tarifa|regla[s]?\s+de\s+(pricing|tarifa)|ventana\s+de\s+reserva|booking\s*window|guardrail\w*|paridad\s+tarifaria)\b/i;

// Intencion de BUSQUEDA WEB / informacion actual del mundo real. Debe ir a un
// tier con web_search (operativo/analista), nunca a consulta (Haiku, sin tool).
const WEB_INTENT =
  /\b(busc\w*\s+(en\s+)?(la\s+)?(web|internet|google|l[ií]nea|online)|en\s+(la\s+)?(web|internet)|googlea\w*|noticias?|evento|eventos|cartelera|clima|pron[oó]stico\s+del\s+tiempo|cotizaci\w*|d[oó]lar|cerca\s+(de|m[ií]o|tuy)|cerca\s+de\s+(donde|mi|aqu[ií]|ac[aá])|qu[eé]\s+hacer\b|restaurante|hotel(es)?\s+cerca)/i;

function heuristicSubAgent(message: string): SubAgentId | null {
  const t = message.trim();
  if (!t) return null;
  // El analisis manda sobre la escritura: "analiza si conviene cancelar..." es
  // razonamiento, no una orden de cancelar.
  if (DEEP_INTENT.test(t)) return "analista";
  // Revenue: mismo criterio. Antes que WRITE para que "crea una regla de
  // pricing" no caiga en operativo — decidir sobre precios es analisis.
  if (REVENUE_INTENT.test(t)) return "analista";
  // Busqueda web → operativo (tiene web_search). Antes que WRITE para que
  // "busca eventos cerca" no caiga en consulta por no matchear write.
  if (WEB_INTENT.test(t)) return "operativo";
  if (WRITE_INTENT.test(t)) return "operativo";
  // Trivial solo si es corto: evita clasificar como saludo un texto largo que
  // arranca con "hola, necesito que...".
  if (t.length <= 40 && TRIVIAL.test(t)) return "consulta";
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
  "",
  "Ante la duda entre quick y standard, elegi standard. Nunca expliques.",
].join("\n");

function parseTier(text: string): SubAgentTier | null {
  const t = text.toLowerCase();
  if (t.includes("deep")) return "deep";
  if (t.includes("quick")) return "quick";
  if (t.includes("standard")) return "standard";
  return null;
}

async function classifyWithLLM(
  message: string,
  recentContext?: string,
): Promise<SubAgentId | null> {
  try {
    const client = getAnthropic();
    const userContent = recentContext
      ? `Contexto previo (asistente): ${recentContext}\n\nMensaje del usuario: ${message}`
      : `Mensaje del usuario: ${message}`;
    const res = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 8,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    const text =
      (res.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text ?? "";
    const tier = parseTier(text);
    return tier ? TIER_TO_SUB_AGENT[tier] : null;
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
}): Promise<RouteDecision> {
  let id = heuristicSubAgent(input.userMessage);
  let reason = id ? `heuristica:${id}` : "";

  if (!id && ROUTER_LLM_ENABLED) {
    id = await classifyWithLLM(input.userMessage, input.recentContext);
    reason = id ? `clasificador:${id}` : "";
  }

  if (!id) {
    id = DEFAULT_SUB_AGENT;
    reason = reason || "default";
  }

  const profile = SUB_AGENTS[id];
  const toolIds =
    profile.toolScope === "read"
      ? await filterReadOnlyToolIds(input.enabledToolIds)
      : input.enabledToolIds;

  return { subAgent: profile, toolIds, reason };
}
