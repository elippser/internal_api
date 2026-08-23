/**
 * Bucle de razonamiento-acción: `INICIO -> agente -> [herramientas -> agente]* -> FIN` (§11.1).
 *
 * Es el único tipo de grafo habilitado para autoría. Los otros tres siguen en
 * la enumeración con su punto de construcción intacto (ver `factory.ts`).
 *
 * Cuatro decisiones que gobiernan el archivo:
 *
 * 1. PROMPT PARTIDO. El sistema se manda como dos bloques: el prefijo estable
 *    lleva el punto de caché, la cola volátil no. El orden de render del
 *    proveedor es herramientas -> sistema -> mensajes, así que UN punto sobre el
 *    bloque estable cachea las herramientas Y el prefijo, y se reutiliza en cada
 *    iteración del bucle. Meter el contexto dinámico antes del punto invalida
 *    todo lo que viene después y el caché nunca acierta.
 *
 * 2. NODO DE HERRAMIENTAS PARTICIONADO. Las llamadas del turno se agrupan por
 *    clase de concurrencia (ver `tools/partition.ts`) en vez de correr todas en
 *    serie o todas en paralelo.
 *
 * 3. BORDE DE SUPERPASO. Entre el fin de un nodo y el comienzo del siguiente se
 *    revisa cancelación, pausa y tiempo límite. Es el único lugar seguro: a
 *    mitad de una llamada al modelo o de una escritura al PMS no se puede
 *    abandonar sin dejar un efecto a medias.
 *
 * 4. LOS ERRORES DE HERRAMIENTA VUELVEN COMO `tool_result`. El proveedor exige
 *    que TODA `tool_use` tenga su `tool_result` en el mismo mensaje de usuario;
 *    omitir el de la que falló rompe el turno con un 400 que no menciona la
 *    herramienta culpable.
 */
import { getEngineConfig } from "../core/config";
import { createLogger, errField } from "../core/logger";
import { newId } from "../core/ids";
import { resolveModel } from "../llm/client";
import { capabilitiesFor } from "../llm/catalog";
import { translateReasoning, type FlatReasoningParams } from "../llm/reasoning";
import { bindServerTools } from "../tools/factories";
import { executePartitioned, type PartitionableCall } from "../tools/partition";
import { toProviderDefinition, type ResolvedTool } from "../tools/types";
import { SubtaskSuspension } from "../subagents/runner";
import type {
  CompiledGraph,
  GraphDeps,
  GraphResult,
  GraphState,
  InterruptDescriptor,
} from "./types";
import type { InterruptionRule } from "../models/agentVersion.model";

const log = createLogger("engine:graph:react");

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export class ReactLoopGraph implements CompiledGraph {
  readonly type = "react_loop" as const;

  constructor(
    private readonly maxIterations: number,
    private readonly interruptions: InterruptionRule[],
  ) {}

  snapshot(): Record<string, unknown> {
    return {
      type: this.type,
      nodes: ["start", "agent", "tools", "end"],
      edges: [
        { from: "start", to: "agent" },
        { from: "agent", to: "tools", when: "stop_reason=tool_use" },
        { from: "tools", to: "agent" },
        { from: "agent", to: "end", when: "stop_reason=end_turn" },
      ],
      maxIterations: this.maxIterations,
      interruptions: this.interruptions,
    };
  }

  async run(state: GraphState, deps: GraphDeps): Promise<GraphResult> {
    const cfg = getEngineConfig();
    const toolsByName = new Map(deps.tools.map((t) => [t.name, t]));

    // Herramientas del proveedor: las nuestras como definiciones, las de
    // servidor enlazadas contra el modelo del turno (la variante correcta
    // depende del modelo, ver catálogo).
    const localDefs = deps.tools
      .filter((t) => !t.serverTool)
      .map((t) => toProviderDefinition(t));
    const serverDefs = bindServerTools(deps.tools, deps.model);
    const providerTools = [...localDefs, ...serverDefs];

    const system = buildSystemBlocks(deps);

    while (state.iteration < this.maxIterations) {
      // --- BORDE DE SUPERPASO ------------------------------------------
      const boundary = checkBoundary(deps);
      if (boundary) return { outcome: boundary, state };

      state.iteration += 1;

      // --- Interrupción por conteo de turnos ---------------------------
      const turnRule = this.interruptions.find(
        (r) => r.trigger === "turn_count" && (r.everyNTurns ?? 0) >= 1,
      );
      if (
        turnRule &&
        state.turnCount > 0 &&
        state.turnCount % turnRule.everyNTurns! === 0 &&
        // Se recuerda DÓNDE se interrumpió en vez de inflar el contador: al
        // reanudar, el mismo turno no vuelve a disparar, y la cadencia
        // declarada por el autor se mantiene exacta.
        state.lastInterruptTurn !== state.turnCount
      ) {
        state.lastInterruptTurn = state.turnCount;
        return {
          outcome: {
            kind: "interrupted",
            stopReason: "turn_count_interrupt",
            interrupt: {
              reason: "turn_count",
              message:
                turnRule.message ??
                `El agente completó ${turnRule.everyNTurns} turnos. ¿Continuamos?`,
              turnCount: state.turnCount,
            },
          },
          state,
        };
      }

      // --- Nodo agente: llamada al modelo -------------------------------
      const llmDone = deps.recorder.startPhase("llmMs");
      const started = new Date();
      let message: Awaited<ReturnType<typeof callModel>>;
      try {
        message = await callModel(deps, system, providerTools, state);
      } catch (err) {
        llmDone();
        deps.recorder.record({
          kind: "llm_call",
          name: deps.model,
          outcome: "error",
          model: deps.model,
          agentPath: deps.toolContext.agentPath,
          executedByAgentId: deps.toolContext.agentId,
          errorMessage: err instanceof Error ? err.message : String(err),
          execStartedAt: started,
          execCompletedAt: new Date(),
        });
        throw err;
      }
      const llmMs = llmDone();

      const usage = message.usage ?? {};
      deps.recorder.record({
        kind: "llm_call",
        name: deps.model,
        outcome: "success",
        /**
         * SIEMPRE el nombre cualificado que configuró el autor, no el que
         * devolvió el proveedor.
         *
         * Este campo es la CLAVE DE TARIFA del asiento de uso. Un gateway
         * responde con el id del proveedor final río arriba, que no existe en
         * ningún catálogo nuestro: usarlo hacía que la tarificación cayera a la
         * reserva y el costo quedara decenas de veces por encima del real.
         * El id que informó el proveedor queda en la carga cruda del paso.
         */
        model: deps.model,
        provider: message.provider,
        stopReason: message.stopReason ?? null,
        tokensInput: usage.input_tokens ?? 0,
        tokensOutput: usage.output_tokens ?? 0,
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        reasoningTokens: usage.reasoning_output_tokens ?? 0,
        agentPath: deps.toolContext.agentPath,
        executedByAgentId: deps.toolContext.agentId,
        execStartedAt: started,
        execCompletedAt: new Date(),
        latencyMs: llmMs,
        rawRequest: message.rawRequest,
        rawResponse: message.rawContent,
      });

      state.turnCount += 1;
      state.messages.push({ role: "assistant", content: message.rawContent });

      const text = extractText(message.rawContent);
      // Se normalizan a una forma tipada en vez de estrechar con un predicado:
      // los bloques del proveedor son bolsas sin tipar y el `input` puede venir
      // ausente en un bloque truncado. Normalizar acá evita repetir la defensa
      // en cada uno de los cuatro sitios que después los usan.
      const toolUses: ToolUseBlock[] = message.rawContent
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          type: "tool_use" as const,
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: (b.input ?? {}) as Record<string, unknown>,
        }));

      // El proveedor pausó su propio bucle de herramientas de servidor: se
      // reenvía tal cual, SIN agregar un turno de usuario. Un "continuá"
      // artificial confunde al modelo, que ya sabe reanudar solo.
      if (message.stopReason === "pause_turn") {
        deps.emit("status", { phase: "provider_pause", iteration: state.iteration });
        continue;
      }

      // El clasificador de seguridad del proveedor declinó: es un desenlace de
      // contenido con HTTP 200, no una excepción. Leer `content[0]` sin
      // revisarlo primero rompe acá.
      if (message.stopReason === "refusal") {
        state.lastText = text;
        return {
          outcome: {
            kind: "completed",
            text:
              text ||
              "No puedo ayudar con eso. Si creés que es un error, reformulá el pedido o escalalo al equipo.",
            stopReason: "refusal",
          },
          state,
        };
      }

      if (toolUses.length === 0) {
        state.lastText = text;
        return {
          outcome: { kind: "completed", text, stopReason: message.stopReason ?? "end_turn" },
          state,
        };
      }

      // --- Interrupción por llamada a herramienta -----------------------
      const gated = toolUses.find((call) =>
        this.interruptions.some((r) => r.trigger === "tool_call" && r.toolName === call.name),
      );
      if (gated) {
        const rule = this.interruptions.find(
          (r) => r.trigger === "tool_call" && r.toolName === gated.name,
        );
        const interrupt: InterruptDescriptor = {
          reason: "tool_call",
          message: rule?.message ?? `El agente quiere ejecutar "${gated.name}". ¿Autorizás?`,
          toolName: gated.name,
          toolCallId: gated.id,
          toolArgs: gated.input,
        };
        deps.emit("interrupt", { ...interrupt });
        return { outcome: { kind: "interrupted", interrupt, stopReason: "approval_required" }, state };
      }

      // --- Nodo de herramientas particionado ----------------------------
      // El texto que el modelo escribió ANTES de pedir herramientas es un
      // preámbulo ("dejame buscar eso..."), y el cierre no lo conserva: la
      // respuesta final es sólo el texto de la última iteración. Se avisa a
      // quien está mirando en vivo para que limpie su borrador, o terminaría
      // mostrando un texto que después no coincide con el que se guardó.
      if (text) deps.emit("text_reset", { reason: "tool_use" });

      const toolDone = deps.recorder.startPhase("toolMs");
      const groupId = newId("grp");

      const calls: PartitionableCall<ToolUseBlock>[] = toolUses.map((call) => ({
        item: call,
        concurrency: toolsByName.get(call.name)?.concurrency ?? "write",
      }));

      let suspension: SubtaskSuspension | null = null;

      const results = await executePartitioned<ToolUseBlock, Record<string, unknown>>(
        calls,
        async (call) => {
          const tool = toolsByName.get(call.name);
          const t0 = new Date();

          // `!tool.execute` cubre el caso de una herramienta de SERVIDOR que
          // llegó como `tool_use`. No debería pasar (el proveedor las resuelve
          // de su lado y emite `server_tool_use`), pero si pasara, invocar un
          // ejecutor inexistente reventaría el turno entero en vez de devolver
          // un resultado que el modelo pueda leer.
          if (!tool || !tool.execute) {
            // La herramienta no existe o fue retirada por piso de rol: se
            // devuelve una NEGACIÓN EXPLICATIVA, no un silencio. El modelo
            // puede pedirle al usuario que escale o buscar otra ruta.
            deps.recorder.record({
              kind: "tool_call",
              name: call.name,
              outcome: "blocked",
              groupId,
              toolCallId: call.id,
              input: call.input,
              errorMessage: "herramienta no disponible para este principal",
              execStartedAt: t0,
              execCompletedAt: new Date(),
              agentPath: deps.toolContext.agentPath,
            });
            return {
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: JSON.stringify({
                ok: false,
                error:
                  `La herramienta "${call.name}" no está disponible en esta sesión ` +
                  `(no existe, está inactiva o requiere más permisos).`,
              }),
            };
          }

          deps.emit("tool_call", { name: call.name, toolCallId: call.id, args: call.input });

          try {
            if (deps.signal.cancelled) throw new Error("Ejecución cancelada");
            const output = await tool.execute!(
              { ...call.input, __toolCallId: call.id },
              deps.toolContext,
            );
            const t1 = new Date();

            deps.recorder.record({
              kind: tool.type === "sub_agent" ? "sub_agent_call" : "tool_call",
              name: call.name,
              outcome: "success",
              groupId,
              toolCallId: call.id,
              concurrencyMode: tool.concurrency,
              input: call.input,
              output,
              execStartedAt: t0,
              execCompletedAt: t1,
              agentPath: deps.toolContext.agentPath,
            });

            deps.emit("tool_result", { name: call.name, toolCallId: call.id, ok: true });

            return {
              type: "tool_result",
              tool_use_id: call.id,
              content: typeof output === "string" ? output : JSON.stringify(output),
            };
          } catch (err) {
            if (err instanceof SubtaskSuspension) {
              // No es un error: es control de flujo. Se retiene y se propaga
              // DESPUÉS de que termine el lote, para no dejar a medias las
              // herramientas hermanas que ya estaban corriendo.
              suspension = err;
              return {
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify({ ok: true, pending: true, subAgent: err.subAgentName }),
              };
            }
            throw err;
          }
        },
        (call, _index, err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("herramienta falló", { name: call.name, ...errField(err) });
          deps.recorder.record({
            kind: "tool_call",
            name: call.name,
            outcome: "error",
            groupId,
            toolCallId: call.id,
            input: call.input,
            errorMessage: message,
            agentPath: deps.toolContext.agentPath,
          });
          deps.emit("tool_result", { name: call.name, toolCallId: call.id, ok: false });
          // El error vuelve COMO tool_result: omitirlo rompe el emparejamiento
          // que exige el proveedor.
          return {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: JSON.stringify({ ok: false, error: message }),
          };
        },
      );

      toolDone();

      // TODOS los resultados en UN SOLO mensaje de usuario. Partirlos en varios
      // le enseña al modelo a dejar de pedir herramientas en paralelo.
      state.messages.push({ role: "user", content: results });

      if (suspension) {
        const s = suspension as SubtaskSuspension;
        return {
          outcome: {
            kind: "suspended",
            childExecutionIds: s.childExecutionIds,
            stopReason: "waiting_for_subtask",
          },
          state,
        };
      }
    }

    // Tope de iteraciones: se cierra con lo que haya en vez de girar para
    // siempre. El texto de la última iteración es la mejor respuesta disponible.
    log.warn("tope de iteraciones alcanzado", { max: this.maxIterations });
    return {
      outcome: {
        kind: "completed",
        text:
          state.lastText ||
          "No pude cerrar la tarea dentro del límite de pasos. Acotá el pedido y volvé a intentar.",
        stopReason: "max_iterations",
      },
      state,
    };
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function checkBoundary(deps: GraphDeps): GraphResult["outcome"] | null {
  if (deps.signal.cancelled) {
    return { kind: "cancelled", stopReason: "cancelled_by_user" };
  }
  if (deps.signal.pauseRequested) {
    return { kind: "paused", stopReason: "paused_by_user" };
  }
  if (Date.now() > deps.signal.deadline) {
    return { kind: "cancelled", stopReason: "timeout" };
  }
  return null;
}

/**
 * Bloques de sistema con el punto de caché sobre el prefijo estable. El bloque
 * dinámico va DESPUÉS y sin marca: si llevara `cache_control`, cada turno
 * escribiría una entrada de caché nueva que nadie va a leer, pagando la prima
 * de escritura sin ningún acierto.
 */
function buildSystemBlocks(deps: GraphDeps): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const ttl = deps.version.config?.context?.cacheTtl;

  if (deps.systemStatic.trim()) {
    blocks.push({
      type: "text",
      text: deps.systemStatic,
      cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
    });
  }
  if (deps.systemDynamic.trim()) {
    blocks.push({ type: "text", text: deps.systemDynamic });
  }
  return blocks;
}

interface ModelCallResult {
  rawContent: Array<Record<string, unknown>>;
  rawRequest: Record<string, unknown>;
  stopReason: string | null;
  model: string | null;
  provider: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

async function callModel(
  deps: GraphDeps,
  system: Record<string, unknown>[],
  tools: Record<string, unknown>[],
  state: GraphState,
): Promise<ModelCallResult> {
  const { client, model, provider } = resolveModel(deps.model);
  const caps = capabilitiesFor(deps.model);

  const { params, adjustments } = translateReasoning(
    deps.model,
    (deps.version.modelParams ?? {}) as FlatReasoningParams,
    { defaultMaxTokens: Math.min(8_192, caps.maxOutputTokens) },
  );

  if (adjustments.length > 0) {
    deps.emit("status", { phase: "model_params_adjusted", adjustments });
  }

  const body: Record<string, unknown> = {
    model,
    system,
    messages: state.messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...params,
  };

  const stream = client.stream(body);

  // Deltas al bus: el cliente pinta la respuesta mientras se escribe. Van por
  // el bus pero NO al diario persistido (ver events/protocol.ts).
  stream.on("text", (delta: string) => {
    deps.emit("token", { text: delta });
  });

  const final = await stream.finalMessage();

  return {
    rawContent: (final.content ?? []) as Array<Record<string, unknown>>,
    // El cuerpo se guarda SIN los mensajes: el historial completo por paso
    // multiplicaría la tabla fría por el número de iteraciones. Lo que importa
    // para depurar es qué sistema, qué herramientas y qué parámetros fueron.
    rawRequest: { model, system, tools, ...params },
    stopReason: final.stop_reason ?? null,
    model: final.model ?? model,
    provider,
    usage: final.usage ?? {},
  };
}

function extractText(content: Array<Record<string, unknown>>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}
