/**
 * Resolución de herramientas: jerarquía de niveles, compuerta por capacidad y
 * filtro por piso de rol (§12.2, §12.3, §11.2).
 *
 * Orden de resolución (gana el primero que responde):
 *   1. Registro en memoria      — herramientas de código
 *   2. Catálogo del inquilino   — filas de `engine_tools` con tenantId
 *   3. Catálogo global          — filas de `engine_tools` sin tenantId
 *   4. Puente al catálogo del PMS — `modules/tools` (compatibilidad)
 *
 * Que el inquilino sombree al global es lo que permite a un hotel redefinir una
 * herramienta sin que la plataforma tenga que versionarla por cliente.
 *
 * La compuerta por capacidad merece un párrafo. Las herramientas gestionadas por
 * capacidad NO se pueden pedir por nombre: si un agente declara `memory_search`
 * en su lista `tools` pero no tiene la capacidad `memory`, la herramienta se
 * NIEGA con motivo, no se entrega. Al revés, con la capacidad encendida, la
 * lista `tools` funciona como SELECTOR sobre el paquete de esa capacidad, para
 * que un sub-agente especializado conserve su subconjunto curado en vez de
 * recibir las nueve herramientas de memoria.
 *
 * Y el piso de rol: una herramienta por encima del rol del principal efectivo
 * se RETIRA del enlace con negación explicativa, no desaparece en silencio. La
 * diferencia importa para depurar: "no tenés permiso para X" es accionable,
 * "el agente no usó X" no lo es.
 */
import { createLogger } from "../core/logger";
import { meetsRoleFloor, type RuntimeCapability } from "../models/enums";
import type { EngineAgentVersionDoc } from "../models/agentVersion.model";
import { hasCapability } from "../models/agentVersion.model";
import { EngineTool } from "../models/tool.model";
import { rowToTool } from "./factories";
import { loadLegacyTools, logLegacyBridgeUsage } from "./legacyBridge";
import {
  getCodeTool,
  isCapabilityManaged,
  isPendingCapability,
  toolsForCapability,
} from "./registry";
import type { ResolvedTool } from "./types";

const log = createLogger("engine:tools:resolver");

export interface DeniedTool {
  name: string;
  reason: string;
}

export interface ResolutionResult {
  tools: ResolvedTool[];
  denied: DeniedTool[];
}

export interface ResolutionOptions {
  tenantId: string | null;
  /** Rol efectivo del principal. Nulo = sin restricción por rol. */
  role?: string | null;
  /**
   * Subconjunto permitido, cuando una superposición o una delegación acotan el
   * alcance del turno. Nulo = sin acotar.
   */
  allowlist?: string[] | null;
}

/**
 * Capacidades cuyas herramientas ejecuta el PROVEEDOR. No pasan por el registro
 * ni por el catálogo: se construyen acá y se enlazan contra el modelo del turno.
 */
const SERVER_TOOL_CAPABILITIES: Partial<Record<RuntimeCapability, ResolvedTool>> = {
  web_search: {
    name: "web_search",
    description: "Busca información actual en la web.",
    inputSchema: { type: "object", properties: {} },
    type: "search",
    scope: "global",
    origin: "capability",
    concurrency: "read",
    serverTool: { __serverToolKind: "web_search", name: "web_search" },
  },
  code_execution: {
    name: "code_execution",
    description:
      "Ejecuta código en un sandbox para analizar datos o generar archivos (gráficos, planillas, documentos).",
    inputSchema: { type: "object", properties: {} },
    type: "code_execution",
    scope: "global",
    origin: "capability",
    concurrency: "exclusive",
    serverTool: { __serverToolKind: "code_execution", name: "code_execution" },
  },
};

export async function resolveToolsForVersion(
  version: Pick<EngineAgentVersionDoc, "tools" | "config">,
  opts: ResolutionOptions,
): Promise<ResolutionResult> {
  const declared = [...new Set(version.tools ?? [])];
  const denied: DeniedTool[] = [];
  const resolved = new Map<string, ResolvedTool>();

  // --- 1. Compuerta por capacidad ---------------------------------------
  const capabilityNames = new Map<string, { name: string; capability: RuntimeCapability }>();
  for (const capability of Object.keys(
    (version.config?.capabilities ?? {}) as Record<string, boolean>,
  ) as RuntimeCapability[]) {
    if (!hasCapability(version, capability)) continue;

    const serverTool = SERVER_TOOL_CAPABILITIES[capability];
    if (serverTool) {
      resolved.set(serverTool.name, serverTool);
      continue;
    }

    const bundle = toolsForCapability(capability);
    if (bundle.length === 0) continue;

    // La lista declarada actúa como SELECTOR dentro del paquete de la
    // capacidad. Si no selecciona nada de este paquete, entra completo.
    const selected = bundle.filter((n) => declared.includes(n));
    const effective = selected.length > 0 ? selected : bundle;
    for (const name of effective) capabilityNames.set(name, { name, capability });
  }

  for (const { name, capability } of capabilityNames.values()) {
    const tool = getCodeTool(name);
    if (tool) {
      resolved.set(name, { ...tool, origin: "capability" });
      continue;
    }
    // Se distingue la ausencia PLANIFICADA del defecto, porque el autor del
    // agente necesita saber cuál de las dos le tocó: una se resuelve esperando
    // la entrega, la otra reportando un bug.
    denied.push({
      name,
      reason: isPendingCapability(capability)
        ? `la capacidad "${capability}" está declarada pero sus herramientas no forman parte de esta entrega`
        : "gestionada por capacidad pero no registrada en este despliegue (ver la prueba de deriva del arranque)",
    });
  }

  // --- 2. Nombres declarados que NO son de capacidad ---------------------
  const pending = declared.filter((name) => {
    if (!isCapabilityManaged(name)) return true;
    if (resolved.has(name)) return false;
    // Declarada, gestionada por capacidad y la capacidad está apagada.
    denied.push({
      name,
      reason:
        "requiere una capacidad de runtime que este agente no tiene activada; " +
        "no se puede pedir por catálogo",
    });
    return false;
  });

  // Nivel 1: registro en memoria.
  const afterRegistry: string[] = [];
  for (const name of pending) {
    const tool = getCodeTool(name);
    if (tool) resolved.set(name, tool);
    else afterRegistry.push(name);
  }

  // Niveles 2 y 3: catálogo del inquilino, después el global.
  const afterCatalog: string[] = [];
  if (afterRegistry.length > 0) {
    const rows = await EngineTool.find({
      $or: [{ name: { $in: afterRegistry } }, { toolId: { $in: afterRegistry } }],
      status: "active",
      deletedAt: null,
      $and: [{ $or: [{ tenantId: opts.tenantId }, { tenantId: null }] }],
    }).lean();

    // El del inquilino sombrea al global: se ordena para que el propio quede
    // último y sobrescriba en el mapa.
    rows.sort((a, b) => (a.tenantId === null ? -1 : 1) - (b.tenantId === null ? -1 : 1));

    const byName = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      byName.set(String(row.name), row);
      if (row.toolId) byName.set(String(row.toolId), row);
    }

    for (const name of afterRegistry) {
      const row = byName.get(name);
      if (!row) {
        afterCatalog.push(name);
        continue;
      }
      try {
        resolved.set(
          name,
          rowToTool(row as never, row.tenantId ? "tenant" : "global"),
        );
      } catch (err) {
        denied.push({
          name,
          reason: err instanceof Error ? err.message : "no se pudo construir la herramienta",
        });
      }
    }
  }

  // Nivel 4: puente al catálogo del PMS.
  if (afterCatalog.length > 0) {
    const legacy = await loadLegacyTools(afterCatalog);
    logLegacyBridgeUsage(legacy.length);
    const found = new Set(legacy.map((t) => t.name));
    for (const tool of legacy) resolved.set(tool.name, tool);
    for (const name of afterCatalog) {
      if (!found.has(name)) {
        denied.push({ name, reason: "no existe en ningún catálogo o está inactiva" });
      }
    }
  }

  // --- 3. Acotado por superposición o delegación -------------------------
  if (opts.allowlist) {
    const allow = new Set(opts.allowlist);
    for (const name of [...resolved.keys()]) {
      if (!allow.has(name)) {
        resolved.delete(name);
        denied.push({ name, reason: "fuera del subconjunto permitido para este turno" });
      }
    }
  }

  // --- 4. Piso de rol ----------------------------------------------------
  for (const [name, tool] of [...resolved.entries()]) {
    if (tool.roleFloor && !meetsRoleFloor(opts.role, tool.roleFloor)) {
      resolved.delete(name);
      denied.push({
        name,
        reason: `requiere rol "${tool.roleFloor}" o superior; el principal efectivo es "${opts.role ?? "sin rol"}"`,
      });
    }
  }

  if (denied.length > 0) {
    log.debug("herramientas negadas al construir el grafo", { denied });
  }

  return { tools: [...resolved.values()], denied };
}

/** True si el conjunto incluye alguna herramienta de escritura o destructiva. */
export function hasWriteTools(tools: ResolvedTool[]): boolean {
  return tools.some((t) => t.concurrency === "write" || t.concurrency === "exclusive");
}
