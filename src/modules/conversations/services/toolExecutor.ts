import { Tool, HTTP_METHODS } from "../../tools/tools.model";
import {
  pmsRequest,
  PmsProxyError,
} from "../../../shared/middleware/pmsProxy";
import {
  mintAgentJwt,
  AgentJwtError,
} from "../../../shared/agentAuth/agentJwt";
import { checkToolCall, resolveScopeForSession } from "./toolAccess";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const CAPTURE_FEEDBACK_TOOL_SCHEMA: AnthropicTool = {
  name: "capture_feedback_request",
  description:
    "Registra un pedido del usuario sobre algo que la plataforma no soporta todavia. Solo usar despues de confirmar con el usuario si feedbackCapture.confirmWithUser esta activo para este agente.",
  input_schema: {
    type: "object",
    properties: {
      rawUserMessage: {
        type: "string",
        description:
          "El mensaje exacto del usuario que origino este pedido",
      },
      intent: {
        type: "string",
        description:
          "Identificador corto del intent, ej: ota_integration_booking_com",
      },
      category: {
        type: "string",
        enum: [
          "integration",
          "payment",
          "reporting",
          "feature",
          "bug",
          "ui_ux",
          "other",
        ],
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      summary: {
        type: "string",
        description: "Resumen en una linea, en espanol",
      },
      userConfirmed: {
        type: "boolean",
        description:
          "Si el usuario confirmo explicitamente que se registre",
      },
    },
    required: [
      "rawUserMessage",
      "intent",
      "category",
      "confidence",
      "summary",
    ],
  },
};

// Tool interna manejada por el runtime (no pega a un endpoint via Tool.find):
// sube una imagen ADJUNTA por el usuario en este turno a la librería de la
// company (Cloudinary + AssetLibrary) y, opcionalmente, la agrega a las fotos
// de una categoría de habitaciones. El modelo no tiene los bytes de la imagen:
// los toma el runtime del adjunto del turno por `attachmentIndex`.
export const ADD_IMAGE_TO_LIBRARY_TOOL_SCHEMA: AnthropicTool = {
  name: "add_image_to_library",
  description:
    "Guarda en la librería de medios de la empresa una imagen que el usuario adjuntó en ESTE mensaje, y opcionalmente la agrega a las fotos de una categoría de habitaciones. Usar solo cuando el usuario pidió guardar/usar una imagen adjunta. No inventes attachmentIndex: 0 es el primer adjunto del mensaje.",
  input_schema: {
    type: "object",
    properties: {
      attachmentIndex: {
        type: "number",
        description:
          "Índice (base 0) de la imagen adjunta en el mensaje del usuario que se debe subir. La primera imagen es 0.",
      },
      name: {
        type: "string",
        description:
          "Nombre opcional para el archivo en la librería (ej. 'Frente Standard'). Si falta, se usa el nombre original.",
      },
      addToCategoryId: {
        type: "string",
        description:
          "Opcional. categoryId de la categoría de habitaciones a la que agregar esta imagen como foto. Resolvé el id con las tools de categorías antes de llamar.",
      },
    },
    required: ["attachmentIndex"],
  },
};

// Tool interna manejada por el runtime: NIVEL 2 de la revelación progresiva
// (§19). El prompt lista las habilidades disponibles con una línea cada una; el
// cuerpo completo — el instructivo — se paga sólo cuando el modelo decide que lo
// necesita y lo pide con esta tool. Sin ella, o metemos todos los instructivos
// en cada turno (caro) o el agente improvisa el procedimiento (que es lo que
// venía pasando con las rutinas de revenue).
export const LOAD_SKILL_TOOL_SCHEMA: AnthropicTool = {
  name: "load_skill",
  description:
    "Carga el instructivo completo de una de las habilidades listadas en 'Habilidades disponibles'. " +
    "Usala ANTES de encarar una tarea que una habilidad cubre (por ejemplo una revisión de revenue o " +
    "el diagnóstico de una fecha lenta): trae el procedimiento, el orden de lectura y las trampas conocidas. " +
    "No la llames por las dudas ni cargues varias a la vez: cargá la que corresponde a la tarea.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Nombre exacto de la habilidad, tal cual aparece en la lista de habilidades disponibles.",
      },
    },
    required: ["name"],
  },
};

export async function resolveTools(
  enabledToolIds: string[],
): Promise<AnthropicTool[]> {
  if (enabledToolIds.length === 0) return [];
  const tools = await Tool.find({
    toolId: { $in: enabledToolIds },
    status: "active",
  });
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: {
      type: "object",
      properties: t.inputSchema?.properties ?? {},
      required: t.inputSchema?.required ?? [],
    },
  }));
}

// Categorias de tools que implican OPERAR (escribir) sobre el PMS: cualquier
// `*_write` o la escritura cruda `raw_write`.
const WRITE_TOOL_CATEGORY = /(_write$|^raw_write$)/;

// True si el conjunto de tools dado incluye alguna de escritura o destructiva.
// Lo usa el piso de modelo del runner sobre las tools EFECTIVAS del turno (no
// sobre todo el catalogo del agente), para que un turno solo-lectura pueda
// correr en un modelo economico aunque el agente tenga write tools habilitadas.
export async function toolIdsHaveWrites(toolIds: string[]): Promise<boolean> {
  if (toolIds.length === 0) return false;
  const count = await Tool.countDocuments({
    toolId: { $in: toolIds },
    status: "active",
    $or: [
      { category: { $regex: WRITE_TOOL_CATEGORY } },
      { "permissions.isDestructive": true },
    ],
  });
  return count > 0;
}

// Subconjunto de solo-lectura: descarta tools de escritura/destructivas. Lo usa
// el sub-agente "consulta" para acotar el alcance del turno (y, de paso, evitar
// que el piso lo eleve de modelo).
export async function filterReadOnlyToolIds(
  toolIds: string[],
): Promise<string[]> {
  if (toolIds.length === 0) return [];
  const tools = await Tool.find(
    { toolId: { $in: toolIds }, status: "active" },
    { toolId: 1, category: 1, "permissions.isDestructive": 1 },
  );
  return tools
    .filter(
      (t) =>
        !WRITE_TOOL_CATEGORY.test(t.category) && !t.permissions?.isDestructive,
    )
    .map((t) => t.toolId);
}

// Un agente es "operativo" si tiene habilitada al menos una tool de escritura
// o destructiva. Estos agentes exigen criterio + orquestacion de tools (NL ->
// reads -> writes, pedir lo que falta). Se mantiene por compatibilidad; el
// runner ahora evalua el piso sobre las tools efectivas via toolIdsHaveWrites.
export async function agentHasOperationalTools(
  enabledToolIds: string[],
): Promise<boolean> {
  return toolIdsHaveWrites(enabledToolIds);
}

// Las tools del web-builder devuelven el doc Site completo, que incluye los
// ARBOLES DE COMPONENTES de cada pagina (el canvas del editor). Eso pesa
// cientos de KB y revienta el contexto del modelo (>200k tokens). Para
// lectura/navegacion el agente solo necesita ids, nombres, dominios, estados y
// metadata de paginas — NO los componentes. Stripeamos las llaves pesadas
// recursivamente antes de devolver el resultado al runtime.
const BUILDER_HEAVY_KEYS = new Set([
  "components",
  "siteGlobalPagesComponents",
  "topGlobalComponents",
  "bottomGlobalComponents",
  "componentsData",
  "pageLogic",
  "logic",
  "aiDiscovery",
]);
const SITE_REDUCE_TOOLS = new Set([
  "list_site_projects",
  "get_site_project",
  "get_site",
  "list_site_pages",
  "list_site_languages",
]);
function stripBuilderHeavy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripBuilderHeavy);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (BUILDER_HEAVY_KEYS.has(k)) continue;
      out[k] = stripBuilderHeavy(val);
    }
    return out;
  }
  return v;
}

export interface ExecuteContext {
  propertyId?: string;
  companyId?: string;
  userId?: string;
  // Para mintear el JWT delegado con claims trazables
  agentId?: string;
  sessionId?: string;
  // Saltear la política de acceso (sólo scripts de test/seed que ejecutan con
  // una identidad técnica). Por defecto, con userId presente, SIEMPRE se evalúa.
  skipAccessPolicy?: boolean;
}

export type ToolErrorKind =
  | "unauthorized" // 401: JWT invalido/expirado, bug nuestro
  | "forbidden" // 403: el PMS rechazo el rol — membership revocada o mal mapeo
  | "not_found" // 404
  | "validation" // 400/422
  | "upstream" // 5xx
  | "network" // 502 desde nuestro proxy
  | "config" // AGENT_JWT_SECRET no seteado, etc
  | "policy" // rechazado por la política de acceso del agente (permisos del usuario)
  | "unknown";

export class ToolExecutionError extends Error {
  constructor(
    public readonly kind: ToolErrorKind,
    public readonly status: number,
    message: string,
    public readonly upstream?: unknown,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

function mapStatusToKind(status: number): ToolErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status >= 500 && status < 600) return "upstream";
  return "unknown";
}

// Reemplaza {placeholders} del pathTemplate con args y context.
// Los placeholders consumidos se remueven de la query.
function buildPath(
  pathTemplate: string,
  args: Record<string, unknown>,
  ctx: ExecuteContext,
): { path: string; remainingArgs: Record<string, unknown> } {
  const consumed = new Set<string>();
  const path = pathTemplate.replace(/\{(\w+)\}/g, (_, key) => {
    if (args[key] !== undefined) {
      consumed.add(key);
      return String(args[key]);
    }
    if (ctx.propertyId && key === "propertyId") return ctx.propertyId;
    if (ctx.companyId && key === "companyId") return ctx.companyId;
    if (ctx.userId && key === "userId") return ctx.userId;
    return `{${key}}`;
  });
  const remaining: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) remaining[k] = v;
  }
  return { path, remainingArgs: remaining };
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<unknown> {
  const tool = await Tool.findOne({ name: toolName });
  if (!tool) {
    throw new ToolExecutionError(
      "not_found",
      404,
      `Tool no encontrada: ${toolName}`,
    );
  }
  if (tool.status !== "active") {
    throw new ToolExecutionError(
      "validation",
      400,
      `Tool inactiva: ${toolName}`,
    );
  }

  // POLÍTICA DE ACCESO (punto único de corte). Toda ejecución con identidad de
  // usuario — venga del runner del chat, del motor (legacyBridge), de una card
  // (executeAction) o de un script — se valida contra el alcance fresco del
  // usuario (rol / capability / app del espacio / propiedad) ANTES de mintear el
  // JWT y pegarle al PMS. Los runtimes pueden chequear antes para armar un
  // tool_result más rico; esto garantiza que ninguno se lo saltee.
  if (ctx.userId && !ctx.skipAccessPolicy) {
    const scope = await resolveScopeForSession({
      userId: ctx.userId,
      companyId: ctx.companyId,
    });
    if (scope) {
      const decision = checkToolCall(tool as any, args, scope, {
        propertyId: ctx.propertyId,
        companyId: ctx.companyId,
      });
      if (!decision.allowed) {
        throw new ToolExecutionError(
          "policy",
          403,
          decision.message ??
            `No tenes permisos para usar "${tool.displayName ?? tool.name}".`,
          { code: decision.code, reason: decision.reason },
        );
      }
    }
  }

  // Acciones de UI: NO pegan al backend. Devolvemos una directiva que el chat
  // (frontend) ejecuta en el cliente (ej. cambiar el tema a modo oscuro). El
  // agente recibe "success" y le confirma al usuario que ya esta hecho.
  if (tool.category === "ui_action") {
    return {
      ok: true,
      clientAction: tool.name,
      args,
      message: `Directiva de UI "${tool.name}" lista para ejecutarse en el cliente.`,
    };
  }

  // Passthrough de lectura cruda: tools genericas (read_*_api) cuyo pathTemplate
  // es exactamente "{path}" dejan que el agente lea CUALQUIER endpoint del
  // microservicio. El agente pasa `path` (ruta concreta, con los IDs ya
  // sustituidos) y opcionalmente `query` (objeto de query params). NO auto-
  // inyectamos propertyId aca: el endpoint destino es arbitrario y meter una
  // query desconocida rompe los validadores Joi estrictos.
  const isRawPassthrough = tool.execution.pathTemplate === "{path}";
  // Solo las tools raw_write pueden elegir el metodo (POST/PATCH/PUT/DELETE) y
  // mandar body arbitrario. Las raw_read quedan ancladas a GET (no pueden mutar).
  const allowRawWrite = tool.category === "raw_write";
  let path: string;
  let remainingArgs: Record<string, unknown>;
  let rawMethod: string | undefined;
  let rawBody: unknown;

  if (isRawPassthrough) {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath.startsWith("/")) {
      throw new ToolExecutionError(
        "validation",
        400,
        `Para "${toolName}" el parametro "path" debe ser una ruta concreta que empiece con "/" (ej. "/api/v1/properties"). Recibido: ${JSON.stringify(args.path)}`,
      );
    }
    if (/\{\w+\}/.test(rawPath)) {
      throw new ToolExecutionError(
        "validation",
        400,
        `La ruta "${rawPath}" todavia tiene placeholders sin resolver. Sustitui los IDs reales antes de llamar (ej. /api/v1/properties/<propertyId>/units/states).`,
      );
    }
    path = rawPath;
    const q = args.query;
    remainingArgs =
      q && typeof q === "object" && !Array.isArray(q)
        ? { ...(q as Record<string, unknown>) }
        : {};
    if (allowRawWrite) {
      const m = typeof args.method === "string" ? args.method.toUpperCase() : "";
      if (m && !(HTTP_METHODS as readonly string[]).includes(m)) {
        throw new ToolExecutionError(
          "validation",
          400,
          `Metodo "${m}" invalido para "${toolName}". Usa POST, PATCH, PUT o DELETE.`,
        );
      }
      rawMethod = m || "POST";
      rawBody = args.body;
    }
    // Inyectar propertyId en la query si el destino no lo trae ya. booking-app
    // exige ?propertyId= en sus reads (rate-plans, promos, etc.); pms-core y
    // rooms-app lo ignoran si no lo usan. NO inyectamos companyId (rompe Joi
    // strict). Si el path ya tiene el propertyId embebido, el duplicado es inocuo.
    if (
      ctx.propertyId &&
      remainingArgs.propertyId === undefined &&
      !path.includes(ctx.propertyId)
    ) {
      remainingArgs.propertyId = ctx.propertyId;
    }
  } else {
    ({ path, remainingArgs } = buildPath(tool.execution.pathTemplate, args, ctx));

    // Si quedo un placeholder sin resolver (ej. {propertyId} cuando la sesion no
    // tiene propiedad activa), NO ejecutamos: pegarle al PMS con el literal
    // devuelve datos vacios y confunde al agente. Error accionable en su lugar.
    const unresolved = path.match(/\{(\w+)\}/);
    if (unresolved) {
      const key = unresolved[1];
      const hint =
        key === "propertyId"
          ? "Usa la herramienta list_properties para ver las propiedades del hotel y confirma con el usuario cual usar."
          : `Pedile el valor de "${key}" al usuario.`;
      throw new ToolExecutionError(
        "validation",
        400,
        `Falta el parametro "${key}" para ejecutar "${toolName}". ${hint}`,
      );
    }

    // Inyectar propertyId SOLO si el endpoint lo espera y no vino en args.
    // - READS (GET): se inyecta en la query (los list endpoints lo piden ahi y
    //   los que no lo usan lo ignoran).
    // - WRITES (POST/PATCH/PUT/DELETE): se inyecta en el BODY unicamente si la
    //   tool DECLARA propertyId en su inputSchema. Si no lo declara (ej.
    //   update_reservation_notes, cuyo schema Joi es strict y solo acepta
    //   internalNotes), inyectarlo metia una clave desconocida -> 400.
    // companyId NUNCA se inyecta (mismo motivo de Joi strict).
    const pathHasProperty = /\{propertyId\}/.test(tool.execution.pathTemplate);
    const isReadMethod = tool.execution.method === "GET";
    const declaresProperty = Boolean(
      (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties?.propertyId,
    );
    if (
      ctx.propertyId &&
      !pathHasProperty &&
      remainingArgs.propertyId === undefined &&
      (isReadMethod || declaresProperty)
    ) {
      remainingArgs.propertyId = ctx.propertyId;
    }
  }

  // Metodo efectivo: raw_write puede elegirlo (rawMethod); el resto usa el de la
  // definicion de la tool.
  const method = (rawMethod ?? tool.execution.method) as (typeof HTTP_METHODS)[number];
  const isRead = method === "GET";
  // Body: para writes crudos va el `body` que paso el agente; para tools
  // estructuradas va el resto de los args.
  const writeBody = isRawPassthrough ? rawBody : remainingArgs;

  // Identidad delegada: si la tool requiere staff_jwt y tenemos userId
  // verificado, minteamos un JWT corto y lo adjuntamos. Si no, dejamos sin
  // Authorization (solo funcionan los endpoints publicos como GET /availability).
  let agentJwt: string | undefined;
  const needsAuth = tool.execution.authStrategy !== "none";
  if (needsAuth && ctx.userId) {
    try {
      agentJwt = await mintAgentJwt({
        userId: ctx.userId,
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
      });
    } catch (err) {
      if (err instanceof AgentJwtError) {
        throw new ToolExecutionError("config", 500, err.message);
      }
      throw err;
    }
  }

  try {
    const result = await pmsRequest({
      service: tool.execution.targetService as
        | "pms-core"
        | "booking-app"
        | "rooms-app"
        | "staypass"
        | "rms-app",
      method,
      path,
      query: isRead
        ? (remainingArgs as Record<string, string | number | undefined | null>)
        : undefined,
      body: isRead ? undefined : writeBody,
      timeoutMs: tool.execution.timeout ?? 10000,
      agentJwt,
    });
    // Reducir resultados pesados del web-builder (arboles de componentes) antes
    // de devolverlos: evita el overflow de contexto (>200k tokens).
    if (SITE_REDUCE_TOOLS.has(toolName)) {
      const reduced = stripBuilderHeavy(result);
      // get_site: el aiDiscovery de NIVEL SITIO es la config GEO (campos de
      // texto chicos) y la card de detalle del chat la renderiza — lo
      // reinyectamos. El aiDiscovery de cada PAGINA sigue stripeado.
      if (
        toolName === "get_site" &&
        reduced &&
        typeof reduced === "object" &&
        !Array.isArray(reduced) &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        (result as Record<string, unknown>).aiDiscovery
      ) {
        (reduced as Record<string, unknown>).aiDiscovery = (
          result as Record<string, unknown>
        ).aiDiscovery;
      }
      return reduced;
    }
    return result;
  } catch (err) {
    if (err instanceof PmsProxyError) {
      const kind = err.status === 502 ? "network" : mapStatusToKind(err.status);
      throw new ToolExecutionError(kind, err.status, err.message, err.upstream);
    }
    throw err;
  }
}
