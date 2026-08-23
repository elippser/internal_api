/**
 * Corredor de grafos EN LÍNEA, para el modo `inline` de sub-agente (§14).
 *
 * Construye el grafo del hijo y lo corre dentro del proceso y de la ranura del
 * padre. No crea una fila de ejecución: los pasos del hijo se graban en el
 * grabador del PADRE, atribuidos por `agentPath`. Por eso el modo en línea es
 * barato (sin encolado, sin reclamo, sin sondeo) y por eso su gasto pertenece a
 * la ejecución padre.
 *
 * Aislamiento de contexto: el hijo arranca con `emptyState(task)` — mensajes
 * VACÍOS más la cadena de tarea que compuso el padre. Nunca ve la conversación
 * del padre. Es lo que hace que delegar sirva para algo: si el hijo heredara el
 * contexto, no habría ahorro de tokens ni foco.
 */
import { getEngineConfig } from "../core/config";
import { createLogger } from "../core/logger";
import { buildGraph } from "../graph/factory";
import { emptyState } from "../graph/types";
import { registerInlineGraphRunner } from "../subagents/runner";
import { StepRecorder } from "./stepRecorder";
import { buildPromptParts } from "./prompt";
import type { EngineExecutionDoc } from "../models/execution.model";

const log = createLogger("engine:inline");

export function installInlineGraphRunner(): void {
  registerInlineGraphRunner(async ({ version, task, ctx, modelOverride, toolAllowlist }) => {
    const cfg = getEngineConfig();

    const built = await buildGraph(version, {
      tenantId: ctx.tenantId,
      role: ctx.role,
      // Subconjunto curado de la delegación: un sub-agente especializado no
      // recibe el paquete completo de su propia versión si el padre lo acotó.
      toolAllowlist: toolAllowlist ?? null,
    });

    // Grabador propio para poder contabilizar el tramo, con la ruta de agentes
    // ya puesta para que la atribución del costo sea correcta.
    const recorder = new StepRecorder(ctx.executionId, ctx.tenantId, null, ctx.agentId);

    const prompt = buildPromptParts({
      version,
      // La ejecución del padre alcanza para las variables de contexto: el hijo
      // corre dentro de ella.
      execution: {
        trigger: "sub_agent",
        responseMode: "async",
        depth: ctx.depth,
        input: {},
      } as unknown as EngineExecutionDoc,
      agentName: version.agentId,
      tools: built.tools,
      denied: built.denied,
    });

    const model = modelOverride || version.modelName;
    const state = emptyState(task);

    const result = await built.graph.run(state, {
      version,
      systemStatic: prompt.static,
      systemDynamic: prompt.dynamic,
      tools: built.tools,
      model,
      recorder,
      toolContext: ctx,
      emit: (type, payload) => ctx.emit?.(type, payload),
      signal: {
        cancelled: ctx.signal?.cancelled ?? false,
        pauseRequested: false,
        // El hijo en línea hereda un límite propio, más corto que el del padre:
        // sin esto una delegación colgada consume el tiempo entero de la
        // corrida padre y el padre nunca llega a responder.
        deadline: Date.now() + cfg.execution.defaultTimeoutSeconds * 1000,
      },
    });

    const totals = recorder.totals();
    const text =
      result.outcome.kind === "completed"
        ? result.outcome.text
        : `[El sub-agente terminó sin respuesta: ${result.outcome.stopReason}]`;

    log.debug("sub-agente en línea terminado", {
      agentPath: ctx.agentPath,
      outcome: result.outcome.kind,
      steps: totals.stepCount,
    });

    return {
      text,
      tokensInput: totals.tokensInput,
      tokensOutput: totals.tokensOutput,
    };
  });
}
