// Sub-agentes operativos / de consulta de bookfer-IA.
//
// Cada turno del chat se enruta (ver taskRouter) a UNO de estos perfiles segun
// la complejidad real de la tarea, para no pagar Opus por algo trivial ni
// mandar a Haiku algo que requiere razonamiento. Viven en el MISMO chat:
// comparten sesion, historial, tools habilitadas del agente y memoria de largo
// plazo. Lo unico que cambia entre sub-agentes es:
//   - el MODELO (tier de costo/capacidad),
//   - el ALCANCE de tools del turno (solo-lectura vs todo), y
//   - una nota de ESPECIALIZACION que se appendea al system prompt.
//
// El piso operativo del runner (applyOperationalFloor) sigue siendo la red de
// seguridad: si un turno termina con tools de escritura, el modelo nunca baja
// de Sonnet aunque el router se equivoque.

export type SubAgentId = "consulta" | "operativo" | "analista";
export type SubAgentTier = "quick" | "standard" | "deep";

export interface SubAgentProfile {
  id: SubAgentId;
  /** Etiqueta legible (chips del chat, telemetria). */
  label: string;
  tier: SubAgentTier;
  /** Modelo del tier (env-overridable). */
  model: string;
  /** "read" = solo tools de lectura este turno; "all" = todas las del agente. */
  toolScope: "read" | "all";
  /** Habilita la búsqueda web nativa de Anthropic (solo tiers Sonnet/Opus). */
  webSearch: boolean;
  /** Habilita ejecución de código (genera imágenes/gráficos y documentos). */
  codeExec: boolean;
  /** Nota que se suma al system prompt cuando este sub-agente atiende el turno. */
  specialization: string;
}

// Modelos por tier. Configurables por env para ajustar costo sin tocar codigo.
const MODEL_QUICK =
  process.env.SUBAGENT_MODEL_QUICK ?? "claude-haiku-4-5-20251001";
const MODEL_STANDARD =
  process.env.SUBAGENT_MODEL_STANDARD ?? "claude-sonnet-4-6";
const MODEL_DEEP = process.env.SUBAGENT_MODEL_DEEP ?? "claude-opus-4-8";

export const SUB_AGENTS: Record<SubAgentId, SubAgentProfile> = {
  consulta: {
    id: "consulta",
    label: "Consulta",
    tier: "quick",
    model: MODEL_QUICK,
    toolScope: "read",
    webSearch: false,
    codeExec: false,
    specialization: [
      "## Modo: Consulta rapida",
      "Estas atendiendo una consulta simple: saludos, preguntas de solo-lectura,",
      "una busqueda puntual o una pregunta de la base de conocimiento. Resolve de",
      "forma directa y breve. Para CUALQUIER dato del PMS usa la tool de lectura",
      "correspondiente (nunca inventes). Si la tarea requiere crear/modificar/",
      "eliminar algo, o un analisis de varios pasos, deci en una linea que vas a",
      "encararlo y pedi el dato que falte: el sistema lo escalara al sub-agente",
      "adecuado en el proximo turno.",
    ].join("\n"),
  },
  operativo: {
    id: "operativo",
    label: "Operativo",
    tier: "standard",
    model: MODEL_STANDARD,
    toolScope: "all",
    webSearch: true,
    codeExec: true,
    specialization: [
      "## Modo: Operativo",
      "Estas ejecutando una operacion del PMS (reservas, estados de habitacion,",
      "disponibilidad, altas/bajas, configuracion). Sos la capa de criterio: tomas",
      "el pedido en lenguaje natural y lo llevas a acciones con las tools. Si",
      "faltan datos para ejecutar, pregunta SOLO lo que falta. Antes de una",
      "escritura, describi la accion en una linea y pedi confirmacion; al",
      "confirmar, llama la write tool UNA vez y reporta el resultado real.",
      "Tenes busqueda web (web_search) para datos actuales en linea, y ejecucion",
      "de codigo (code_execution) para GENERAR archivos cuando el usuario lo pida:",
      "graficos/imagenes (matplotlib/PIL -> PNG), planillas (openpyxl -> xlsx),",
      "documentos (python-docx -> docx, reportlab -> pdf). Genera el archivo y",
      "ofrecelo para descargar; no pegues el contenido binario en el chat.",
      "Para preguntas de informacion general o actual (eventos, noticias, clima,",
      "lugares, datos del mundo real) NO digas que 'no esta disponible': usa",
      "web_search y responde con lo que encuentres, citando la fuente.",
    ].join("\n"),
  },
  analista: {
    id: "analista",
    label: "Analista",
    tier: "deep",
    model: MODEL_DEEP,
    toolScope: "all",
    webSearch: true,
    codeExec: true,
    specialization: [
      "## Modo: Analisis profundo",
      "La tarea requiere razonamiento de varios pasos: analizar, comparar,",
      "optimizar, recomendar la mejor opcion, diagnosticar o cruzar datos de",
      "distintas entidades. Reuni primero la informacion real con las tools",
      "necesarias (varias si hace falta), razona sobre los datos obtenidos y",
      "recien entonces responde con una recomendacion concreta y justificada.",
      "No inventes datos: todo lo que afirmes debe salir de una tool de este turno.",
      "ALCANCE: 'varias tools' significa las que la pregunta necesita, NO un barrido",
      "de la plataforma. Antes de cada llamada preguntate que parte de la respuesta",
      "sale de ahi; si no sabes contestarlo, no la llames. Cada lectura ademas",
      "dibuja una tarjeta en el chat, asi que traer datos que no vas a usar no es",
      "solo lento: entierra la respuesta que el usuario pidio bajo material que no",
      "pidio. Un analisis de revenue se contesta con las tools de revenue; no",
      "requiere listar reservas, unidades ni categorias salvo que el usuario lo pida",
      "o el diagnostico lo exija de verdad (y en ese caso, decis por que).",
      "Tenes busqueda web (web_search) para datos actuales en linea, y ejecucion",
      "de codigo (code_execution) para GENERAR archivos cuando el usuario lo pida:",
      "graficos/imagenes (matplotlib/PIL -> PNG), planillas (openpyxl -> xlsx),",
      "documentos (python-docx -> docx, reportlab -> pdf). Genera el archivo y",
      "ofrecelo para descargar; no pegues el contenido binario en el chat.",
      "Para preguntas de informacion general o actual (eventos, noticias, clima,",
      "lugares, datos del mundo real) NO digas que 'no esta disponible': usa",
      "web_search y responde con lo que encuentres, citando la fuente.",
    ].join("\n"),
  },
};

// Sub-agente por defecto cuando el router no puede decidir con confianza.
// Elegimos "operativo" (Sonnet, todas las tools) a proposito: nunca dejamos una
// tarea potencialmente operativa en manos del tier mas debil.
export const DEFAULT_SUB_AGENT: SubAgentId = "operativo";

// Mapea el tier que devuelve el clasificador al sub-agente correspondiente.
export const TIER_TO_SUB_AGENT: Record<SubAgentTier, SubAgentId> = {
  quick: "consulta",
  standard: "operativo",
  deep: "analista",
};
