import type { RetrievedChunk } from "./ragRetriever";

interface AgentLike {
  persona: {
    displayName: string;
    tone: string;
    language: string;
    personality: string;
  };
  instructions: {
    systemPrompt: string;
    constraints: string[];
    examples: Array<{
      label: string;
      type: "good" | "bad";
      turns: Array<{ role: string; content: string }>;
    }>;
  };
  enabledToolIds: string[];
  feedbackCapture: {
    enabled: boolean;
    confirmWithUser: boolean;
  };
}

interface SessionLike {
  context: {
    userId?: string;
    companyId?: string;
    propertyId?: string;
    operativeSpaceId?: string;
    operativeSpaceName?: string;
    userRole?: string;
    userName?: string;
    propertyName?: string;
    propertyType?: string;
    companyName?: string;
  };
}

// El system prompt se divide en dos partes para habilitar prompt caching:
//
//   static  → estable por (agente, día): persona, restricciones, herramientas,
//             ejemplos, captura de feedback, y el core (con fecha día-estable,
//             SIN hora). Es el prefijo cacheable: junto con la lista de tools
//             (que renderiza antes que el system) se cachea con UN breakpoint, y
//             se reusa en cada iteración del loop de tools y entre turnos del
//             mismo tier dentro del TTL. No debe contener nada volátil por
//             request (hora, RAG, memoria) o se invalida el cache.
//   dynamic → volátil por turno: contexto (fecha+hora, propertyId, usuario),
//             memoria de largo plazo y chunks de RAG. Va DESPUÉS del breakpoint,
//             sin cachear.
//
// La especialización del sub-agente (taskRouter) se concatena al dynamic en el
// runner. Ver shared/prompt-caching: "cualquier byte que cambie en el prefijo
// invalida todo lo que sigue".
export function buildSystemPromptParts(
  agent: AgentLike,
  session: SessionLike,
  chunks: RetrievedChunk[],
  memories: string[] = [],
  // Nivel 1 de las habilidades (una línea por habilidad). Va en el prefijo
  // ESTABLE: el conjunto no cambia entre turnos de la misma conversación, así
  // que es seguro para caché. El cuerpo (nivel 2) lo trae `load_skill`.
  skillsBlock = "",
  // Sección "Permisos del usuario" (ver toolAccess.renderPermissionsBlock). Va
  // en la parte DINÁMICA: depende del usuario y se re-resuelve por turno (un
  // admin puede quitar un acceso a mitad de la conversación).
  permissionsBlock = "",
): { static: string; dynamic: string } {
  const staticPart = [
    section1Core(agent, session),
    section2Persona(agent),
    section3Constraints(agent),
    section5Tools(agent),
    skillsBlock.trim(),
    section7Examples(agent),
    section8FeedbackCapture(agent),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const dynamicPart = [
    section4Context(session),
    permissionsBlock.trim(),
    sectionMemory(memories),
    section6Rag(chunks),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { static: staticPart, dynamic: dynamicPart };
}

// Compat: prompt completo en un solo string (static + dynamic). Lo usan scripts
// de test; el runtime usa buildSystemPromptParts para poder cachear el prefijo.
export function buildSystemPrompt(
  agent: AgentLike,
  session: SessionLike,
  chunks: RetrievedChunk[],
  memories: string[] = [],
  skillsBlock = "",
  permissionsBlock = "",
): string {
  const { static: s, dynamic: d } = buildSystemPromptParts(
    agent,
    session,
    chunks,
    memories,
    skillsBlock,
    permissionsBlock,
  );
  return [s, d].filter(Boolean).join("\n\n---\n\n");
}

function sectionMemory(memories: string[]): string {
  if (!memories || memories.length === 0) return "";
  return [
    "## Memoria de largo plazo (de conversaciones previas de este espacio)",
    "Tene en cuenta estos hechos/preferencias que recordaste de antes. Si alguno",
    "contradice lo que dice el usuario ahora, el usuario tiene prioridad.",
    ...memories.map((m) => `- ${m}`),
  ].join("\n");
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{${key}}`,
  );
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("es-AR");
}
function fmtTime(d: Date) {
  return d.toLocaleTimeString("es-AR");
}

function section1Core(agent: AgentLike, session: SessionLike): string {
  const sys = agent.instructions.systemPrompt ?? "";
  if (!sys.trim()) return "";
  const now = new Date();
  // El core va en el prefijo CACHEABLE. La fecha (día) es estable dentro del día
  // → el cache se rearma una vez por día, aceptable. La HORA cambiaría en cada
  // request e invalidaría el cache, así que NO se interpola acá; la hora precisa
  // va en section4Context (parte dinámica, sin cachear).
  return interpolate(sys, {
    propertyName: session.context.propertyName ?? "",
    companyName: session.context.companyName ?? "",
    userName: session.context.userName ?? "",
    userRole: session.context.userRole ?? "",
    currentDate: fmtDate(now),
    currentTime: "",
  });
}

function section2Persona(agent: AgentLike): string {
  const p = agent.persona;
  return [
    "## Personalidad",
    `Tono: ${p.tone}`,
    `Idioma: ${p.language}`,
    p.personality?.trim() ? p.personality.trim() : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function section3Constraints(agent: AgentLike): string {
  const c = agent.instructions.constraints ?? [];
  if (c.length === 0) return "";
  return ["## Restricciones - NUNCA hagas esto:", ...c.map((x) => `- ${x}`)].join(
    "\n",
  );
}

function section4Context(session: SessionLike): string {
  const ctx = session.context;
  const lines = ["## Contexto actual"];
  if (ctx.propertyName) {
    lines.push(
      `- Hotel: ${ctx.propertyName}${ctx.propertyType ? ` (${ctx.propertyType})` : ""}`,
    );
  }
  if (ctx.userName) {
    lines.push(
      `- Usuario: ${ctx.userName}${ctx.userRole ? ` (${ctx.userRole})` : ""}`,
    );
  }
  lines.push(
    `- Fecha: ${fmtDate(new Date())} ${fmtTime(new Date())}`,
  );
  if (ctx.propertyId) {
    lines.push(
      `- Property ID: ${ctx.propertyId}  (usa este valor en las herramientas, nunca lo pidas al usuario)`,
    );
  } else {
    lines.push(
      "- No hay una propiedad activa en esta sesion. Si una herramienta necesita propertyId, primero usa list_properties para ver las propiedades del hotel y confirma con el usuario cual usar; nunca inventes el ID.",
    );
  }
  if (ctx.companyId) lines.push(`- Company ID: ${ctx.companyId}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

function section5Tools(agent: AgentLike): string {
  if (agent.enabledToolIds.length === 0) return "";
  return [
    "## Herramientas disponibles",
    "Tenes acceso a herramientas para consultar y operar el PMS. Antes de",
    "ejecutar una herramienta de escritura, siempre describi la accion y",
    "pedi confirmacion explicita al usuario.",
    "La lista de herramientas de cada turno ya viene ACOTADA a los permisos",
    "reales del usuario (rol, capacidades de la empresa, apps de su espacio",
    "operativo y propiedades habilitadas): si algo no esta en tu lista es por",
    "permisos, no porque la plataforma no lo tenga. Ver 'Permisos del usuario'.",
    "",
    "## Como presentar resultados (IMPORTANTE)",
    "La interfaz del chat renderiza AUTOMATICAMENTE los resultados de las",
    "herramientas como componentes visuales ricos: tarjetas de disponibilidad",
    "(con foto, capacidad, precio y unidades libres), un plano de habitaciones",
    "coloreado por estado, tarjetas de categorias, y listas de reservas.",
    "Por eso, cuando una herramienta devuelve datos:",
    "- NO repitas esos datos como tablas markdown ni listas largas. Es redundante",
    "  y se ve mal: la UI ya los muestra como tarjetas/plano.",
    "- Acompaña con una intro breve y natural (1-2 frases), por ejemplo:",
    '  "Tenes 4 categorias disponibles para esas fechas:" o "Asi esta el plano',
    '  de habitaciones ahora:". Despues podes agregar 1-2 observaciones utiles',
    "  (la mas conveniente, algo a tener en cuenta), pero NO la tabla completa.",
    "- Para precios/totales puntuales o respuestas si/no, responde en texto normal.",
    "",
    "## Imagenes adjuntas y libreria de medios",
    "Si el usuario adjunta una imagen en su mensaje y pide guardarla o usarla",
    "(ej. 'agregala a las fotos de la categoria Standard'), usa la herramienta",
    "add_image_to_library con attachmentIndex=0 para la primera imagen adjunta.",
    "Para agregarla a una categoria, primero resolve su categoryId con las tools",
    "de categorias y pasalo en addToCategoryId. Esta herramienta sube la imagen a",
    "la libreria de la empresa y la adjunta donde corresponda. Solo esta",
    "disponible cuando hay una imagen adjunta en el mensaje actual.",
  ].join("\n");
}

function section6Rag(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const blocks = chunks.map((c) =>
    [`[Fuente: ${c.title || c.documentId}]`, c.content].join("\n"),
  );
  return [
    "## Contexto relevante de la base de conocimiento",
    blocks.join("\n\n"),
    "---",
    "Usa este contexto cuando sea relevante. Si la respuesta no esta aca,",
    "responde desde tu conocimiento general pero se explicito sobre esa",
    "distincion.",
  ].join("\n\n");
}

function section7Examples(agent: AgentLike): string {
  const good = (agent.instructions.examples ?? []).filter(
    (e) => e.type === "good",
  );
  if (good.length === 0) return "";
  const blocks = good.map((ex) => {
    const turns = ex.turns
      .map((t) => `${t.role === "user" ? "Usuario" : "Asistente"}: ${t.content}`)
      .join("\n");
    return `Ejemplo - ${ex.label}:\n${turns}`;
  });
  return ["## Ejemplos de conversacion", blocks.join("\n\n")].join("\n\n");
}

function section8FeedbackCapture(agent: AgentLike): string {
  if (!agent.feedbackCapture.enabled) return "";
  const lines = [
    "## Captura de pedidos no disponibles",
    "Si el usuario pide algo que la plataforma no soporta hoy (no porque",
    "fallo una herramienta, sino porque la funcionalidad no existe):",
    "",
    "1. Decile claramente que no esta disponible",
  ];
  if (agent.feedbackCapture.confirmWithUser) {
    lines.push(
      `2. Preguntale: "Queres que registre este pedido para que el equipo lo evalue?"`,
    );
    lines.push("3. Si confirma, usa la herramienta capture_feedback_request");
  } else {
    lines.push(
      "2. Usa la herramienta capture_feedback_request directamente y avisa que fue registrado",
    );
  }
  lines.push("");
  lines.push("NUNCA prometas que algo se va a implementar. Solo que fue registrado.");
  return lines.join("\n");
}
