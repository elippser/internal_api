/**
 * Corredor de ejecuciones: las doce fases de una corrida (§10.3).
 *
 * Recibe una fila YA RECLAMADA (el bucle de trabajo se encargó de eso) y la
 * lleva hasta un estado de "dejá de esperar". Nunca lanza hacia arriba: toda
 * salida, incluida la catastrófica, se traduce a un estado con diagnóstico.
 * Si dejara escapar una excepción, el bucle de reclamo perdería la corrida y
 * habría que esperar noventa segundos al detector de zombies para saber que
 * falló algo que ya sabemos.
 *
 * Las tres fases que más se rompen en la práctica, y por qué están donde están:
 *
 *  - El SONDEO DE CONTROL corre en paralelo al grafo. La API sólo levanta
 *    banderas (§35.5); alguien tiene que leerlas, y no puede ser el grafo,
 *    porque el grafo está adentro de una llamada al modelo que dura minutos.
 *  - El LATIDO corre en paralelo también. Si se detiene, el detector de zombies
 *    da la corrida por perdida aunque esté perfectamente viva.
 *  - La FINALIZACIÓN escribe pasos y asientos ANTES de estampar el estado, para
 *    que un corte deje evidencia huérfana (recuperable) y no una corrida
 *    exitosa sin costo (silenciosa).
 */
import { getEngineConfig } from "../core/config";
import { asEngineError } from "../core/errors";
import { createLogger, errField } from "../core/logger";
import { extendScope } from "../core/scope";
import { publish, releaseExecution } from "../events/bus";
import { buildGraph } from "../graph/factory";
import { emptyState, type GraphSignal, type GraphState } from "../graph/types";
import { capabilitiesFor } from "../llm/catalog";
import { EngineAgent } from "../models/agent.model";
import {
  EngineAgentVersion,
  type EngineAgentVersionDoc,
} from "../models/agentVersion.model";
import {
  EngineExecution,
  type EngineExecutionDoc,
} from "../models/execution.model";
import type { EventType } from "../events/protocol";
import type { FailureReason } from "../models/enums";
import { buildPromptParts, compactHistory } from "./prompt";
import { loadHistory, recordAssistantMessage, sanitizeHistory } from "./session";
import { renderSkillsBlock, resolveSkills } from "../skills/resolver";
import { finalizeExecution, safetyNetFinalize } from "./persistence";
import { StepRecorder } from "./stepRecorder";
import { validateOutputSchema } from "./outputSchema";
import { redactSecrets } from "./redaction";

const log = createLogger("engine:runner");

export interface RunOutcome {
  status: EngineExecutionDoc["status"];
  executionId: string;
}

export async function runExecution(execution: EngineExecutionDoc): Promise<RunOutcome> {
  const cfg = getEngineConfig();

  // --- FASE 1: ámbito ambiental y contexto de bitácora -------------------
  return extendScope(
    {
      tenantId: execution.tenantId,
      organizationId: execution.organizationId,
      userId: execution.userId ?? null,
      executionId: execution.executionId,
      agentId: execution.agentId,
      workerId: cfg.worker.id,
    },
    async () => {
      const recorder = new StepRecorder(
        execution.executionId,
        execution.tenantId,
        execution.organizationId,
        execution.agentId,
      );
      recorder.seedIndex(execution.stepCount ?? 0);

      const emit = (type: string, payload: Record<string, unknown>): void => {
        publish(execution.executionId, type as EventType, { data: payload }, execution.tenantId);
      };
      const emitToken = (text: string): void => {
        publish(execution.executionId, "token", { text }, execution.tenantId);
      };

      const signal: GraphSignal = {
        cancelled: execution.cancelRequested === true,
        pauseRequested: execution.pauseRequested === true,
        deadline: deadlineFor(execution, cfg.execution.maxDurationSeconds),
      };

      const stopControlPoll = startControlPoll(execution.executionId, signal);

      const setupDone = recorder.startPhase("setupMs");

      try {
        emit("status", { phase: "starting" });

        // --- FASE 2: versión del agente ------------------------------
        const version = await EngineAgentVersion.findOne({
          versionId: execution.versionId,
        }).lean();
        if (!version) {
          throw asEngineError(
            new Error(`La versión ${execution.versionId} de la corrida ya no existe`),
          );
        }
        const agent = await EngineAgent.findOne({ agentId: execution.agentId }).lean();

        // --- FASES 3-5: sesión, credenciales, ámbito de memoria -------
        // PUNTO DE EXTENSIÓN. La inyección de credenciales desde un gestor de
        // secretos (§29) y la resolución de ámbito de memoria (§17) entran acá.
        // Cuando se implementen, las credenciales van a la CONFIGURACIÓN de
        // ejecución (las dependencias del grafo), nunca al estado ni al punto
        // de control (§35.8).

        // --- FASE 8: construcción del grafo ---------------------------
        const built = await buildGraph(version as EngineAgentVersionDoc, {
          tenantId: execution.tenantId,
          role: execution.input?.role as string | undefined,
          toolAllowlist: (execution.input?.toolAllowlist as string[] | undefined) ?? null,
        });

        // --- FASE 6: renderizado del prompt ---------------------------
        // Habilidades: sólo el NIVEL 1 entra al prompt. El cuerpo lo carga
        // `load_skill` bajo demanda (§19).
        const skills = await resolveSkills({
          tenantId: execution.tenantId,
          agentId: execution.agentId,
          userId: execution.userId,
          declared: version.skills ?? [],
        });

        const prompt = buildPromptParts({
          version: version as EngineAgentVersionDoc,
          execution,
          agentName: agent?.name ?? execution.agentId,
          tools: built.tools,
          denied: built.denied,
          skillsBlock: renderSkillsBlock(skills),
        });

        // El modelo efectivo: la versión manda, salvo que el turno traiga una
        // superposición explícita.
        const model =
          (execution.input?.modelOverride as string | undefined) || version.modelName;

        // --- FASE 7: guardarraíles de entrada y ganchos previos -------
        // PUNTO DE EXTENSIÓN §15.1/§15.2.

        // --- FASE 9: instantánea y arranque de la traza ---------------
        await EngineExecution.updateOne(
          { executionId: execution.executionId },
          {
            $set: {
              graphStartedAt: new Date(),
              resolvedSystemPrompt: [prompt.static, prompt.dynamic]
                .filter(Boolean)
                .join("\n\n---\n\n"),
              graphSnapshot: built.graph.snapshot(),
              resolvedVersions: {
                [execution.agentId]: version.versionId,
              },
            },
          },
        );

        setupDone();

        // --- FASE 10: recorrido del grafo -----------------------------
        const state = await restoreOrCreateState(execution, version as EngineAgentVersionDoc, model);

        emit("status", { phase: "running", model, tools: built.tools.length });

        const result = await built.graph.run(state, {
          version: version as EngineAgentVersionDoc,
          systemStatic: prompt.static,
          systemDynamic: prompt.dynamic,
          tools: built.tools,
          model,
          recorder,
          toolContext: {
            executionId: execution.executionId,
            agentId: execution.agentId,
            tenantId: execution.tenantId,
            userId: execution.userId ?? null,
            companyId: (execution.input?.companyId as string | undefined) ?? execution.tenantId,
            propertyId: (execution.input?.propertyId as string | undefined) ?? null,
            sessionId: execution.sessionId ?? null,
            role: (execution.input?.role as string | undefined) ?? null,
            depth: execution.depth,
            agentPath: agent?.slug ?? execution.agentId,
            // `load_skill` respeta el mismo selector que el prompt.
            declaredSkills: version.skills ?? [],
            emit,
            signal,
          },
          emit: (type, payload) => {
            if (type === "token" && typeof payload.text === "string") {
              emitToken(payload.text);
              return;
            }
            emit(type, payload);
          },
          signal,
        });

        // --- FASE 12: cierre -----------------------------------------
        const finalizeDone = recorder.startPhase("finalizeMs");
        const outcome = await closeOut(execution, version as EngineAgentVersionDoc, result, recorder);
        finalizeDone();

        emit("status", { phase: "finished", status: outcome.status });
        publish(execution.executionId, "done", { data: { status: outcome.status } }, execution.tenantId);
        releaseExecution(execution.executionId);

        return outcome;
      } catch (err) {
        const e = asEngineError(err);
        log.error("la corrida falló", { ...errField(err) });

        const failureReason = classifyFailure(err);
        try {
          await finalizeExecution({
            executionId: execution.executionId,
            recorder,
            patch: {
              status: "failed",
              completedAt: new Date(),
              errorMessage: e.message,
              failureReason,
              failureDetails: {
                workerId: cfg.worker.id,
                engineVersion: PROTOCOL_ENGINE_VERSION,
              },
              tenantId: execution.tenantId,
            },
          });
        } catch (persistErr) {
          // La red de seguridad del bucle de reclamo: si ni siquiera se pudo
          // finalizar, al menos que no quede colgada en `running`.
          await safetyNetFinalize(execution.executionId, {
            status: "failed",
            errorMessage: e.message,
            failureReason,
          });
          log.error("no se pudo finalizar la corrida fallida", { ...errField(persistErr) });
        }

        publish(
          execution.executionId,
          "error",
          { text: e.message, data: { code: e.code, failureReason } },
          execution.tenantId,
        );
        publish(execution.executionId, "done", { data: { status: "failed" } }, execution.tenantId);
        releaseExecution(execution.executionId);

        return { status: "failed", executionId: execution.executionId };
      } finally {
        stopControlPoll();
      }
    },
  );
}

const PROTOCOL_ENGINE_VERSION = "engine-core-1";

// ---------------------------------------------------------------------------
// Cierre por tipo de desenlace
// ---------------------------------------------------------------------------

async function closeOut(
  execution: EngineExecutionDoc,
  version: EngineAgentVersionDoc,
  result: Awaited<ReturnType<Awaited<ReturnType<typeof buildGraph>>["graph"]["run"]>>,
  recorder: StepRecorder,
): Promise<RunOutcome> {
  const { outcome, state } = result;
  const now = new Date();
  const base = { tenantId: execution.tenantId, completedAt: now } as const;

  if (outcome.kind === "completed") {
    // Redacción de secretos ANTES de validar y de persistir: si un secreto
    // llegó a la salida, no puede quedar en la fila ni salir por el callback.
    const text = redactSecrets(outcome.text);

    const validation = validateOutputSchema(version.outputSchema ?? null, text);
    if (!validation.ok) {
      await finalizeExecution({
        executionId: execution.executionId,
        recorder,
        patch: {
          ...base,
          status: "failed",
          outputText: text,
          errorMessage: `La salida no cumple el esquema declarado: ${validation.error}`,
          failureReason: "output_schema",
          checkpoint: null,
        },
      });
      return { status: "failed", executionId: execution.executionId };
    }

    await finalizeExecution({
      executionId: execution.executionId,
      recorder,
      patch: {
        ...base,
        status: "succeeded",
        outputText: text,
        output: validation.value ?? text,
        // El punto de control se libera al terminar: es estado interno del
        // grafo y puede pesar tanto como el transcripto completo.
        checkpoint: null,
        interrupt: null,
      },
    });
    // El turno del asistente se persiste con sus BLOQUES crudos: el próximo
    // turno reenvía el historial y sin los pares tool_use/tool_result el
    // proveedor lo rechaza.
    if (execution.sessionId) {
      const totals = recorder.totals();
      const lastAssistant = [...state.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      await recordAssistantMessage(
        execution.sessionId,
        execution.agentId,
        execution.tenantId,
        text,
        lastAssistant?.content ?? null,
        execution.executionId,
        {
          tokensInput: totals.tokensInput,
          tokensOutput: totals.tokensOutput,
          costUsd: totals.costUsd,
        },
      );
    }

    await deliverCallback(execution, { status: "succeeded", output: validation.value ?? text });
    return { status: "succeeded", executionId: execution.executionId };
  }

  if (outcome.kind === "interrupted") {
    await finalizeExecution({
      executionId: execution.executionId,
      recorder,
      patch: {
        tenantId: execution.tenantId,
        status: "waiting_for_input",
        interrupt: { ...outcome.interrupt },
        checkpoint: serializeState(state),
        // NO se estampa `completedAt`: la corrida no terminó, está esperando.
        workerId: null,
        heartbeatAt: null,
      },
    });
    return { status: "waiting_for_input", executionId: execution.executionId };
  }

  if (outcome.kind === "suspended") {
    await finalizeExecution({
      executionId: execution.executionId,
      recorder,
      patch: {
        tenantId: execution.tenantId,
        status: "waiting_for_subtask",
        checkpoint: serializeState(state),
        // Se LIBERA la ranura del carril: el despertador re-encola cuando los
        // hijos terminen. Es lo que distingue el modo asíncrono del remoto.
        workerId: null,
        heartbeatAt: null,
      },
    });
    return { status: "waiting_for_subtask", executionId: execution.executionId };
  }

  if (outcome.kind === "paused") {
    // Recién ACÁ se escribe el estado pausado: el trabajador ya soltó la fila,
    // así que reanudar es seguro (§35.5).
    await finalizeExecution({
      executionId: execution.executionId,
      recorder,
      patch: {
        tenantId: execution.tenantId,
        status: "paused",
        pauseRequested: false,
        checkpoint: serializeState(state),
        workerId: null,
        heartbeatAt: null,
      },
    });
    return { status: "paused", executionId: execution.executionId };
  }

  const cancelled = outcome.stopReason === "timeout";
  await finalizeExecution({
    executionId: execution.executionId,
    recorder,
    patch: {
      ...base,
      status: cancelled ? "timed_out" : "cancelled",
      errorMessage: cancelled
        ? "La corrida superó su tiempo límite"
        : "Cancelada por el usuario",
      failureReason: cancelled ? "timeout" : "cancelled_by_user",
      checkpoint: null,
    },
  });
  return {
    status: cancelled ? "timed_out" : "cancelled",
    executionId: execution.executionId,
  };
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/**
 * Sondeo de las banderas de control. La API sólo levanta banderas; este bucle
 * las traslada a la señal síncrona que el grafo mira en cada borde de superpaso.
 *
 * Dos segundos es el intercambio elegido: un botón de cancelar que tarda hasta
 * dos segundos en tomar efecto se siente inmediato, y una consulta cada dos
 * segundos por corrida en vuelo es despreciable contra el costo de un turno.
 */
function startControlPoll(executionId: string, signal: GraphSignal): () => void {
  const timer = setInterval(() => {
    void EngineExecution.findOne(
      { executionId },
      { pauseRequested: 1, cancelRequested: 1 },
    )
      .lean()
      .then((doc) => {
        if (!doc) return;
        if (doc.cancelRequested) signal.cancelled = true;
        if (doc.pauseRequested) signal.pauseRequested = true;
      })
      .catch(() => {
        // Falla abierta: perder un sondeo no justifica matar la corrida.
      });
  }, 2_000);
  timer.unref();
  return () => clearInterval(timer);
}

function deadlineFor(execution: EngineExecutionDoc, maxDurationSeconds: number): number {
  const hard = Date.now() + maxDurationSeconds * 1000;
  const declared = execution.timeoutAt ? new Date(execution.timeoutAt).getTime() : hard;
  return Math.min(hard, declared);
}

/**
 * Restaura el estado desde el punto de control (reanudación) o lo crea nuevo.
 *
 * En la reanudación de una interrupción de aprobación, la carga del humano
 * entra como un turno de usuario: es la forma que el proveedor entiende, y deja
 * la decisión registrada en el transcripto para auditoría.
 */
async function restoreOrCreateState(
  execution: EngineExecutionDoc,
  version: EngineAgentVersionDoc,
  model: string,
): Promise<GraphState> {
  const checkpoint = execution.checkpoint as GraphState | null;

  if (checkpoint?.messages?.length) {
    const state: GraphState = {
      messages: checkpoint.messages,
      iteration: checkpoint.iteration ?? 0,
      turnCount: checkpoint.turnCount ?? 0,
      // Sin este campo, reanudar una interrupción por conteo de turnos vuelve a
      // interrumpir en el mismo turno y la corrida entra en bucle de aprobación.
      lastInterruptTurn: checkpoint.lastInterruptTurn ?? 0,
      lastText: checkpoint.lastText ?? "",
    };

    if (execution.resumePayload !== null && execution.resumePayload !== undefined) {
      const payload =
        typeof execution.resumePayload === "string"
          ? execution.resumePayload
          : JSON.stringify(execution.resumePayload);
      state.messages.push({ role: "user", content: `[Respuesta del operador] ${payload}` });
    }

    const caps = capabilitiesFor(model);
    void caps;
    state.messages = compactHistory(state.messages, 0);
    return state;
  }

  const text =
    execution.inputText ??
    (typeof execution.input?.task === "string" ? execution.input.task : "") ??
    "";
  const content = execution.input?.content ?? text;
  void version;

  const fresh = emptyState(content);

  // Continuidad conversacional: el turno nuevo se apoya sobre el historial de
  // la sesión. Sin esto cada mensaje arranca de cero y el agente no recuerda
  // nada de lo que se acaba de decir.
  if (execution.sessionId) {
    const turns = version.config?.context?.historyWindowMessages;
    const history = await loadHistory(
      execution.sessionId,
      turns ? Math.max(1, Math.floor(turns / 2)) : undefined,
    );
    if (history.length > 0) {
      fresh.messages = sanitizeHistory([...history, ...fresh.messages]);
    }
  }

  return fresh;
}

/** El estado va al punto de control tal cual: es serializable por contrato. */
function serializeState(state: GraphState): Record<string, unknown> {
  return {
    messages: state.messages,
    iteration: state.iteration,
    turnCount: state.turnCount,
    lastInterruptTurn: state.lastInterruptTurn,
    lastText: state.lastText,
  };
}

function classifyFailure(err: unknown): FailureReason {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (/context|too long|max.*token|prompt is too long/.test(message)) return "context_overflow";
  if (/timeout|timed out|abort/.test(message)) return "timeout";
  if (/rate.?limit|overloaded|529|429/.test(message)) return "provider_error";
  // Un 401/403 del proveedor NO es una falla del proveedor: es una credencial
  // mal configurada. La distinción cambia qué hace el operador — reintentar no
  // sirve, y en el informe de fallas por motivo mezclarlas esconde el problema
  // real detrás de "el proveedor anda mal".
  if (/\b(401|403)\b|unauthorized|forbidden|invalid api key|user not found/.test(message)) {
    return "config_error";
  }
  if (/api|anthropic|openrouter|provider|status 5\d\d/.test(message)) return "provider_error";
  if (/no está implementado|not implemented/.test(message)) return "config_error";
  if (/inválid|invalid|validation|esquema/.test(message)) return "config_error";
  return "unknown";
}

/**
 * Entrega por callback. Mejor esfuerzo y con tiempo límite: un endpoint del
 * cliente que no responde no puede dejar colgado al trabajador ni cambiar el
 * estado de una corrida que ya terminó bien.
 */
async function deliverCallback(
  execution: EngineExecutionDoc,
  body: Record<string, unknown>,
): Promise<void> {
  if (!execution.callbackUrl) return;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    await fetch(execution.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionId: execution.executionId, ...body }),
      signal: controller.signal,
    });
    clearTimeout(t);
  } catch (err) {
    log.warn("no se pudo entregar el callback", {
      executionId: execution.executionId,
      ...errField(err),
    });
  }
}
