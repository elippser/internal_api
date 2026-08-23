/**
 * Puente al catálogo de herramientas del PMS que ya existe (`modules/tools`).
 *
 * Es el nivel 4 de la resolución y la razón por la que migrar los dos agentes
 * actuales al motor nuevo no obliga a reescribir las ~200 herramientas del PMS.
 * El motor lee esas filas, las envuelve como `ResolvedTool` y delega la
 * ejecución en `executeTool`, que ya sabe mintear el JWT delegado, sustituir
 * `{propertyId}` en el path, mapear los errores del proxy y adelgazar las
 * respuestas pesadas del builder.
 *
 * Reimplementar todo eso dentro del motor habría duplicado lógica sutil y
 * probada en producción, con la garantía de que las dos copias se desincronizan.
 * El puente tiene un costo: la definición de esas herramientas sigue viviendo
 * en el modelo viejo, así que no participa del versionado inmutable del motor.
 * Es el intercambio correcto por ahora, y el punto de corte está acotado a este
 * archivo el día que se migre el catálogo.
 */
import { Tool } from "../../modules/tools/tools.model";
import {
  executeTool as legacyExecuteTool,
  ToolExecutionError,
} from "../../modules/conversations/services/toolExecutor";
import { getEngineConfig } from "../core/config";
import { createLogger } from "../core/logger";
import type { ConcurrencyMode } from "../models/enums";
import { capToolResult, sanitizeToolName, type ResolvedTool, type ToolContext } from "./types";

const log = createLogger("engine:tools:legacy");

/** Categorías que implican OPERAR sobre el PMS. */
const WRITE_CATEGORY = /(_write$|^raw_write$)/;

function concurrencyOf(category: string, isDestructive: boolean): ConcurrencyMode {
  // Destructiva corre sola: un borrado en paralelo con una lectura del mismo
  // recurso devuelve datos que ya no existen.
  if (isDestructive) return "exclusive";
  if (WRITE_CATEGORY.test(category)) return "write";
  return "read";
}

/**
 * Mapea los roles del PMS al piso de rol del motor. Son taxonomías distintas
 * (`owner|admin|staff|viewer|editor` vs. `super_admin|admin|developer|analyst|
 * support`) y mezclarlas sería un agujero de permisos, así que el puente NO
 * traduce: deja el piso en nulo y confía en la autorización real que aplica el
 * PMS al recibir el JWT delegado. El pre-check del motor sólo puede ser más
 * restrictivo, nunca más permisivo, y acá elige no opinar.
 */
const LEGACY_ROLE_FLOOR = null;

export async function loadLegacyTools(names: string[]): Promise<ResolvedTool[]> {
  if (names.length === 0) return [];

  const rows = await Tool.find({
    $or: [{ name: { $in: names } }, { toolId: { $in: names } }],
    status: "active",
  }).lean();

  return rows.map((row) => {
    const category = String(row.category ?? "");
    const isDestructive = Boolean(row.permissions?.isDestructive);

    return {
      name: sanitizeToolName(String(row.name)),
      description: String(row.description ?? ""),
      inputSchema: {
        type: "object" as const,
        properties: (row.inputSchema?.properties ?? {}) as Record<string, unknown>,
        required: (row.inputSchema?.required ?? []) as string[],
      },
      type: "http" as const,
      scope: "global" as const,
      origin: "legacy" as const,
      concurrency: concurrencyOf(category, isDestructive),
      roleFloor: LEGACY_ROLE_FLOOR,
      requiresConfirmation: Boolean(row.permissions?.requiresConfirmation),
      execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
        try {
          const result = await legacyExecuteTool(String(row.name), args, {
            propertyId: ctx.propertyId ?? undefined,
            companyId: ctx.companyId ?? undefined,
            userId: ctx.userId ?? undefined,
            agentId: ctx.agentId,
            sessionId: ctx.sessionId ?? undefined,
          });
          return capToolResult(result, getEngineConfig().execution.maxToolResultChars);
        } catch (err) {
          if (err instanceof ToolExecutionError) {
            // Los errores de herramienta vuelven al modelo como DATOS, no como
            // excepción: el modelo puede adaptarse, pedir el dato que falta o
            // intentar otra ruta. Una excepción mataría el turno entero por un
            // 404 recuperable.
            return {
              ok: false,
              error: err.message,
              kind: err.kind,
              status: err.status,
            };
          }
          throw err;
        }
      },
    } satisfies ResolvedTool;
  });
}

/** Nombres del catálogo viejo que existen y están activos. */
export async function legacyToolNames(candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await Tool.find(
    { $or: [{ name: { $in: candidates } }, { toolId: { $in: candidates } }], status: "active" },
    { name: 1, toolId: 1 },
  ).lean();
  const found = new Set<string>();
  for (const r of rows) {
    if (r.name) found.add(String(r.name));
    if (r.toolId) found.add(String(r.toolId));
  }
  return found;
}

export function logLegacyBridgeUsage(count: number): void {
  if (count > 0) {
    log.debug("herramientas resueltas por el puente al catálogo del PMS", { count });
  }
}
