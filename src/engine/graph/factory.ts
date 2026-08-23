/**
 * Fábrica de grafos: versión del agente -> grafo compilado (§11.2).
 *
 * La fábrica es el punto donde se toman todas las decisiones que dependen de la
 * configuración y NO deben rehacerse en cada iteración del bucle: qué
 * herramientas existen, cuáles se retiran por rol, qué sub-agentes están
 * cableados, qué reglas de interrupción están activas.
 *
 * Sobre los tipos de grafo desactivados: `linear_chain`, `classifier_router` y
 * `flow_dag` siguen en la enumeración con su punto de construcción presente y
 * fallando con un error tipado que nombra dónde implementarlos. Borrarlos sería
 * peor por dos motivos: rompería la lectura de cualquier versión ya guardada
 * con ese tipo, y perdería la intención de diseño. El esquema de autoría los
 * rechaza al guardar (`AUTHORABLE_GRAPH_TYPES`), así que nadie puede crear uno
 * nuevo por accidente.
 */
import { NotImplementedError, ValidationError } from "../core/errors";
import { getEngineConfig } from "../core/config";
import { createLogger } from "../core/logger";
import type { EngineAgentVersionDoc, InterruptionRule } from "../models/agentVersion.model";
import { resolveToolsForVersion, type DeniedTool } from "../tools/resolver";
import { buildSubAgentTools } from "../subagents/runner";
import type { ResolvedTool } from "../tools/types";
import { ReactLoopGraph } from "./reactLoop";
import type { CompiledGraph } from "./types";

const log = createLogger("engine:graph:factory");

export interface BuildOptions {
  tenantId: string | null;
  role?: string | null;
  /** Subconjunto permitido (superposición nombrada o delegación acotada). */
  toolAllowlist?: string[] | null;
}

export interface BuiltGraph {
  graph: CompiledGraph;
  tools: ResolvedTool[];
  denied: DeniedTool[];
}

export async function buildGraph(
  version: EngineAgentVersionDoc,
  opts: BuildOptions,
): Promise<BuiltGraph> {
  const cfg = getEngineConfig();

  if (version.graphType === "coding_run") {
    throw new NotImplementedError(
      "El runtime de corridas de codificación en sandbox (§21)",
      "engine/graph/factory.ts + engine/coding/ (ejecutor de harness, sandbox y publicación)",
    );
  }
  if (version.graphType !== "react_loop") {
    throw new NotImplementedError(
      `El tipo de grafo "${version.graphType}"`,
      `engine/graph/${version.graphType}.ts (constructor conservado, autoría desactivada)`,
    );
  }

  // --- Herramientas: catálogo + capacidades + piso de rol ----------------
  const { tools, denied } = await resolveToolsForVersion(version, {
    tenantId: opts.tenantId,
    role: opts.role,
    allowlist: opts.toolAllowlist ?? null,
  });

  // --- Sub-agentes como herramientas -------------------------------------
  const subAgentTools = await buildSubAgentTools(version, { tenantId: opts.tenantId });

  // Una colisión de nombres entre una herramienta y un sub-agente haría que el
  // modelo llame a una creyendo que llama a la otra. Se corta al construir.
  const seen = new Set(tools.map((t) => t.name));
  for (const sub of subAgentTools) {
    if (seen.has(sub.name)) {
      throw new ValidationError(
        `El sub-agente "${sub.name}" colisiona con una herramienta del mismo nombre. ` +
          `Renombrá uno de los dos: el modelo no puede distinguirlos.`,
      );
    }
    seen.add(sub.name);
  }

  const allTools = [...tools, ...subAgentTools];

  const interruptions = validateInterruptions(version.config?.interruptions ?? []);
  const maxIterations = Number(
    (version.graphConfig as { maxIterations?: number })?.maxIterations ?? cfg.execution.maxIterations,
  );

  log.debug("grafo construido", {
    agentId: version.agentId,
    tools: allTools.length,
    denied: denied.length,
    subAgents: subAgentTools.length,
  });

  return {
    graph: new ReactLoopGraph(maxIterations, interruptions),
    tools: allTools,
    denied,
  };
}

/**
 * Valida las reglas de interrupción AL CONSTRUIR (y el servicio las valida
 * también al guardar, §15.3).
 *
 * Una regla malformada era antes un gate INEXISTENTE que el usuario creía
 * activo, que es el peor de los dos mundos: el operador cree que ninguna
 * escritura ocurre sin su visto bueno, y en realidad todas ocurren.
 */
export function validateInterruptions(rules: InterruptionRule[]): InterruptionRule[] {
  const valid: InterruptionRule[] = [];

  for (const rule of rules) {
    if (rule.trigger === "tool_call") {
      // El emparejamiento es POR NOMBRE: sin nombre no hay nada contra qué
      // emparejar y la regla nunca dispara.
      if (!rule.toolName) {
        throw new ValidationError(
          'Una interrupción por llamada a herramienta exige "toolName": el emparejamiento es por nombre exacto.',
        );
      }
      valid.push(rule);
      continue;
    }

    if (rule.trigger === "turn_count") {
      const n = rule.everyNTurns ?? 0;
      // El cero APAGARÍA el límite en vez de interrumpir siempre, que es lo
      // contrario de lo que espera quien escribe `0`.
      if (!Number.isInteger(n) || n < 1) {
        throw new ValidationError(
          'Una interrupción por conteo de turnos exige "everyNTurns" entero ≥ 1.',
        );
      }
      valid.push(rule);
      continue;
    }

    // El umbral de costo se RECHAZA explícitamente: no tiene implementación en
    // runtime, y aceptarlo sería prometer una compuerta que nunca frena nada.
    throw new ValidationError(
      `Disparador de interrupción no soportado: "${(rule as { trigger?: string }).trigger}". ` +
        `Sólo se aceptan "tool_call" y "turn_count".`,
    );
  }

  return valid;
}
