import { Tool } from "../../tools/tools.model";
import {
  describeAccess,
  describeRule,
  evaluateAccess,
  findRouteRule,
  normalizePath,
  propertyIdFromPath,
  type AccessDecision,
  type HttpMethod,
  type PolicyService,
} from "../../../shared/agentAuth/routePolicy";
import {
  appAccessOf,
  resolveUserScope,
  type UserScope,
} from "../../../shared/agentAuth/userScope";
import {
  COMPANY_CAPABILITY_LABELS,
  OS_APP_IDS,
  capabilityLabel,
  osAppLabel,
  type CompanyCapability,
} from "../../../shared/agentAuth/pmsAccessCatalog";

/**
 * Acceso por herramienta para el runtime del chat (bookfer-IA).
 *
 * Une el catálogo de tools (qué endpoint pega cada una) con la política de
 * rutas (`routePolicy`) y el alcance del usuario (`userScope`) para responder,
 * por turno y por llamada, la misma pregunta: ¿este usuario puede ejecutar
 * esta herramienta, sobre esta propiedad, ahora?
 *
 * Tres usos:
 *   - `computeTurnToolAccess`: filtra las tools del agente ANTES de armar el
 *     turno. Lo que el usuario no puede usar no se le ofrece al modelo, y el
 *     prompt (`renderPermissionsBlock`) le explica el porqué para que lo diga
 *     en vez de "no existe esa función".
 *   - `checkToolCall`: se evalúa en CADA tool call — en `executeTool` (punto
 *     único de corte: runner del chat, motor vía legacyBridge, cards, scripts)
 *     y antes en el runner para armar un tool_result con code + mensaje. Para
 *     `read_*_api`/`write_*_api` mira el method/path/propertyId reales que
 *     eligió el modelo, no sólo la familia de rutas.
 *   - `renderPermissionsBlock`: sección "Permisos" del prompt dinámico.
 */

type ToolLike = {
  toolId: string;
  name: string;
  displayName?: string | null;
  category: string;
  inputSchema?: { properties?: Record<string, unknown> } | null;
  execution: {
    targetService: string;
    method: string;
    pathTemplate: string;
  };
  permissions?: { requiredRoles?: string[] } | null;
};

export interface DeniedTool {
  toolId: string;
  name: string;
  displayName: string;
  code: NonNullable<AccessDecision["code"]>;
  message: string;
  requirement: string;
}

export interface TurnToolAccess {
  allowedToolIds: string[];
  denied: DeniedTool[];
  /** Apps a las que el usuario tiene algún acceso, con su nivel (para el prompt). */
  appAccess: Array<{ appId: string; label: string; access: string }>;
}

export interface ToolCallContext {
  propertyId?: string;
  companyId?: string;
}

const POLICY_SERVICES: ReadonlySet<string> = new Set([
  "pms-core",
  "booking-app",
  "rooms-app",
  "rms-app",
  "staypass",
]);

function asMethod(raw: unknown, fallback: HttpMethod = "GET"): HttpMethod {
  const m = typeof raw === "string" ? raw.toUpperCase() : "";
  return (["GET", "POST", "PATCH", "PUT", "DELETE"] as string[]).includes(m)
    ? (m as HttpMethod)
    : fallback;
}

function isRawTool(tool: ToolLike): boolean {
  return tool.execution.pathTemplate === "{path}";
}

/**
 * Propiedad sobre la que va a operar la llamada. Explícita en args gana; si la
 * tool es de un servicio por-propiedad (booking/rooms/rms) o declara
 * propertyId (en path o schema), se usa la de la sesión — es lo que
 * `executeTool` inyecta. Las tools de company/usuario no llevan propiedad.
 */
function targetPropertyFor(
  tool: ToolLike,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): string | undefined {
  if (typeof args.propertyId === "string" && args.propertyId.trim()) {
    return args.propertyId.trim();
  }
  const fromPath = propertyIdFromPath(tool.execution.pathTemplate);
  if (fromPath) return fromPath;
  const template = tool.execution.pathTemplate;
  const declares = Boolean(tool.inputSchema?.properties?.propertyId);
  const perProperty =
    tool.execution.targetService === "booking-app" ||
    tool.execution.targetService === "rooms-app" ||
    tool.execution.targetService === "rms-app";
  if (/[{:]propertyId/.test(template) || declares || perProperty) return ctx.propertyId;
  return undefined;
}

/** Target de una tool cruda: method/path/propertyId salen de los args. */
function rawTarget(
  tool: ToolLike,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): { method: HttpMethod; path: string; propertyId?: string } {
  const isWrite = tool.category === "raw_write";
  const method = isWrite ? asMethod(args.method, "POST") : "GET";
  const path = typeof args.path === "string" ? args.path.trim() : "/";
  // propertyId: query object, ?propertyId= embebido en el path, /properties/<id>/, o la sesión
  // (executeTool inyecta ctx.propertyId en la query cuando el path no lo trae).
  let propertyId: string | undefined;
  const q = args.query;
  if (q && typeof q === "object" && typeof (q as Record<string, unknown>).propertyId === "string") {
    propertyId = String((q as Record<string, unknown>).propertyId);
  }
  if (!propertyId) {
    const m = path.match(/[?&]propertyId=([^&#]+)/);
    if (m) propertyId = decodeURIComponent(m[1]);
  }
  if (!propertyId) propertyId = propertyIdFromPath(path);
  if (!propertyId && isWrite && args.body && typeof args.body === "object") {
    const b = args.body as Record<string, unknown>;
    if (typeof b.propertyId === "string") propertyId = b.propertyId;
  }
  if (!propertyId) propertyId = ctx.propertyId;
  return { method, path, propertyId };
}

/**
 * Decide si el usuario puede ejecutar ESTA llamada (tool + args). Se evalúa en
 * cada tool call del runner y en las acciones directas de las cards.
 */
export function checkToolCall(
  tool: ToolLike,
  args: Record<string, unknown>,
  scope: UserScope,
  ctx: ToolCallContext,
): AccessDecision {
  // Acciones de UI: no pegan al backend.
  if (tool.category === "ui_action") return { allowed: true, reason: "ui_action" };

  const service = tool.execution.targetService;
  if (!POLICY_SERVICES.has(service)) {
    // Servicio sin política (ej. "analytics"): lectura pasa, escritura sólo admin.
    const method = asMethod(tool.execution.method);
    if (method === "GET" || scope.isAdmin) {
      return { allowed: true, reason: `no_policy_service:${service}` };
    }
    return {
      allowed: false,
      code: "unknown_write",
      message: `"${tool.displayName ?? tool.name}" escribe en un servicio sin política de acceso definida; sólo owner/admin pueden usarla.`,
      reason: `no_policy_service_write:${service}`,
    };
  }

  if (isRawTool(tool)) {
    const t = rawTarget(tool, args, ctx);
    return evaluateAccess(scope, {
      service: service as PolicyService,
      method: t.method,
      path: t.path,
      propertyId: t.propertyId,
    });
  }

  return evaluateAccess(scope, {
    service: service as PolicyService,
    method: asMethod(tool.execution.method),
    path: tool.execution.pathTemplate,
    propertyId: targetPropertyFor(tool, args, ctx),
  });
}

/**
 * Filtra las tools habilitadas del agente a las que el usuario puede usar en
 * este turno. Se evalúa la FAMILIA de rutas (rol / capability / app), no la
 * propiedad: eso se decide por llamada, porque el modelo puede apuntar a otra
 * propiedad que la de la sesión.
 *
 * Las tools crudas (`read_*_api`/`write_*_api`) se ofrecen siempre que el
 * usuario tenga membership: su path lo elige el modelo y se valida en la
 * llamada. Sin alcance resuelto o sin membership no se ofrece ninguna tool que
 * requiera identidad.
 */
export async function computeTurnToolAccess(
  enabledToolIds: string[],
  scope: UserScope,
): Promise<TurnToolAccess> {
  const appAccess = OS_APP_IDS.map((appId) => ({
    appId,
    label: osAppLabel(appId),
    access: appAccessOf(scope, appId),
  })).filter((a) => a.access !== "none");

  if (enabledToolIds.length === 0) return { allowedToolIds: [], denied: [], appAccess };

  const tools = (await Tool.find(
    { toolId: { $in: enabledToolIds }, status: "active" },
    {
      toolId: 1,
      name: 1,
      displayName: 1,
      category: 1,
      inputSchema: 1,
      execution: 1,
      permissions: 1,
    },
  ).lean()) as unknown as ToolLike[];

  const allowedToolIds: string[] = [];
  const denied: DeniedTool[] = [];
  for (const tool of tools) {
    let decision: AccessDecision;
    if (tool.category === "ui_action") {
      decision = { allowed: true, reason: "ui_action" };
    } else if (isRawTool(tool)) {
      // Se ofrece si el usuario existe para el PMS; el path se valida al llamar.
      decision =
        scope.resolved && scope.role && !scope.mustChangePassword
          ? { allowed: true, reason: "raw:deferred" }
          : evaluateAccess(scope, {
              service: tool.execution.targetService as PolicyService,
              method: tool.category === "raw_write" ? "POST" : "GET",
              path: "/",
            });
    } else {
      // Sin propertyId: sólo familia de rutas.
      decision = checkToolCall(tool, {}, scope, {});
    }
    if (decision.allowed) {
      allowedToolIds.push(tool.toolId);
    } else {
      const svc = tool.execution.targetService;
      const rule = POLICY_SERVICES.has(svc)
        ? findRouteRule(
            svc as PolicyService,
            asMethod(tool.execution.method),
            tool.execution.pathTemplate,
          )
        : undefined;
      denied.push({
        toolId: tool.toolId,
        name: tool.name,
        displayName: tool.displayName ?? tool.name,
        code: decision.code ?? "insufficient_role",
        message: decision.message ?? "Sin permiso.",
        requirement: describeRule(rule),
      });
    }
  }
  return { allowedToolIds, denied, appAccess };
}

/**
 * Sección "Permisos del usuario" del prompt (parte DINÁMICA: cambia por
 * usuario y por turno). Le dice al modelo qué apps y capacidades tiene el
 * usuario, qué herramientas quedaron fuera por permisos y cómo responder cuando
 * le pidan algo fuera de alcance: explicar el permiso faltante, no inventar que
 * la función no existe ni registrar un pedido de feature.
 */
export function renderPermissionsBlock(
  scope: UserScope,
  access: TurnToolAccess,
  ctx: { propertyId?: string; propertyName?: string; operativeSpaceName?: string },
): string {
  const lines: string[] = ["## Permisos del usuario en esta sesión (fuente: PMS, actualizados en este turno)"];

  if (!scope.resolved) {
    lines.push(
      "- ATENCIÓN: no se pudo leer el perfil del usuario en el PMS. Las herramientas que requieren identidad van a fallar; explicalo si pasa y sugerí reintentar en unos segundos.",
    );
    return lines.join("\n");
  }
  if (!scope.role) {
    lines.push(
      "- El usuario NO tiene membresía activa en esta empresa: no podés operar ni consultar el PMS en su nombre. Explicáselo con claridad.",
    );
    return lines.join("\n");
  }

  lines.push(`- Rol en la empresa: ${scope.role}${scope.isAdmin ? " (owner/admin: acceso total a todas las apps, ajustes y propiedades de la empresa)" : ""}.`);
  if (scope.mustChangePassword) {
    lines.push("- Tiene una contraseña temporal pendiente: el PMS bloquea toda acción hasta que la cambie. No ejecutes nada; indicale que la cambie primero.");
  }

  if (!scope.isAdmin) {
    // Propiedades
    if (scope.allProperties) {
      lines.push("- Propiedades: ve todas las de la empresa.");
    } else {
      lines.push(
        `- Propiedades habilitadas: ${scope.propertyIds.length ? scope.propertyIds.join(", ") : "ninguna"}. Fuera de esa lista no podés leer ni escribir nada.`,
      );
    }
    // Espacio + apps
    if (scope.space) {
      const spaceName = ctx.operativeSpaceName ? ` "${ctx.operativeSpaceName}"` : "";
      lines.push(
        `- Espacio operativo activo${spaceName} (propiedad ${scope.space.propertyId}${ctx.propertyName && scope.space.propertyId === ctx.propertyId ? ` = ${ctx.propertyName}` : ""}). Las apps de reservas, habitaciones y revenue sólo se pueden operar sobre ESA propiedad.`,
      );
      const withAccess = access.appAccess;
      if (withAccess.length) {
        lines.push(
          "- Apps con acceso en el espacio: " +
            withAccess.map((a) => `${a.label} → ${describeAccess(a.access)}`).join("; ") +
            ".",
        );
      } else {
        lines.push("- Apps con acceso en el espacio: ninguna.");
      }
      const without = OS_APP_IDS.filter((id) => appAccessOf(scope, id) === "none").map(osAppLabel);
      if (without.length) lines.push(`- Apps SIN acceso: ${without.join("; ")}.`);
    } else {
      lines.push(
        "- No tiene un espacio operativo activo: no puede operar reservas, habitaciones, tarifas, revenue ni marketing por propiedad hasta seleccionar uno en el PMS (o que un admin lo asigne).",
      );
    }
    // Capabilities
    const caps = scope.capabilities as CompanyCapability[];
    if (caps.length) {
      lines.push(`- Capacidades administrativas: ${caps.map(capabilityLabel).join("; ")}.`);
    } else {
      lines.push("- Capacidades administrativas: ninguna (no gestiona usuarios, espacios, ajustes de empresa ni el web builder).");
    }
    const missingCaps = (Object.keys(COMPANY_CAPABILITY_LABELS) as CompanyCapability[]).filter(
      (c) => !caps.includes(c),
    );
    if (missingCaps.length) {
      lines.push(`- Sin capacidad para: ${missingCaps.map(capabilityLabel).join("; ")}.`);
    }
  }

  if (access.denied.length) {
    // Agrupamos por motivo para no listar 100 tools una por una.
    const byMsg = new Map<string, string[]>();
    for (const d of access.denied) {
      const key = d.requirement;
      const arr = byMsg.get(key) ?? [];
      arr.push(d.name);
      byMsg.set(key, arr);
    }
    lines.push(
      `- Herramientas NO disponibles para este usuario por permisos (${access.denied.length}): ` +
        [...byMsg.entries()]
          .map(([req, names]) => `${names.slice(0, 6).join(", ")}${names.length > 6 ? ` y ${names.length - 6} más` : ""} [requiere ${req}]`)
          .join(" · ") +
        ".",
    );
  }

  lines.push(
    "",
    "REGLAS SOBRE PERMISOS:",
    "- Si el usuario pide algo que sus permisos no cubren (app sin acceso, escritura donde sólo puede operar, capacidad faltante, otra propiedad), NO lo intentes con otra herramienta ni con las crudas read_*/write_*: decile con claridad que su usuario no tiene ese permiso en este espacio/empresa y que un owner/admin puede otorgárselo (Ajustes > Equipo > accesos, o Espacio operativo > Usuarios y permisos por app).",
    "- Eso NO es una funcionalidad faltante: no lo registres con capture_feedback_request ni digas que 'no está disponible en la plataforma'.",
    "- Las herramientas que no ves en tu lista no las tenés por permisos del usuario, no porque no existan. Si te piden justo eso, explicá el permiso.",
    "- Si una herramienta devuelve un error con code insufficient_permissions / missing_capability / insufficient_app_access, transmití el mensaje tal cual (dice qué permiso falta) y no reintentes por otro camino.",
  );

  return lines.join("\n");
}

/** Resuelve el alcance del usuario de la sesión (con el mismo secret del JWT delegado). */
export async function resolveScopeForSession(ctx: {
  userId?: string;
  companyId?: string;
}): Promise<UserScope | null> {
  if (!ctx.userId) return null;
  const secret = process.env.AGENT_JWT_SECRET;
  if (!secret) {
    // Sin secret no hay JWT delegado: las tools fallarían igual (config). El
    // alcance queda como "no resuelto" y el prompt lo dice.
    return {
      userId: ctx.userId,
      companyId: ctx.companyId,
      isAdmin: false,
      capabilities: [],
      allProperties: false,
      propertyIds: [],
      resolved: false,
      mustChangePassword: false,
    };
  }
  return resolveUserScope(secret, ctx.userId, ctx.companyId);
}

/** Descripción del requisito de una tool (consola / verify script). */
export function describeToolRequirement(tool: ToolLike): string {
  if (tool.category === "ui_action") return "acción de UI (sin permiso)";
  if (isRawTool(tool)) {
    return tool.category === "raw_write"
      ? "según el path (escrituras fuera de las apps mapeadas: solo owner/admin)"
      : "según el path (lectura)";
  }
  const svc = tool.execution.targetService;
  if (!POLICY_SERVICES.has(svc)) return "servicio sin política";
  const rule = findRouteRule(
    svc as PolicyService,
    asMethod(tool.execution.method),
    normalizePath(tool.execution.pathTemplate),
  );
  return describeRule(rule);
}
