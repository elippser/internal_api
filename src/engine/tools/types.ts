/**
 * Contratos del sistema de herramientas (§12).
 *
 * Una `ResolvedTool` es lo que sale de la resolución y lo que consume el grafo:
 * ya trae el esquema listo para enlazar al modelo, la clase de concurrencia
 * decidida y el ejecutor cableado. El grafo no vuelve a consultar el catálogo.
 *
 * La distinción `execute` vs. `serverTool` es la que ordena todo el archivo:
 * hay herramientas que ejecutamos NOSOTROS (una llamada HTTP al PMS, una
 * delegación a un sub-agente) y herramientas que ejecuta el PROVEEDOR y que
 * sólo declaramos (búsqueda web, ejecución de código). Confundirlas produce dos
 * defectos simétricos: intentar ejecutar localmente algo que ya corrió del otro
 * lado, o declarar como pasiva una herramienta que nadie va a ejecutar.
 */
import type { ConcurrencyMode, ToolScope, ToolType } from "../models/enums";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Contexto que recibe el ejecutor. Los secretos NO viajan por acá (§35.8). */
export interface ToolContext {
  executionId: string;
  agentId: string;
  tenantId: string | null;
  /** Usuario verificado, para mintear identidad delegada contra el PMS. */
  userId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
  sessionId?: string | null;
  /** Rol efectivo del principal, para el piso de rol. */
  role?: string | null;
  /** Profundidad de delegación actual. El sub-agente la incrementa. */
  depth: number;
  /** Ruta de agentes para atribuir el costo: `raiz/analista`. */
  agentPath: string;
  /**
   * Habilidades declaradas en la versión. Viaja por el contexto porque
   * `load_skill` tiene que respetar el mismo SELECTOR que el prompt: si el
   * agente sólo declaró tres, no puede cargar una cuarta del inquilino
   * nombrándola a mano.
   */
  declaredSkills?: string[];
  /** Publica un evento de progreso. Mejor esfuerzo, nunca bloquea. */
  emit?: (type: string, payload: Record<string, unknown>) => void;
  /** Señal de cancelación: el ejecutor la mira antes de un efecto costoso. */
  signal?: { cancelled: boolean };
}

export interface ResolvedTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;

  type: ToolType;
  scope: ToolScope;
  /**
   * De dónde salió. Aparece en el paso y sirve para depurar el clásico "¿por
   * qué el agente tiene esta herramienta?".
   */
  origin: "registry" | "tenant" | "global" | "legacy" | "capability" | "sub_agent";

  /** Clase de concurrencia del nodo particionado (§11.2). */
  concurrency: ConcurrencyMode;
  /** Piso de rol. Por debajo, la herramienta se retira del enlace con motivo. */
  roleFloor?: string | null;
  /** La UI pide confirmación antes de ejecutar. Ortogonal a las interrupciones. */
  requiresConfirmation?: boolean;

  /**
   * Ejecutor local. Excluyente con `serverTool`: una de las dos, nunca ambas.
   */
  execute?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

  /**
   * Declaración pasada tal cual al proveedor (búsqueda web, ejecución de
   * código). El motor no la ejecuta: la anuncia y lee el resultado del
   * response.
   */
  serverTool?: Record<string, unknown>;
}

/** Forma que espera el proveedor para una herramienta definida por nosotros. */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

export function toProviderDefinition(tool: ResolvedTool): Record<string, unknown> {
  if (tool.serverTool) return tool.serverTool;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Sanea el nombre al patrón que aceptan los proveedores (`^[a-zA-Z0-9_-]{1,64}$`).
 * Un nombre inválido es un 400 del proveedor en cada turno del agente, y el
 * mensaje no dice cuál de las veinte herramientas es la culpable.
 */
export function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64);
  return cleaned || "tool";
}

/**
 * Tope de tamaño del resultado. Un resultado gigante (un listado completo del
 * PMS, un árbol de componentes del builder) desborda el contexto y mata el
 * turno. Truncar con aviso explícito es peor que el resultado completo pero
 * mucho mejor que un turno muerto — y el aviso importa: sin él el modelo cree
 * que vio el final de la lista y afirma cosas falsas sobre lo que "no existe".
 */
export function capToolResult(value: unknown, maxChars: number): unknown {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return { error: "resultado no serializable" };
  }
  if (serialized === undefined) return value;
  if (serialized.length <= maxChars) return value;

  return {
    truncated: true,
    originalLength: serialized.length,
    note:
      "Resultado truncado por tamaño. Esto NO es el final de los datos: " +
      "acotá la consulta (filtros, paginación, rango de fechas) y volvé a llamar.",
    preview: serialized.slice(0, maxChars),
  };
}
