import { Tool } from "../../tools/tools.model";
import { feedbackService } from "../../feedback/feedback.service";
import { sanitizeMessage } from "../conversations.model";
import {
  getLlmClient,
  modelFor,
  modelRank,
  serverToolSupport,
  thinkingBlockFor,
  withReasoningHeadroom,
} from "../../../shared/llm/provider";
import {
  ADD_IMAGE_TO_LIBRARY_TOOL_SCHEMA,
  CAPTURE_FEEDBACK_TOOL_SCHEMA,
  LOAD_SKILL_TOOL_SCHEMA,
  executeTool,
  resolveTools,
  toolIdsHaveWrites,
  ToolExecutionError,
  type AnthropicTool,
  type ToolErrorKind,
} from "./toolExecutor";
import { loadSkillBody } from "../../../engine/skills/resolver";
import {
  defaultProfile,
  type ToolChoice,
  type TurnProfile,
} from "./turnProfile";
import {
  PROPOSE_GROWTH_PLAN,
  runProposeGrowthPlan,
  type PlanToolContext,
} from "../../growth/plan/planTool";
import { checkToolCall } from "./toolAccess";
import { evaluateAccess } from "../../../shared/agentAuth/routePolicy";
import type { UserScope } from "../../../shared/agentAuth/userScope";
import { pmsRequest, PmsProxyError } from "../../../shared/middleware/pmsProxy";
import { mintAgentJwt } from "../../../shared/agentAuth/agentJwt";
import { confirmationFor } from "./confirmationPolicy";
import { normalizeToolSchema } from "../../../shared/llm/toolSchema";
import { randomUUID } from "crypto";

/**
 * Cuánto vive una confirmación pendiente. Corta pero no molesta: si el usuario
 * deja la pestaña abierta y vuelve mañana, el borrado que pidió ayer no se
 * ejecuta con un click distraído — tiene que volver a pedirlo.
 */
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

const MAX_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS ?? 5);

// Kill-switch de las server tools de Anthropic. Si la org no tiene habilitada
// web search / code execution, prenderlas haría fallar todos los turnos de los
// tiers que las usan: apagar con ROOMBIR_WEB_SEARCH=false / ROOMBIR_CODE_EXEC=false.
const WEB_SEARCH_ON =
  (process.env.ROOMBIR_WEB_SEARCH ?? process.env.LAUPSER_WEB_SEARCH ?? "true").toLowerCase() !== "false";
const CODE_EXEC_ON =
  (process.env.ROOMBIR_CODE_EXEC ?? process.env.LAUPSER_CODE_EXEC ?? "true").toLowerCase() !== "false";

// Piso de capacidad para agentes operativos (con tools de escritura/PMS). Un
// modelo del tier barato no orquesta tools de forma confiable: deflexiona
// a texto plano (no llama la tool -> la UI no puede renderizar cards porque no
// hay tool result) y alucina datos. Por eso, para agentes operativos elevamos
// el modelo a este piso aunque el modelOverride apunte mas abajo. Es a nivel
// runtime a proposito: no se puede foot-gunear desde la UI/DB. Los agentes de
// solo-lectura / KB / Q&A NO son operativos y conservan su override economico.
const OPERATIONAL_MODEL_FLOOR =
  process.env.OPERATIONAL_MODEL_FLOOR ?? modelFor("standard");

// El rango de capacidad vive en shared/llm/provider.ts: se ordena por TIER, no
// por el nombre del modelo. Ordenar por nombre funcionaba mientras todos los
// modelos eran de la misma familia ("haiku" < "sonnet" < "opus"); con un
// catalogo de varios proveedores no hay subcadena que sirva, y un rango mal
// leido desactiva el piso justo en el turno que lo necesitaba.

// Aplica el piso operativo sobre el modelo YA enrutado y las tools EFECTIVAS
// del turno. Si el turno lleva tools de escritura, el modelo nunca baja del
// piso (tier estandar), aunque el router haya elegido un tier mas economico.
// Turnos de solo-lectura conservan el modelo enrutado (ej. el barato para
// "consulta").
async function applyOperationalFloor(
  model: string,
  toolIds: string[],
): Promise<string> {
  if (modelRank(model) >= modelRank(OPERATIONAL_MODEL_FLOOR)) return model;
  const hasWrites = await toolIdsHaveWrites(toolIds);
  if (!hasWrites) return model;
  console.warn(
    `[conversationRunner] turno con tools de escritura y modelo "${model}" por debajo del ` +
    `piso; elevando a "${OPERATIONAL_MODEL_FLOOR}". Un modelo debil no orquesta writes de forma confiable.`,
  );
  return OPERATIONAL_MODEL_FLOOR;
}

interface AgentLike {
  agentId: string;
  modelOverride?: string | null;
  enabledToolIds: string[];
  /** Habilidades declaradas en la versión (selector de `resolveSkills`). */
  skillNames?: string[];
  feedbackCapture: { enabled: boolean; confirmWithUser: boolean };
  limits: { maxTokensPerTurn: number };
}

interface SessionLike {
  sessionId: string;
  context: {
    userId?: string;
    companyId?: string;
    propertyId?: string;
    userRole?: string;
  };
  feedbackRequestIds: string[];
  pendingConfirmation:
  | {
    toolId: string;
    toolName: string;
    inputArgs: Record<string, unknown>;
    requestedAt: Date;
  }
  | null;
  save: () => Promise<unknown>;
}

interface ToolExecutionMeta {
  toolId: string;
  toolName: string;
  inputArgs: Record<string, unknown>;
  outcome:
  | "success"
  | "error"
  | "cancelled_by_user"
  | "pending_confirmation";
  result?: unknown;
  errorMessage?: string;
  durationMs: number;
  retried: boolean;
}

interface RagChunkMeta {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  score: number;
}

// Archivo que la IA generó este turno vía code_execution (gráfico, imagen,
// docx/xlsx/pdf, etc.). Se entrega al cliente como file_id descargable.
export interface GeneratedFile {
  fileId: string;
  filename?: string;
  mediaType?: string;
}

// Fuente web (link) que la IA consultó vía web_search este turno.
export interface WebSource {
  title: string;
  url: string;
}

// Extrae los resultados de web_search del response (title + url). El SDK 0.27.x
// no tipa estos bloques → acceso defensivo.
function collectWebSources(content: unknown[]): WebSource[] {
  const out: WebSource[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; content?: unknown };
    if (block?.type !== "web_search_tool_result") continue;
    const items = Array.isArray(block.content) ? block.content : [];
    for (const it of items as Array<Record<string, unknown>>) {
      const url = it.url as string | undefined;
      if (typeof url === "string") {
        out.push({ url, title: (it.title as string) || url });
      }
    }
  }
  return out;
}

// Extrae los file_id que dejó la herramienta de ejecución de código en el
// response. El SDK 0.27.x no tipa estos bloques → acceso defensivo.
function collectGeneratedFiles(content: unknown[]): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  for (const raw of content) {
    const block = raw as {
      type?: string;
      content?: { content?: Array<Record<string, unknown>> };
    };
    if (block?.type !== "bash_code_execution_tool_result") continue;
    const items = Array.isArray(block.content?.content)
      ? block.content!.content!
      : [];
    for (const it of items) {
      const fileId = it.file_id as string | undefined;
      if (typeof fileId === "string") {
        out.push({
          fileId,
          filename: (it.filename as string) || undefined,
          mediaType: (it.media_type as string) || undefined,
        });
      }
    }
  }
  return out;
}

// Outcome de cada server tool del response, indexado por el id del bloque
// `server_tool_use`. Anthropic devuelve el resultado en un bloque
// `*_tool_result` (con `tool_use_id`) cuyo `content` es un objeto
// `{ type: "..._error" }` cuando falló, y un array/objeto normal si anduvo.
// Acceso defensivo: el SDK 0.27.x no tipa estos bloques.
function collectServerToolOutcomes(content: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content) {
    const block = raw as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
    };
    if (!block?.type || !block.type.endsWith("_tool_result")) continue;
    if (typeof block.tool_use_id !== "string") continue;
    const inner = block.content as { type?: string } | unknown[] | undefined;
    const failed =
      !!inner &&
      !Array.isArray(inner) &&
      typeof inner === "object" &&
      typeof inner.type === "string" &&
      inner.type.endsWith("_error");
    out.set(block.tool_use_id, failed ? "error" : "success");
  }
  return out;
}

// Evento de progreso del turno que se stremea al cliente. Es status de alto
// nivel (qué está haciendo la IA), NO el razonamiento interno del modelo.
export interface StepEvent {
  kind: "tool_start" | "tool_done" | "server_tool";
  toolName: string;
  label: string;
  status?: "ok" | "error";
}

// Ítem de la transcripción del turno, en el orden en que ocurrió: cada texto
// que el modelo escribió ANTES de llamar a una herramienta (el "voy a
// consultar…") y cada herramienta que corrió. El texto de cierre NO va acá:
// es `TurnResult.content`. Se persiste en agentMeta.trace para que la UI pueda
// mostrar el mismo hilo (texto → paso → texto → …) al releer la conversación,
// no solo en vivo. Antes ese texto intermedio se descartaba y el usuario veía
// desaparecer lo que la IA había escrito.
export type TurnTraceItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; label: string; outcome: string };

// Adjunto del usuario disponible para la tool interna de librería.
export interface TurnAttachment {
  kind: "image" | "document";
  name?: string;
  mediaType: string;
  dataB64: string;
}

// Label en gerundio (español) para el status del paso, derivado del nombre de
// la tool. Evita exponer args/jerga; solo "qué está haciendo".
/**
 * ¿Esta llamada se puede correr en paralelo con otras del mismo response?
 *
 * Sólo las lecturas del catálogo (GET, categoría no-write, no destructiva). Las
 * internas quedan fuera a propósito aunque algunas sean inocuas: `load_skill`
 * podría paralelizarse, pero el beneficio es nulo (el modelo carga una sola) y
 * el riesgo de que alguien agregue una interna con efectos y la herede, no.
 *
 * Ante la duda devuelve false: ejecutar en serie algo que podía ir en paralelo
 * cuesta latencia; paralelizar algo que dependía del anterior corrompe datos.
 */
const INTERNAL_TOOL_NAMES = new Set([
  "load_skill",
  "capture_feedback_request",
  "add_image_to_library",
  PROPOSE_GROWTH_PLAN,
]);

async function isReadOnlyCall(toolName: string): Promise<boolean> {
  if (INTERNAL_TOOL_NAMES.has(toolName)) return false;
  try {
    const tool = await Tool.findOne(
      { name: toolName, status: "active" },
      { category: 1, "execution.method": 1, "permissions.isDestructive": 1 },
    ).lean();
    if (!tool) return false;
    return (
      tool.execution?.method === "GET" &&
      !/(_write$|^raw_write$)/.test(tool.category) &&
      tool.permissions?.isDestructive !== true
    );
  } catch {
    return false;
  }
}

function stepLabelForTool(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === PROPOSE_GROWTH_PLAN) return "Armando el plan…";
  if (n === "add_image_to_library") return "Guardando en la librería…";
  if (n === "load_skill") return "Repasando el procedimiento…";
  if (n === "global_search" || n === "search_reservations") return "Buscando…";
  if (/linkhub/.test(n)) return "Revisando el LinkHub…";
  if (/(social|gbp|ota_|visibility)/.test(n)) return "Revisando la presencia online…";
  if (/brand/.test(n)) return "Revisando la identidad de marca…";
  if (/(unit_block)/.test(n)) return "Revisando bloqueos de habitación…";
  if (/(day_restriction)/.test(n)) return "Revisando restricciones por día…";
  if (/(_site_|site_|_sites$|domains)/.test(n)) return "Revisando sitios web…";
  if (/(company_user|space_user|find_user)/.test(n)) return "Revisando el equipo…";
  if (/(reserv|booking)/.test(n)) return "Buscando reservas…";
  if (/(avail|disponibil)/.test(n)) return "Consultando disponibilidad…";
  if (/(categor)/.test(n)) return "Revisando categorías…";
  if (/(unit|habitac|room)/.test(n)) return "Revisando habitaciones…";
  if (/(rate|tarifa|price|precio)/.test(n)) return "Consultando tarifas…";
  if (/(report|inform)/.test(n)) return "Generando reporte…";
  if (/(guest|huesped|client)/.test(n)) return "Buscando datos del huésped…";
  if (/(list|get|read|search|find|consult)/.test(n)) return "Buscando información…";
  if (/(write|update|create|edit|delete|set)/.test(n)) return "Aplicando cambios…";
  return "Procesando…";
}

export interface TurnResult {
  content: string;
  // Transcripción ordenada del turno (textos intermedios + herramientas). Ver
  // TurnTraceItem. Vacía si el modelo respondió de una sola pasada.
  trace: TurnTraceItem[];
  toolsExecuted: ToolExecutionMeta[];
  ragChunksUsed: RagChunkMeta[];
  inputTokens: number;
  outputTokens: number;
  // Tokens servidos desde el prompt cache (~0.1x) y escritos al cache (~1.25x).
  // Útiles para medir el ahorro: input efectivo = inputTokens + estos.
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  // Archivos que la IA generó este turno (descargables vía Files API).
  generatedFiles: GeneratedFile[];
  // Fuentes web consultadas (web_search) este turno.
  webSources: WebSource[];
  latencyMs: number;
  stopReason: string;
  modelUsed: string;
  /**
   * Telemetría del turno estratégico. Responde "¿el plan salió de la foto o el
   * modelo improvisó?" sin tener que leer la transcripción — que es la única
   * forma de saber si esto sigue funcionando dentro de tres meses.
   */
  strategic?: StrategicTurnMeta;
}

export interface StrategicTurnMeta {
  snapshotMs: number;
  missing: string[];
  playbookIds: string[];
  leverCount: number;
  stepsProposed: number;
  stepsDropped: number;
  planId?: string;
  /** El modelo cerró sin entregar el plan y hubo que forzarlo. */
  forced: boolean;
}

interface RunTurnInput {
  session: SessionLike;
  agent: AgentLike;
  // Prompt partido para cachear el prefijo estable (ver promptAssembler):
  // systemStatic se cachea junto con las tools; systemDynamic + specialization
  // van después del breakpoint, sin cachear.
  systemStatic: string;
  systemDynamic: string;
  history: Array<{ role: "user" | "assistant"; content: unknown }>;
  // Texto plano del turno (para feedback/historial/router).
  userMessage: string;
  // Contenido real enviado al modelo: string, o bloques (imágenes/PDF/CSV +
  // texto) cuando el usuario adjuntó archivos. Si falta, se usa userMessage.
  userContent?: unknown;
  ragChunksUsed: RagChunkMeta[];
  // Decididos por el router (taskRouter). El modelo pasa por el piso operativo;
  // las tools son las efectivas del turno; specialization se suma al prompt.
  model: string;
  toolIds: string[];
  specialization?: string;
  // Server tools habilitadas por el sub-agente.
  webSearch?: boolean;
  codeExec?: boolean;
  // Adjuntos del usuario de este turno (para la tool interna de librería).
  attachments?: TurnAttachment[];
  // Habilidades resueltas para este turno. Si hay al menos una, se ofrece
  // `load_skill` para traer su cuerpo (nivel 2 de la revelación progresiva).
  hasSkills?: boolean;
  // Alcance efectivo del usuario (rol, capabilities, apps del espacio,
  // propiedades) resuelto contra el PMS al inicio del turno. Se evalúa en CADA
  // tool call (ver toolAccess.checkToolCall): las tools que el usuario no puede
  // usar ya no se ofrecen (conversations.service las filtra), pero el path de
  // las crudas lo elige el modelo y hay que validarlo acá. Sin scope (agente
  // sin usuario) no se aplica la política y manda el PMS.
  scope?: UserScope | null;
  // Callback de progreso: emite un StepEvent por cada paso (ejecución de tool).
  // Lo consume el endpoint SSE para stremear el status al cliente.
  onStep?: (e: StepEvent) => void;
  // Texto de la respuesta EN VIVO: un delta por cada trozo que emite el modelo.
  // Lo consume el endpoint SSE para que el cliente pinte la respuesta a medida
  // que se escribe (en vez de esperar el mensaje completo).
  onDelta?: (text: string) => void;
  // El texto stremeado hasta ahora quedó cerrado como segmento intermedio de
  // la transcripción: el modelo va a ejecutar una herramienta (o el server
  // loop pausó) y lo que venga después es OTRO segmento. El cliente no lo
  // borra: lo deja fijo y abre un borrador nuevo para el texto siguiente.
  onTextEnd?: () => void;
  /**
   * Parámetros del loop para este turno (iteraciones, tool_choice, cierre sin
   * tools). Omitirlo deja el comportamiento de siempre.
   */
  profile?: TurnProfile;
  /**
   * Contexto del turno estratégico: la foto, los playbooks ofrecidos y el
   * índice de palancas. Lo arma `strategicTurn.prepare()`. Su presencia es lo
   * que habilita la tool `propose_growth_plan`.
   */
  planContext?: PlanToolContext;
  /** Telemetría de la preparación (lo que tardó la foto y qué faltó). */
  strategicMeta?: Pick<StrategicTurnMeta, "snapshotMs" | "missing" | "playbookIds" | "leverCount">;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const start = Date.now();
  const { session, agent, history, userMessage } = input;
  const profile = input.profile ?? defaultProfile();

  // System como bloques: el prefijo estable lleva cache_control (prompt cache);
  // lo volátil (contexto/RAG/memoria + especialización del sub-agente) va en un
  // bloque posterior sin cachear. Render order = tools -> system -> messages, así
  // que UN breakpoint sobre el bloque estático cachea tools + prefijo estable y
  // se reusa en cada iteración del loop y entre turnos del mismo tier (TTL 5m).
  const dynamicSystem = [input.systemDynamic, input.specialization]
    .filter((s) => s && s.trim())
    .join("\n\n---\n\n");
  const system: any[] = [];
  if (input.systemStatic && input.systemStatic.trim()) {
    system.push({
      type: "text",
      text: input.systemStatic,
      cache_control: { type: "ephemeral" },
    });
  }
  if (dynamicSystem) {
    system.push({ type: "text", text: dynamicSystem });
  }

  const messages: any[] = [
    ...history,
    { role: "user", content: (input.userContent ?? userMessage) as any },
  ];

  // Tools efectivas del turno (las que el router dejo en alcance).
  const tools: AnthropicTool[] = await resolveTools(input.toolIds);
  // En el turno estratégico NO se ofrece registrar pedidos de funcionalidad.
  // Medido en un turno real: ante "no entiendo nada, quiero más ocupación" el
  // modelo la usó para anotar el pedido como feature faltante, gastando una de
  // las pocas iteraciones. La plataforma SÍ tiene con qué contestar eso; lo que
  // falta no es una función, es el plan.
  if (agent.feedbackCapture.enabled && !input.planContext) {
    tools.push(CAPTURE_FEEDBACK_TOOL_SCHEMA);
  }
  // Solo ofrecemos la tool de librería si el usuario adjuntó una imagen en este
  // turno (si no, no hay bytes que subir y no tiene sentido ofrecerla).
  const turnAttachments = input.attachments ?? [];
  const hasImageAttachment = turnAttachments.some((a) => a.kind === "image");
  if (hasImageAttachment) {
    tools.push(ADD_IMAGE_TO_LIBRARY_TOOL_SCHEMA);
  }
  // Sin habilidades visibles la tool no tiene nada que cargar: ofrecerla igual
  // sólo invita al modelo a llamarla y recibir un error.
  if (input.hasSkills) {
    tools.push(LOAD_SKILL_TOOL_SCHEMA);
  }
  // Tools internas del perfil (hoy: `propose_growth_plan` en el estratégico).
  for (const t of profile.internalTools ?? []) tools.push(t);

  // Las internas se declaran en código y hasta ahora viajaban CRUDAS: sólo las
  // del catálogo pasaban por el normalizador. Un `enum` numérico en una de
  // ellas hacía que el proveedor devolviera sus argumentos vacíos, sin error —
  // que es exactamente cómo se rompió `propose_growth_plan` la primera vez.
  // Estar escritas a mano no las hace correctas; las hace menos revisadas.
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as AnthropicTool;
    if (t?.input_schema) {
      tools[i] = { ...t, input_schema: normalizeToolSchema(t.input_schema) };
    }
  }

  const toolsExecuted: ToolExecutionMeta[] = [];
  const trace: TurnTraceItem[] = [];
  const generatedFiles: GeneratedFile[] = [];
  const webSources: WebSource[] = [];
  const seenSourceUrls = new Set<string>();

  // Texto del segmento ABIERTO: lo que el modelo escribió desde la última
  // frontera (arranque del turno o última herramienta). Al cruzar una
  // herramienta se cierra como ítem de la transcripción; al terminar el turno,
  // lo que quede abierto es la respuesta de cierre (content).
  let openText = "";
  const closeText = () => {
    const text = openText.trim();
    openText = "";
    if (!text) return;
    trace.push({ kind: "text", text });
    input.onTextEnd?.();
  };
  let totalIn = 0;
  let totalOut = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let stopReason = "";
  // El modelo viene enrutado; el piso operativo lo eleva si el turno lleva writes.
  const modelUsed = await applyOperationalFloor(input.model, input.toolIds);

  // Server tools: web_search para responder con info en línea, code_execution
  // para GENERAR archivos (gráficos/imágenes con matplotlib/PIL, docx/xlsx/pdf).
  // Corren del lado del proveedor, así que qué está disponible lo dice
  // `serverToolSupport` con lo que se midió, no el nombre del modelo.
  const serverTools = serverToolSupport(modelUsed);
  if (input.webSearch && serverTools.webSearch && WEB_SEARCH_ON) {
    (tools as unknown[]).push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    });
  }
  if (input.codeExec && CODE_EXEC_ON) {
    if (serverTools.codeExecution) {
      (tools as unknown[]).push({
        type: "code_execution_20260120",
        name: "code_execution",
      });
    } else {
      // Se omite en silencio a propósito: mandarla contra un proveedor que no
      // la ejecuta devuelve 400 y se lleva puesto el turno entero, cuando lo
      // único que se pierde por omitirla es la generación de archivos.
      console.warn(
        `[conversationRunner] code_execution pedida pero no disponible para "${modelUsed}"; ` +
        `el turno sigue sin ella (LLM_CODE_EXECUTION=on para forzarla).`,
      );
    }
  }

  const client = getLlmClient();

  // Estado del turno estratégico. `planOutcome` se llena cuando el modelo
  // entrega el plan; el loop lo mira para decidir si todavía hace falta forzar
  // la tool.
  let planOutcome: Awaited<ReturnType<typeof runProposeGrowthPlan>> | null = null;
  let planForced = false;
  const toolsUsed: string[] = [];

  for (let iter = 0; iter < profile.maxIterations; iter++) {
    // Usamos el stream del SDK con dos fines: (1) reenviar EN VIVO los deltas
    // de texto al cliente (onDelta) para que la respuesta se pinte a medida que
    // el modelo escribe, y (2) detectar cuándo arrancan las server tools
    // (web_search / code_execution) y emitir su step apenas empiezan. La
    // respuesta final (persistida) se sigue armando con finalMessage().
    // Cada herramienta (propia o server tool) es una frontera de segmento: el
    // texto acumulado hasta ahí se cierra en la transcripción (closeText) y el
    // cliente lo deja fijo en pantalla en vez de borrarlo.
    // Server tools (web_search / code_execution) corren dentro del response de
    // Anthropic: no hay tool_result nuestro que marque el resultado. Anotamos
    // el ítem al arrancar y, terminado el response, le corregimos el outcome
    // si el bloque de resultado vino con error.
    const iterServerTools = new Map<
      string,
      Extract<TurnTraceItem, { kind: "tool" }>
    >();
    // Consumo leído del alambre, no del mensaje que arma el SDK.
    //
    // OpenRouter manda `message_start` con el usage en CERO y recién informa los
    // totales en `message_delta`; el acumulador del SDK 0.27.x se queda con el
    // primero para la entrada, así que `finalMessage().usage.input_tokens`
    // vuelve en cero y el ledger factura de menos cada turno del chat. Se toma
    // el máximo visto de cada campo y se usa si el mensaje final vino vacío.
    const wireUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

    // `tool_choice` del perfil. En el turno estratégico la primera vuelta
    // obliga a usar alguna tool y la segunda fuerza la entrega del plan: sin
    // eso el modelo escribe tres párrafos de consejos y cierra sin tarjeta,
    // que es exactamente el comportamiento que este rediseño corrige.
    const toolChoice: ToolChoice =
      tools.length > 0 ? profile.toolChoiceFor?.(iter, { used: toolsUsed }) : undefined;
    if (toolChoice?.type === "tool" && toolChoice.name === PROPOSE_GROWTH_PLAN) {
      // El modelo llegó a la segunda vuelta sin entregar el plan y hay que
      // forzárselo. Se anota para poder medirlo: si esto sube, el modelo del
      // tier no sirve para este perfil y hay que cambiarlo, no insistir.
      planForced = true;
    }

    // Razonamiento acotado. `withReasoningHeadroom` suma el margen POR ENCIMA
    // del pedido del consumidor: el razonamiento sale del mismo presupuesto de
    // salida, y un techo justo devuelve un mensaje sin bloque de texto y sin
    // error (trampa 2b de la migración a OpenRouter).
    const maxTokens = agent.limits.maxTokensPerTurn || 4096;
    const thinking = profile.thinkingBudget
      ? thinkingBlockFor(modelUsed, {
          enabled: true,
          budgetTokens: profile.thinkingBudget,
        })
      : undefined;

    const stream = client.messages.stream({
      model: modelUsed,
      max_tokens: profile.thinkingBudget
        ? withReasoningHeadroom(modelUsed, maxTokens)
        : maxTokens,
      ...(thinking ? { thinking } : {}),
      system: system as any,
      messages,
      tools: tools.length > 0 ? (tools as any) : undefined,
      ...(toolChoice ? { tool_choice: toolChoice as any } : {}),
    });
    stream.on("streamEvent", (event: any) => {
      if (event?.type === "message_start" || event?.type === "message_delta") {
        const u = event.usage ?? event.message?.usage;
        if (u) {
          const n = (v: unknown): number => (typeof v === "number" ? v : 0);
          wireUsage.input = Math.max(wireUsage.input, n(u.input_tokens));
          wireUsage.output = Math.max(wireUsage.output, n(u.output_tokens));
          wireUsage.cacheRead = Math.max(wireUsage.cacheRead, n(u.cache_read_input_tokens));
          wireUsage.cacheCreate = Math.max(
            wireUsage.cacheCreate,
            n(u.cache_creation_input_tokens),
          );
        }
      }
      // Delta de texto del modelo → directo al cliente.
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        const t = event.delta.text as string;
        if (t) {
          openText += t;
          input.onDelta?.(t);
        }
        return;
      }
      if (event?.type !== "content_block_start") return;
      const cb = event.content_block as {
        type?: string;
        name?: string;
        id?: string;
      };
      // Dos bloques de texto seguidos dentro del mismo segmento (puede pasar
      // tras un bloque no-texto que no es frontera): los separamos con "\n"
      // tanto en el texto persistido como en el stream.
      if (cb?.type === "text") {
        if (openText) {
          openText += "\n";
          input.onDelta?.("\n");
        }
        return;
      }
      if (cb?.type !== "server_tool_use") return;
      const name = (cb.name || "").toLowerCase();
      let step: StepEvent | null = null;
      if (name.includes("web_search")) {
        step = {
          kind: "server_tool",
          toolName: "web_search",
          label: "Buscando en la web…",
        };
      } else if (name.includes("code_execution") || name.includes("bash")) {
        step = {
          kind: "server_tool",
          toolName: "code_execution",
          label: "Generando documento…",
        };
      }
      if (!step) return;
      closeText();
      const item = {
        kind: "tool" as const,
        toolName: step.toolName,
        label: step.label,
        outcome: "success",
      };
      trace.push(item);
      if (typeof cb.id === "string") iterServerTools.set(cb.id, item);
      input.onStep?.(step);
    });
    const response = await stream.finalMessage();

    // Outcome real de las server tools de este response.
    if (iterServerTools.size > 0) {
      const outcomes = collectServerToolOutcomes(response.content as unknown[]);
      for (const [id, item] of iterServerTools) {
        const o = outcomes.get(id);
        if (o) item.outcome = o;
      }
    }

    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    // El mensaje final del SDK manda cuando trae algo; si vino en cero (ver
    // `wireUsage`), se usa lo que se leyó del stream. Nunca al revés: cuando el
    // proveedor sí completa el mensaje final, ese es el dato canónico.
    totalIn += usage.input_tokens || wireUsage.input;
    totalOut += usage.output_tokens || wireUsage.output;
    cacheRead += usage.cache_read_input_tokens ?? wireUsage.cacheRead;
    cacheCreate += usage.cache_creation_input_tokens ?? wireUsage.cacheCreate;
    stopReason = response.stop_reason ?? "";

    // Archivos generados por code_execution en este response. El step ya se
    // emitió en vivo desde el stream (content_block_start del server tool).
    for (const f of collectGeneratedFiles(response.content as unknown[])) {
      generatedFiles.push(f);
    }
    // Fuentes web consultadas (dedup por url).
    for (const s of collectWebSources(response.content as unknown[])) {
      if (!seenSourceUrls.has(s.url)) {
        seenSourceUrls.add(s.url);
        webSources.push(s);
      }
    }

    // pause_turn: el loop server-side de Anthropic (web_search / code_execution)
    // llegó a su límite de iteraciones. Reanudamos reenviando el assistant tal
    // cual; el server continúa donde quedó. No hay tool_result que agregar.
    if (stopReason === "pause_turn") {
      // El texto de esta pasada queda como segmento intermedio de la
      // transcripción; el cliente lo deja fijo y sigue con un borrador nuevo.
      closeText();
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUseBlocks = (response.content as any[]).filter(
      (b) => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      // Respuesta de cierre = el segmento que quedó abierto (lo escrito
      // después de la última herramienta). Si el modelo cerró el turno sin
      // texto tras la última herramienta (p. ej. generó un archivo y calló),
      // promovemos el último texto intermedio a respuesta para no persistir un
      // mensaje vacío: el historial y la memoria leen `content`.
      let text = openText.trim();
      openText = "";
      if (!text) {
        for (let i = trace.length - 1; i >= 0; i--) {
          const it = trace[i];
          if (it.kind === "text") {
            text = it.text;
            trace.splice(i, 1);
            break;
          }
        }
      }
      return {
        content: text,
        trace,
        toolsExecuted,
        ragChunksUsed: input.ragChunksUsed,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreate,
        generatedFiles,
        webSources,
        latencyMs: Date.now() - start,
        stopReason,
        modelUsed,
        strategic: strategicMeta(),
      };
    }

    // El preámbulo de texto que acompaña al tool_use ("Voy a consultar…") se
    // cierra como segmento intermedio de la transcripción: el cliente lo deja
    // en pantalla y debajo va viendo los pasos de las tools.
    closeText();

    // Persistimos el turno del assistant con tool_use en el historial local
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    // Las LECTURAS del mismo response corren en paralelo; las escrituras, en
    // serie y en el orden que el modelo pidió.
    //
    // El orden importa en las escrituras y no en las lecturas: crear una
    // categoría y después asignarle una unidad no se puede invertir, pero leer
    // reservas y leer el plano son independientes. Cuando el modelo pide cuatro
    // lecturas juntas —lo típico de un diagnóstico— esto convierte cuatro
    // esperas consecutivas en una.
    const readFlags = await Promise.all(
      toolUseBlocks.map((b: any) => isReadOnlyCall(b.name)),
    );
    const groups: Array<{ parallel: boolean; blocks: any[] }> = [];
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const isRead = readFlags[i];
      const last = groups[groups.length - 1];
      if (isRead && last?.parallel) last.blocks.push(toolUseBlocks[i]);
      else groups.push({ parallel: isRead, blocks: [toolUseBlocks[i]] });
    }

    const runOne = async (block: any) => {
      const label = stepLabelForTool(block.name);
      input.onStep?.({ kind: "tool_start", toolName: block.name, label });
      const handled = await handleToolCall(
        block,
        agent,
        session,
        input.userMessage,
        {
          attachments: turnAttachments,
          onStep: input.onStep,
          scope: input.scope ?? null,
          planContext: input.planContext,
        },
      );
      input.onStep?.({
        kind: "tool_done",
        toolName: block.name,
        label,
        status: handled.execMeta.outcome === "success" ? "ok" : "error",
      });
      return { block, label, handled };
    };

    for (const group of groups) {
      const done = group.parallel
        ? await Promise.all(group.blocks.map(runOne))
        : await (async () => {
            const out = [];
            for (const b of group.blocks) out.push(await runOne(b));
            return out;
          })();

      for (const { block, label, handled } of done) {
        trace.push({
          kind: "tool",
          toolName: block.name,
          label,
          outcome: handled.execMeta.outcome,
        });
        toolsExecuted.push(handled.execMeta);
        toolsUsed.push(block.name);
        if (handled.planOutcome?.ok) {
          planOutcome = handled.planOutcome;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(handled.output),
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  // ── Se acabaron las iteraciones ────────────────────────────────────────────
  //
  // Antes esto devolvía "no pude terminar, reformulá" y TIRABA todo lo leído:
  // el usuario esperaba cuarenta segundos, el turno ya estaba pago, y la
  // respuesta era pedirle que lo escriba de nuevo. Ahora se hace una pasada
  // final SIN tools para que el modelo cierre con lo que juntó. Es la misma
  // información, ordenada, en vez de nada.
  if (profile.finalizeWithoutTools && toolsExecuted.length > 0) {
    closeText();
    const closing = await finalizeWithoutTools({
      client,
      model: modelUsed,
      maxTokens: agent.limits.maxTokensPerTurn || 4096,
      system,
      messages,
    });
    if (closing) {
      totalIn += closing.inputTokens;
      totalOut += closing.outputTokens;
      cacheRead += closing.cacheReadTokens;
      cacheCreate += closing.cacheCreationTokens;
      if (closing.text) {
        return {
          content: closing.text,
          trace,
          toolsExecuted,
          ragChunksUsed: input.ragChunksUsed,
          inputTokens: totalIn,
          outputTokens: totalOut,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreate,
          generatedFiles,
          webSources,
          latencyMs: Date.now() - start,
          stopReason: "max_iterations_finalized",
          modelUsed,
          strategic: strategicMeta(),
        };
      }
    }
  }

  return {
    content:
      "Estoy procesando varias cosas a la vez y no pude terminar. Podes reformular tu pedido de forma mas simple?",
    trace,
    toolsExecuted,
    ragChunksUsed: input.ragChunksUsed,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    generatedFiles,
    webSources,
    latencyMs: Date.now() - start,
    stopReason: "max_iterations_reached",
    modelUsed,
    strategic: strategicMeta(),
  };

  /** Telemetría del turno estratégico, si lo fue. */
  function strategicMeta(): StrategicTurnMeta | undefined {
    if (!input.planContext || !input.strategicMeta) return undefined;
    return {
      ...input.strategicMeta,
      stepsProposed: planOutcome?.stepsProposed ?? 0,
      stepsDropped: planOutcome?.stepsDropped ?? 0,
      planId: planOutcome?.planId,
      forced: planForced,
    };
  }
}

/**
 * Pasada final sin tools: "cerrá con lo que tenés".
 *
 * Se le saca el `tools` al pedido a propósito. Dejárselas y pedirle por prompt
 * que no las use es una invitación a que las use, y ahí el turno queda colgado
 * con un tool_use que ya nadie va a ejecutar.
 */
async function finalizeWithoutTools(input: {
  client: ReturnType<typeof getLlmClient>;
  model: string;
  maxTokens: number;
  system: any[];
  messages: any[];
}): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null> {
  try {
    const res = await input.client.messages.create({
      model: input.model,
      max_tokens: Math.min(input.maxTokens, 1500),
      system: input.system as any,
      messages: [
        ...input.messages,
        {
          role: "user",
          content:
            "Cerrá el turno ACÁ con lo que ya averiguaste. No llames más herramientas. " +
            "Respondé lo que el usuario preguntó con los datos que tenés, y si algo quedó " +
            "sin resolver decilo en una línea al final.",
        },
      ],
    });
    const usage = res.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    return {
      text,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    };
  } catch (err) {
    console.warn(
      "[conversationRunner] el cierre sin tools falló:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

interface ToolHandleResult {
  output: unknown;
  execMeta: ToolExecutionMeta;
  /** Sólo `propose_growth_plan`: lo que quedó del plan tras validarlo. */
  planOutcome?: Awaited<ReturnType<typeof runProposeGrowthPlan>>;
}

interface ToolCallExtras {
  attachments: TurnAttachment[];
  onStep?: (e: StepEvent) => void;
  scope?: UserScope | null;
  planContext?: PlanToolContext;
}

async function handleToolCall(
  block: any,
  agent: AgentLike,
  session: SessionLike,
  rawUserMessage: string,
  extras: ToolCallExtras = { attachments: [] },
): Promise<ToolHandleResult> {
  const start = Date.now();
  const input = (block.input ?? {}) as Record<string, unknown>;

  // ---- Tool interna: add_image_to_library ----
  if (block.name === "add_image_to_library") {
    return handleAddImageToLibrary(block, agent, session, extras);
  }

  // ---- Tool interna: propose_growth_plan (turno estratégico) ----
  //
  // El modelo propone; acá se valida contra el catálogo real y los permisos del
  // usuario, se persiste y se devuelve el plan que la tarjeta va a dibujar. Sin
  // `planContext` la tool ni siquiera se ofreció, así que llegar acá sin él es
  // un bug del armado del turno, no del modelo.
  if (block.name === PROPOSE_GROWTH_PLAN) {
    if (!extras.planContext) {
      return {
        output: {
          error: true,
          message:
            "Esta herramienta sólo está disponible en un turno de planificación.",
        },
        execMeta: {
          toolId: "internal-growth-plan",
          toolName: PROPOSE_GROWTH_PLAN,
          inputArgs: input,
          outcome: "error",
          errorMessage: "sin contexto de plan",
          durationMs: Date.now() - start,
          retried: false,
        },
      };
    }
    const outcome = await runProposeGrowthPlan(input, extras.planContext);
    return {
      output: outcome.output,
      planOutcome: outcome,
      execMeta: {
        toolId: "internal-growth-plan",
        toolName: PROPOSE_GROWTH_PLAN,
        inputArgs: input,
        outcome: outcome.ok ? "success" : "error",
        // El resultado va entero a la traza: es lo que la tarjeta re-renderiza
        // al retomar la conversación más tarde.
        result: outcome.ok ? (outcome.output as Record<string, unknown>) : undefined,
        errorMessage: outcome.ok ? undefined : (outcome.reason ?? "el plan no pasó la validación"),
        durationMs: Date.now() - start,
        retried: false,
      },
    };
  }

  // ---- Tool interna: load_skill (nivel 2 de la revelación progresiva) ----
  if (block.name === "load_skill") {
    const name = typeof input.name === "string" ? input.name : "";
    const res = await loadSkillBody(name, {
      // Los agentes de la plataforma no tienen inquilino: sirven a todos los
      // hoteles y acotan por deployment.allowedCompanyIds.
      tenantId: null,
      agentId: agent.agentId,
      userId: session.context.userId ?? null,
      declared: agent.skillNames ?? [],
    });
    return {
      output: res.ok
        ? { skill: res.name, instructions: res.body }
        : { error: true, message: res.error },
      execMeta: {
        toolId: "internal-skill",
        toolName: "load_skill",
        inputArgs: input,
        outcome: res.ok ? "success" : "error",
        // El cuerpo puede ser largo: en la traza guardamos sólo qué se cargó.
        result: res.ok ? { skill: res.name } : undefined,
        errorMessage: res.ok ? undefined : res.error,
        durationMs: Date.now() - start,
        retried: false,
      },
    };
  }

  // ---- Tool interna: capture_feedback_request ----
  if (block.name === "capture_feedback_request") {
    try {
      const fb = await feedbackService.create({
        agentId: agent.agentId,
        sessionId: session.sessionId,
        companyId: session.context.companyId,
        propertyId: session.context.propertyId,
        rawUserMessage:
          (input.rawUserMessage as string) ?? rawUserMessage,
        agentResponse: "",
        classification: {
          intent: input.intent as string,
          category: input.category as string,
          confidence: input.confidence as string,
          summary: input.summary as string,
        },
        userConfirmed: (input.userConfirmed as boolean) ?? true,
      });
      session.feedbackRequestIds.push(fb.feedbackId);
      return {
        output: { status: "registered", feedbackId: fb.feedbackId },
        execMeta: {
          toolId: "internal-feedback",
          toolName: "capture_feedback_request",
          inputArgs: input,
          outcome: "success",
          result: { feedbackId: fb.feedbackId },
          durationMs: Date.now() - start,
          retried: false,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      return {
        output: { error: true, message: msg },
        execMeta: {
          toolId: "internal-feedback",
          toolName: "capture_feedback_request",
          inputArgs: input,
          outcome: "error",
          errorMessage: msg,
          durationMs: Date.now() - start,
          retried: false,
        },
      };
    }
  }

  // ---- Tools normales ----
  const tool = await Tool.findOne({ name: block.name });
  if (!tool) {
    return {
      output: { error: true, message: `Tool desconocida: ${block.name}` },
      execMeta: {
        toolId: "unknown",
        toolName: block.name,
        inputArgs: input,
        outcome: "error",
        errorMessage: "tool_not_found",
        durationMs: Date.now() - start,
        retried: false,
      },
    };
  }

  // Política de acceso: rol + capability + app del espacio + propiedad, con el
  // alcance FRESCO del usuario (ver toolAccess/routePolicy). Es la misma cadena
  // que corre el PMS (authorize → capability → requireSpaceAccess), evaluada
  // ANTES de pegarle, y además cubre lo que el PMS deja pasar (rutas de
  // pms-core que sólo piden estar autenticado). Para las tools crudas el path
  // lo eligió el modelo, así que se evalúa sobre el path real. Si el usuario no
  // está en alcance no se ejecuta nada y el modelo recibe el motivo exacto para
  // decírselo (no "no existe esa función"). executeTool vuelve a evaluar lo
  // mismo (punto único de corte para todos los runtimes); acá se hace antes
  // para devolver un tool_result con code + mensaje sin pasar por el mapeo de
  // errores.
  //
  // La seguridad real la sigue haciendo el PMS: si esta política queda vieja
  // (membership recién revocada), el PMS responde 403 abajo y lo mapeamos a
  // "permisos insuficientes".
  if (extras.scope) {
    const decision = checkToolCall(tool as any, input, extras.scope, {
      propertyId: session.context.propertyId,
      companyId: session.context.companyId,
    });
    if (!decision.allowed) {
      const code = decision.code ?? "insufficient_permissions";
      return {
        output: {
          error: true,
          code,
          message: decision.message ?? `No tenes permisos para usar "${tool.displayName ?? tool.name}".`,
        },
        execMeta: {
          toolId: tool.toolId,
          toolName: tool.name,
          inputArgs: input,
          outcome: "error",
          errorMessage: `${code}: ${decision.reason}`,
          durationMs: Date.now() - start,
          retried: false,
        },
      };
    }
  } else {
    // Sesión sin usuario verificado (agentes públicos): sólo queda el pre-check
    // legacy por rol declarado en la tool.
    const userRole = session.context.userRole;
    if (
      userRole &&
      tool.permissions.requiredRoles.length > 0 &&
      !(tool.permissions.requiredRoles as string[]).includes(userRole)
    ) {
      return {
        output: {
          error: true,
          code: "insufficient_permissions",
          message: `No tenes permisos para usar "${tool.displayName ?? tool.name}". Esta accion requiere rol ${tool.permissions.requiredRoles.join(" o ")}; el tuyo es ${userRole}.`,
        },
        execMeta: {
          toolId: tool.toolId,
          toolName: tool.name,
          inputArgs: input,
          outcome: "error",
          errorMessage: "insufficient_permissions",
          durationMs: Date.now() - start,
          retried: false,
        },
      };
    }
  }

  // ── Confirmacion ─────────────────────────────────────────────────────────
  // Dos regimenes, a proposito (ver confirmationPolicy.ts):
  //
  //  (a) La mayoria de las escrituras: la confirmacion la maneja el AGENTE en
  //      prosa. El gate de doble-pasada sobre TODA tool con requiresConfirmation
  //      se removio en su momento porque se acumulaba con la pregunta en prosa
  //      -> el usuario confirmaba 2-3 veces y el modelo se perdia. No volver.
  //
  //  (b) Borrados y acciones irreversibles: gate DURO. El runtime no ejecuta:
  //      guarda la llamada pendiente y devuelve una tarjeta que el chat
  //      renderiza con boton Confirmar (y, si es irreversible, un campo donde
  //      hay que escribir el nombre del recurso). El modelo no puede saltearlo
  //      porque no es una instruccion del prompt: es el runtime el que corta.
  const confirmation = confirmationFor(tool as any, input);
  if (confirmation.level !== "none") {
    const confirmationId = `cfm-${randomUUID()}`;
    session.pendingConfirmation = {
      toolId: tool.toolId,
      toolName: tool.name,
      inputArgs: input,
      requestedAt: new Date(),
      confirmationId,
      level: confirmation.level,
      subjectArg: confirmation.subjectArg ?? "",
      subjectValue: confirmation.subjectValue ?? "",
      reason: confirmation.reason,
      displayName: tool.displayName ?? tool.name,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    } as any;
    await session.save();

    const output = {
      status: "confirmation_required",
      confirmationId,
      tool: tool.name,
      displayName: tool.displayName ?? tool.name,
      level: confirmation.level,
      reason: confirmation.reason,
      subjectValue: confirmation.level === "typed" ? confirmation.subjectValue : undefined,
      args: input,
      message:
        confirmation.level === "typed"
          ? `NO se ejecuto nada. "${tool.displayName ?? tool.name}" es irreversible, asi que el usuario tiene que confirmarlo en una tarjeta escribiendo "${confirmation.subjectValue}". La tarjeta ya esta en pantalla: explicale en una o dos frases QUE se va a borrar o cambiar y que no hay vuelta atras, y esperá. NO vuelvas a llamar esta tool ni ninguna otra para esto.`
          : `NO se ejecuto nada. "${tool.displayName ?? tool.name}" borra informacion, asi que el usuario lo confirma en una tarjeta que ya esta en pantalla. Explicale en una frase que se va a borrar y esperá. NO vuelvas a llamar esta tool.`,
    };
    return {
      output,
      execMeta: {
        toolId: tool.toolId,
        toolName: tool.name,
        inputArgs: input,
        outcome: "success",
        // El payload completo va al `result` porque de ahí lo saca el chat para
        // dibujar la tarjeta (`blocksFromMessage`). Si acá quedara un resumen,
        // el usuario vería la explicación del agente sin el botón para confirmar.
        result: output,
        durationMs: Date.now() - start,
        retried: false,
      },
    };
  }

  // Reintentos: solo GET (1 retry, 500ms backoff). NUNCA reintentamos
  // writes para evitar duplicar efectos. 401/403 tampoco se reintentan
  // (no cambia con retry).
  const maxAttempts = tool.execution.method === "GET" ? 2 : 1;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeTool(tool.name, input, {
        propertyId: session.context.propertyId,
        companyId: session.context.companyId,
        userId: session.context.userId,
        agentId: agent.agentId,
        sessionId: session.sessionId,
      });
      return {
        output: result,
        execMeta: {
          toolId: tool.toolId,
          toolName: tool.name,
          inputArgs: input,
          outcome: "success",
          result,
          durationMs: Date.now() - start,
          retried: attempt > 1,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const kind =
        err instanceof ToolExecutionError ? err.kind : ("unknown" as const);
      // Errores que no se reintentan: rol insuficiente / auth invalida /
      // 4xx semanticos. Cortamos el loop y mapeamos el mensaje abajo.
      if (
        kind === "forbidden" ||
        kind === "policy" ||
        kind === "unauthorized" ||
        kind === "validation" ||
        kind === "not_found" ||
        kind === "config"
      ) {
        break;
      }
      if (attempt < maxAttempts) await sleep(500);
    }
  }

  return buildToolErrorOutput(tool, input, lastError, start, maxAttempts > 1);
}

// Tool interna: sube una imagen adjunta del turno a la librería (Cloudinary +
// AssetLibrary de pms-core) y, opcionalmente, la agrega a las fotos de una
// categoría de rooms-app. Toma los bytes del adjunto (el modelo no los tiene).
async function handleAddImageToLibrary(
  block: any,
  agent: AgentLike,
  session: SessionLike,
  extras: ToolCallExtras,
): Promise<ToolHandleResult> {
  const start = Date.now();
  const input = (block.input ?? {}) as Record<string, unknown>;
  const mk = (
    outcome: ToolExecutionMeta["outcome"],
    result?: unknown,
    errorMessage?: string,
  ): ToolExecutionMeta => ({
    toolId: "internal-library",
    toolName: "add_image_to_library",
    inputArgs: input,
    outcome,
    result,
    errorMessage,
    durationMs: Date.now() - start,
    retried: false,
  });

  const idx = Number(input.attachmentIndex);
  const att = Number.isInteger(idx) ? extras.attachments[idx] : undefined;
  if (!att || att.kind !== "image") {
    return {
      output: {
        error: true,
        message:
          "No encontré una imagen adjunta en esa posición. Pedile al usuario que adjunte la imagen en este mensaje.",
      },
      execMeta: mk("error", undefined, "attachment_not_image"),
    };
  }

  const userId = session.context.userId;
  const companyId = session.context.companyId;
  const propertyId = session.context.propertyId;
  if (!userId) {
    return {
      output: { error: true, message: "No puedo identificar al usuario para subir a la librería." },
      execMeta: mk("error", undefined, "no_user"),
    };
  }

  // Misma política que cualquier tool: subir a la librería es escritura sobre
  // la app "libreria-archivos"; agregar la foto a una categoría es escritura
  // sobre "gestion-categorias" en rooms-app. Se valida ANTES de subir para no
  // dejar el archivo huérfano en Cloudinary cuando el segundo paso no está
  // permitido.
  if (extras.scope) {
    const wantsCategory =
      typeof input.addToCategoryId === "string" && input.addToCategoryId.trim();
    const checks = [
      evaluateAccess(extras.scope, {
        service: "pms-core",
        method: "POST",
        path: "/asset-library/files/upload-base64",
      }),
      ...(wantsCategory && propertyId
        ? [
            evaluateAccess(extras.scope, {
              service: "rooms-app",
              method: "PATCH",
              path: `/api/v1/properties/${propertyId}/categories/${input.addToCategoryId}`,
              propertyId,
            }),
          ]
        : []),
    ];
    const blocked = checks.find((c) => !c.allowed);
    if (blocked) {
      return {
        output: { error: true, code: blocked.code, message: blocked.message },
        execMeta: mk("error", undefined, `${blocked.code}: ${blocked.reason}`),
      };
    }
  }

  try {
    const agentJwt = await mintAgentJwt({
      userId,
      companyId,
      agentId: agent.agentId,
      sessionId: session.sessionId,
    });

    extras.onStep?.({
      kind: "server_tool",
      toolName: "add_image_to_library",
      label: "Subiendo a la librería…",
    });
    const uploaded = (await pmsRequest({
      service: "pms-core",
      method: "POST",
      path: "/asset-library/files/upload-base64",
      body: {
        dataB64: att.dataB64,
        mediaType: att.mediaType,
        name: (input.name as string) || att.name,
      },
      agentJwt,
    })) as any;
    const file = uploaded?.file ?? uploaded;
    const url: string | undefined = file?.url;
    const fileId: string | undefined = file?.fileId;
    if (!url) {
      return {
        output: { error: true, message: "La librería no devolvió la URL de la imagen subida." },
        execMeta: mk("error", undefined, "no_url"),
      };
    }

    let category: unknown;
    const categoryId =
      typeof input.addToCategoryId === "string" ? input.addToCategoryId.trim() : "";
    if (categoryId) {
      if (!propertyId) {
        return {
          output: {
            ok: true,
            fileId,
            url,
            warning:
              "Subí la imagen a la librería, pero no hay una propiedad activa para agregarla a la categoría.",
          },
          execMeta: mk("success", { fileId, url }),
        };
      }
      extras.onStep?.({
        kind: "server_tool",
        toolName: "add_image_to_library",
        label: "Agregando a la categoría…",
      });
      const cat = (await pmsRequest({
        service: "rooms-app",
        method: "GET",
        path: `/api/v1/properties/${propertyId}/categories/${categoryId}`,
        agentJwt,
      })) as any;
      const prevPhotos: string[] = Array.isArray(cat?.photos) ? cat.photos : [];
      const photos = [...prevPhotos, url];
      await pmsRequest({
        service: "rooms-app",
        method: "PATCH",
        path: `/api/v1/properties/${propertyId}/categories/${categoryId}`,
        body: { photos },
        agentJwt,
      });
      category = { categoryId, name: cat?.name, photosCount: photos.length };
    }

    return {
      output: {
        ok: true,
        fileId,
        url,
        category,
        message: category
          ? "Imagen guardada en la librería y agregada a las fotos de la categoría."
          : "Imagen guardada en la librería de la empresa.",
      },
      execMeta: mk("success", { fileId, url, category }),
    };
  } catch (err) {
    const status = err instanceof PmsProxyError ? err.status : undefined;
    const msg = err instanceof Error ? err.message : "Error desconocido";
    const friendly =
      status === 403
        ? "No tenés permisos para modificar esa categoría en este momento."
        : `No pude completar la subida a la librería: ${msg}`;
    return {
      output: { error: true, message: friendly },
      execMeta: mk("error", undefined, `library_error: ${msg}`),
    };
  }
}

interface ToolWithMeta {
  toolId: string;
  name: string;
  displayName?: string;
}

function buildToolErrorOutput(
  tool: ToolWithMeta,
  input: Record<string, unknown>,
  err: Error | null,
  startedAt: number,
  retried: boolean,
): ToolHandleResult {
  const kind: ToolErrorKind =
    err instanceof ToolExecutionError ? err.kind : "unknown";
  const status =
    err instanceof ToolExecutionError ? err.status : undefined;
  const displayName = tool.displayName ?? tool.name;

  // Mapeo de cada tipo a un mensaje accionable para el LLM. El agente lo
  // pasa al usuario; por eso evitamos jerga (status codes, stack traces).
  let message: string;
  let code: string;
  switch (kind) {
    case "unauthorized":
      // 401: el JWT delegado no fue aceptado. Indica problema de config
      // (AGENT_JWT_SECRET desincronizado entre internal y el PMS) — no
      // un error del usuario. Lo reportamos como tal para que el agente
      // no se confunda y pida "volver a logearse".
      message = `No pude autenticarme contra el sistema para ejecutar "${displayName}". Reporta este error al equipo roombir, no es algo que puedas resolver desde la conversacion.`;
      code = "auth_failed";
      break;
    case "forbidden":
      // 403: el PMS rechazo el rol. Puede ser membership revocada a mitad
      // de sesion o pre-check desactualizado. Mensaje claro al usuario.
      message = `No tenes permisos para ejecutar "${displayName}" en este momento. Si esto es inesperado, verifica con un administrador que sigas teniendo acceso a esta propiedad.`;
      code = "insufficient_permissions";
      break;
    case "policy": {
      // Rechazado por la politica de acceso del agente ANTES de pegarle al PMS:
      // el mensaje ya dice que permiso falta y quien puede otorgarlo. Se pasa
      // tal cual; el code especifico (missing_capability, insufficient_app_access…)
      // le sirve al modelo para no reintentar por otro camino.
      message = err?.message ?? `No tenes permisos para usar "${displayName}".`;
      const up = (err as ToolExecutionError | null)?.upstream as { code?: string } | undefined;
      code = up?.code ?? "insufficient_permissions";
      break;
    }
    case "not_found":
      message = `No encontre el recurso solicitado para "${displayName}". Verifica que los datos sean correctos.`;
      code = "not_found";
      break;
    case "validation":
      message = `Los datos para "${displayName}" no son validos: ${err?.message ?? "verifica los parametros"}.`;
      code = "validation_error";
      break;
    case "upstream":
      message = `El servicio que atiende "${displayName}" devolvio un error (${status ?? "5xx"}). Intenta de nuevo en unos minutos.`;
      code = "upstream_error";
      break;
    case "network":
      message = `No pude conectarme al servicio para ejecutar "${displayName}". Puede estar caido o haber problemas de red.`;
      code = "network_error";
      break;
    case "config":
      message = `"${displayName}" no esta configurada correctamente en el servidor. Reporta este error al equipo roombir.`;
      code = "server_misconfigured";
      break;
    default:
      message = `No pude completar "${displayName}": ${err?.message ?? "error desconocido"}.`;
      code = "unknown_error";
  }

  return {
    output: { error: true, code, message },
    execMeta: {
      toolId: tool.toolId,
      toolName: tool.name,
      inputArgs: input,
      outcome: "error",
      errorMessage: `${code}: ${err?.message ?? "unknown"}`,
      durationMs: Date.now() - startedAt,
      retried,
    },
  };
}

// Helper para que el controller pueda exportar tipos sin importar el SDK
export { sanitizeMessage };
