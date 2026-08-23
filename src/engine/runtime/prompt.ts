/**
 * Composición del prompt y presupuesto de historial (§16, parcial).
 *
 * El orden de composición está diseñado para que el prefijo sea SEGURO PARA
 * CACHÉ, es decir, estable entre turnos:
 *
 *   [ESTÁTICO]  identidad del agente · preámbulo de capacidades · prompt de sistema
 *   ----------- punto de caché -----------
 *   [DINÁMICO]  variables de contexto · ahora · disparador · notas del turno
 *
 * Meter la fecha y hora en el bloque estático es el error clásico: cambia en
 * cada petición, invalida el prefijo entero y el caché nunca acierta. No hay
 * error, sólo `cache_read_input_tokens` en cero para siempre.
 *
 * Alcance de esta entrega: presupuesto derivado del modelo y ventana por
 * mensajes. La escalera completa de compactación (poda -> resumen -> emergencia)
 * es §16.3 y quedó fuera del núcleo; el punto de extensión está marcado abajo.
 * Lo que SÍ se sostiene ya es el invariante §35.10: el recorte nunca rompe un
 * par llamada/resultado ni cambia el orden.
 */
import { getEngineConfig } from "../core/config";
import { capabilitiesFor } from "../llm/catalog";
import type { EngineAgentVersionDoc } from "../models/agentVersion.model";
import type { EngineExecutionDoc } from "../models/execution.model";
import type { GraphMessage } from "../graph/types";
import type { ResolvedTool } from "../tools/types";

export interface PromptParts {
  static: string;
  dynamic: string;
}

export interface PromptInput {
  version: EngineAgentVersionDoc;
  execution: EngineExecutionDoc;
  agentName: string;
  tools: ResolvedTool[];
  denied: Array<{ name: string; reason: string }>;
  /** Bloque de NIVEL 1 de las habilidades: nombre + descripción, nada más (§19). */
  skillsBlock?: string;
}

export function buildPromptParts(input: PromptInput): PromptParts {
  const staticParts: string[] = [];

  // --- Precarga de identidad (estable) -----------------------------------
  staticParts.push(
    ["## Identidad", `Sos "${input.agentName}" (agente ${input.version.agentId}).`].join("\n"),
  );

  // --- Preámbulo de capacidades (estable) --------------------------------
  const capabilities = Object.entries(input.version.config?.capabilities ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (capabilities.length > 0) {
    staticParts.push(`## Capacidades activas\n${capabilities.join(", ")}`);
  }

  // --- Prompt del autor (estable) ----------------------------------------
  if (input.version.systemPrompt?.trim()) {
    staticParts.push(input.version.systemPrompt.trim());
  }

  // --- Habilidades, nivel 1 (estable, seguro para caché) -----------------
  // El conjunto no cambia entre turnos de la misma conversación, así que va
  // ANTES del punto de caché. Si entrara en el bloque dinámico, invalidaría el
  // prefijo en cada turno y el caché nunca acertaría.
  if (input.skillsBlock?.trim()) {
    staticParts.push(input.skillsBlock.trim());
  }

  // --- Negaciones explicativas (estable dentro de la corrida) ------------
  // Que el modelo SEPA qué no tiene evita el bucle de intentar una herramienta
  // ausente una y otra vez, y le permite decirle al usuario que escale.
  if (input.denied.length > 0) {
    const lines = input.denied.map((d) => `- ${d.name}: ${d.reason}`);
    staticParts.push(
      [
        "## Herramientas no disponibles en esta sesión",
        "No intentes usarlas. Si una tarea las requiere, decilo y pedí que se habiliten.",
        ...lines,
      ].join("\n"),
    );
  }

  // --- Bloque dinámico (volátil, después del punto de caché) -------------
  const dynamicParts: string[] = [
    [
      "## Contexto de esta corrida",
      `- Ahora: ${new Date().toISOString()}`,
      `- Disparador: ${input.execution.trigger}`,
      `- Modo de ejecución: ${input.execution.responseMode}`,
      ...(input.execution.depth > 0 ? [`- Profundidad de delegación: ${input.execution.depth}`] : []),
    ].join("\n"),
  ];

  const ctx = (input.execution.input?.context ?? {}) as Record<string, unknown>;
  const ctxLines = Object.entries(ctx)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `- ${k}: ${String(v)}`);
  if (ctxLines.length > 0) {
    dynamicParts.push(["## Variables de contexto", ...ctxLines].join("\n"));
  }

  return {
    static: staticParts.join("\n\n---\n\n"),
    dynamic: dynamicParts.join("\n\n"),
  };
}

/**
 * Presupuesto de historial DERIVADO DEL MODELO, no de una constante (§16.3).
 *
 *   ventana     = catálogo -> reserva conservadora
 *   reserva     = min(reserva configurada, ventana × 0.25)
 *   derivado    = max(4k, ventana × proporción − reserva)
 *   presupuesto = min(derivado, tope del agente, tope global)
 *
 * Derivarlo importa porque una constante que funciona en un modelo de 200k
 * desperdicia el 80% de uno de 1M, y revienta uno de 32k.
 */
export function historyBudgetTokens(version: EngineAgentVersionDoc, model: string): number {
  const cfg = getEngineConfig();
  const caps = capabilitiesFor(model);

  const window = caps.contextWindowTokens || cfg.context.fallbackWindowTokens;
  const reserve = Math.min(cfg.context.reserveTokens, Math.floor(window * 0.25));
  const derived = Math.max(4_000, Math.floor(window * cfg.context.windowRatio) - reserve);

  const agentCap = version.config?.context?.maxHistoryTokens ?? Number.POSITIVE_INFINITY;
  return Math.min(derived, agentCap, cfg.context.globalMaxTokens);
}

/**
 * Recorta el historial a una ventana de mensajes SIN romper la validez para el
 * proveedor (§35.10).
 *
 * Las dos reglas que hacen esto correcto y no obvio:
 *   1. La ventana no puede empezar en un mensaje de usuario que contenga
 *      `tool_result`: ese resultado quedaría huérfano de su `tool_use` y el
 *      proveedor devuelve 400.
 *   2. El primer mensaje conservado tiene que ser de rol `user`.
 *
 * La marca de omisión es explícita a propósito: sin ella el modelo cree que vio
 * el principio de la conversación y afirma cosas falsas sobre lo que "nunca se
 * dijo".
 */
export function trimHistory(messages: GraphMessage[], maxMessages: number): GraphMessage[] {
  if (messages.length <= maxMessages) return messages;

  let start = messages.length - maxMessages;

  while (start > 0 && start < messages.length) {
    const candidate = messages[start];
    const orphanResult =
      candidate.role === "user" &&
      Array.isArray(candidate.content) &&
      (candidate.content as Array<{ type?: string }>).some((b) => b?.type === "tool_result");

    if (orphanResult || candidate.role !== "user") {
      // Retroceder (conservar de más) y no avanzar: avanzar podría descartar el
      // turno del usuario que da sentido a todo lo que sigue.
      start -= 1;
      continue;
    }
    break;
  }

  const kept = messages.slice(Math.max(0, start));
  if (start > 0) {
    kept.unshift({
      role: "user",
      content:
        "[Se omitieron mensajes anteriores de esta conversación por límite de contexto. " +
        "Esto NO es el comienzo del intercambio: si necesitás algo de antes, pedilo.]",
    });
  }
  return kept;
}

/**
 * PUNTO DE EXTENSIÓN — escalera de compactación (§16.3).
 *
 * El núcleo entregado corta por ventana de mensajes. La escalera completa
 * (1. poda de salidas viejas y grandes de herramientas, 2. resumen del segmento
 * viejo con un modelo económico y cola reciente verbatim, 3. emergencia: mayor
 * sufijo que entre con marca de omisión) se implementa acá, y todas las etapas
 * deben respetar el invariante §35.10.
 */
export function compactHistory(messages: GraphMessage[], _budgetTokens: number): GraphMessage[] {
  const cfg = getEngineConfig();
  void _budgetTokens;
  return trimHistory(messages, cfg.execution.maxIterations * 4);
}
