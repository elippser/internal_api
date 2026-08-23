/**
 * Grabador de pasos: acumula en MEMORIA durante la corrida y persiste una vez
 * al final (§10.4).
 *
 * Por qué en memoria y no escribiendo paso a paso: un turno con diez
 * herramientas produce diez inserciones más diez actualizaciones de contadores
 * en el camino caliente, y cada una es un viaje a la base mientras el usuario
 * espera. Acumular y escribir una vez baja eso a una operación por corrida.
 *
 * El costo del intercambio es real y está asumido: si el proceso muere a mitad
 * de una corrida, los pasos acumulados se pierden. Lo que NO se pierde es la
 * ejecución — sigue en `running` con el latido vencido, el detector de zombies
 * la marca expirada con evidencia, y se puede reintentar. Perder la traza de
 * una corrida que igual falló es aceptable; lo inaceptable sería perder el
 * costo de una corrida que sí terminó, y eso lo cubre `persistence.ts`
 * escribiendo pasos y asientos ANTES de marcar la ejecución como terminada.
 */
import { newId } from "../core/ids";
import { computeCost } from "../llm/pricing";
import type { EngineExecutionStepDoc } from "../models/executionStep.model";
import type { EngineUsageRecordDoc } from "../models/usageRecord.model";
import type { PhaseTimings } from "../models/execution.model";
import type { ConcurrencyMode, StepKind, StepOutcome } from "../models/enums";

export interface RecordStepInput {
  kind: StepKind;
  name: string;
  outcome?: StepOutcome;
  groupId?: string | null;
  toolCallId?: string | null;
  concurrencyMode?: ConcurrencyMode | null;
  execStartedAt?: Date | null;
  execCompletedAt?: Date | null;
  executedByAgentId?: string | null;
  agentPath?: string | null;
  model?: string | null;
  provider?: string | null;
  stopReason?: string | null;
  tokensInput?: number;
  tokensOutput?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  input?: unknown;
  output?: unknown;
  errorMessage?: string | null;
  /** Carga cruda del proveedor. Va a la tabla fría, no al paso caliente. */
  rawRequest?: unknown;
  rawResponse?: unknown;
  /** Latencia de la llamada, para el asiento de uso. */
  latencyMs?: number;
  /** El gasto lo cubre una suscripción: el costo va a nocional, no a costo real. */
  billingMode?: "api" | "subscription";
}

export interface PendingPayload {
  stepId: string;
  request: unknown;
  response: unknown;
}

export class StepRecorder {
  private readonly steps: EngineExecutionStepDoc[] = [];
  private readonly usage: EngineUsageRecordDoc[] = [];
  private readonly payloads: PendingPayload[] = [];
  private index = 0;

  /** Fases NO SOLAPADAS: cada milisegundo se cotiza en exactamente una. */
  readonly timings: PhaseTimings = {
    queueMs: 0,
    setupMs: 0,
    llmMs: 0,
    toolMs: 0,
    overheadMs: 0,
    finalizeMs: 0,
  };

  constructor(
    private readonly executionId: string,
    private readonly tenantId: string | null,
    private readonly organizationId: string | null,
    private readonly agentId: string,
  ) {}

  addPhase(phase: keyof PhaseTimings, ms: number): void {
    this.timings[phase] += Math.max(0, ms);
  }

  /** Cronómetro de fase: devuelve la función que cierra y acumula. */
  startPhase(phase: keyof PhaseTimings): () => number {
    const t0 = Date.now();
    return () => {
      const elapsed = Date.now() - t0;
      this.addPhase(phase, elapsed);
      return elapsed;
    };
  }

  record(input: RecordStepInput): EngineExecutionStepDoc {
    const stepId = newId("step");
    const now = new Date();

    const tokensInput = input.tokensInput ?? 0;
    const tokensOutput = input.tokensOutput ?? 0;
    const cachedInputTokens = input.cachedInputTokens ?? 0;
    const cacheCreationTokens = input.cacheCreationTokens ?? 0;
    const reasoningTokens = input.reasoningTokens ?? 0;

    const billable = input.kind === "llm_call" && input.model;
    const cost = billable
      ? computeCost(input.model!, {
          tokensInput,
          tokensOutput,
          cacheReadTokens: cachedInputTokens,
          cacheCreationTokens,
          reasoningTokens,
        })
      : null;

    const subscription = input.billingMode === "subscription";

    const step: EngineExecutionStepDoc = {
      stepId,
      executionId: this.executionId,
      tenantId: this.tenantId,
      index: this.index++,
      kind: input.kind,
      name: input.name,
      outcome: input.outcome ?? "success",
      groupId: input.groupId ?? null,
      toolCallId: input.toolCallId ?? null,
      concurrencyMode: input.concurrencyMode ?? null,
      execStartedAt: input.execStartedAt ?? null,
      execCompletedAt: input.execCompletedAt ?? null,
      durationMs:
        input.execStartedAt && input.execCompletedAt
          ? input.execCompletedAt.getTime() - input.execStartedAt.getTime()
          : (input.latencyMs ?? 0),
      executedByAgentId: input.executedByAgentId ?? this.agentId,
      agentPath: input.agentPath ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      serviceTier: null,
      stopReason: input.stopReason ?? null,
      tokensInput,
      tokensOutput,
      cachedInputTokens,
      cacheCreationTokens,
      reasoningTokens,
      // Un gasto cubierto por suscripción NO suma al costo real (§6.3).
      costUsd: cost && !subscription ? cost.costTotalUsd : 0,
      input: input.input ?? null,
      output: input.output ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: now,
    };

    this.steps.push(step);

    // Un asiento inmutable POR LLAMADA al modelo, con la tarifa congelada.
    if (cost && input.model) {
      this.usage.push({
        usageId: newId("use"),
        executionId: this.executionId,
        stepId,
        tenantId: this.tenantId,
        organizationId: this.organizationId,
        agentId: this.agentId,
        executedByAgentId: input.executedByAgentId ?? null,
        model: input.model,
        provider: input.provider ?? "anthropic",
        tokensInput,
        tokensOutput,
        cacheReadTokens: cachedInputTokens,
        cacheCreationTokens,
        reasoningTokens,
        costInputUsd: subscription ? 0 : cost.costInputUsd,
        costOutputUsd: subscription ? 0 : cost.costOutputUsd,
        costCacheReadUsd: subscription ? 0 : cost.costCacheReadUsd,
        costCacheWriteUsd: subscription ? 0 : cost.costCacheWriteUsd,
        costTotalUsd: subscription ? 0 : cost.costTotalUsd,
        costNotionalUsd: subscription ? cost.costTotalUsd : 0,
        costOrigin: "computed",
        billingMode: subscription ? "subscription" : "api",
        pricingSnapshot: cost.pricingSnapshot,
        latencyMs: input.latencyMs ?? 0,
        occurredAt: now,
        createdAt: now,
      } as EngineUsageRecordDoc);
    }

    if (input.rawRequest !== undefined || input.rawResponse !== undefined) {
      this.payloads.push({
        stepId,
        request: input.rawRequest ?? null,
        response: input.rawResponse ?? null,
      });
    }

    return step;
  }

  /** Totales acumulados, para estampar en la fila de la ejecución. */
  totals(): {
    tokensInput: number;
    tokensOutput: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
    reasoningTokens: number;
    costUsd: number;
    costUsdNotional: number;
    stepCount: number;
  } {
    const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
    return {
      tokensInput: this.steps.reduce((a, s) => a + s.tokensInput, 0),
      tokensOutput: this.steps.reduce((a, s) => a + s.tokensOutput, 0),
      cachedInputTokens: this.steps.reduce((a, s) => a + s.cachedInputTokens, 0),
      cacheCreationTokens: this.steps.reduce((a, s) => a + s.cacheCreationTokens, 0),
      reasoningTokens: this.steps.reduce((a, s) => a + s.reasoningTokens, 0),
      costUsd: round6(this.usage.reduce((a, u) => a + u.costTotalUsd, 0)),
      costUsdNotional: round6(this.usage.reduce((a, u) => a + u.costNotionalUsd, 0)),
      stepCount: this.steps.length,
    };
  }

  /**
   * Trabajo REAL acumulado: la suma de las fases, excluyendo la cola. Es lo que
   * se factura como tiempo del agente y lo que hay que mirar para saber si una
   * corrida es lenta o simplemente esperó.
   */
  activeMs(): number {
    const { queueMs, ...rest } = this.timings;
    void queueMs;
    return Object.values(rest).reduce((a, b) => a + b, 0);
  }

  pendingSteps(): EngineExecutionStepDoc[] {
    return this.steps;
  }
  pendingUsage(): EngineUsageRecordDoc[] {
    return this.usage;
  }
  pendingPayloads(): PendingPayload[] {
    return this.payloads;
  }

  /** Índice del siguiente paso. Lo usa el corredor para reanudar la numeración. */
  seedIndex(from: number): void {
    this.index = from;
  }
}
