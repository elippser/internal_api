/**
 * Analítica del motor (§23 latencia, §24 uso y costo, §25 base de alertas).
 *
 * Todo sale de agregaciones sobre `engine_executions` y `engine_usage_records`.
 * Dos decisiones que cambian lo que dicen los números:
 *
 *  1. Las tasas de error y de éxito se calculan sobre ejecuciones FINALES, no
 *     sobre todas. Incluir las que están en cola o esperando aprobación
 *     humana hunde artificialmente la tasa de éxito y dispara alertas por
 *     tráfico normal.
 *  2. Una CANCELACIÓN no cuenta como falla. Es una acción deliberada de un
 *     operador; contarla como error hace que apretar "cancelar" empeore las
 *     métricas del equipo, y a nadie le sirve un tablero que castiga el uso
 *     correcto del producto.
 */
import type { Request, Response } from "express";
import { EngineExecution } from "../../engine/models/execution.model";
import { EngineUsageRecord } from "../../engine/models/usageRecord.model";
import { TERMINAL_STATUSES } from "../../engine/models/enums";
import { scopeClause } from "../../engine/repositories/base.repository";
import { ok } from "../../shared/utils/http";

/** Fallas de verdad: fallidas + expiradas. La cancelación queda afuera. */
const FAILURE_STATUSES = ["failed", "timed_out"];

function range(req: Request): { from: Date; to: Date } {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from
    ? new Date(String(req.query.from))
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

function baseMatch(req: Request): Record<string, unknown> {
  const { from, to } = range(req);
  const match: Record<string, unknown> = { createdAt: { $gte: from, $lte: to } };
  if (req.query.agentId) match.agentId = req.query.agentId;

  const clause = scopeClause();
  return Object.keys(clause).length ? { $and: [match, clause] } : match;
}

export const engineAnalyticsController = {
  /** Tarjetas de cabecera. */
  async summary(req: Request, res: Response) {
    const match = baseMatch(req);

    const [totals] = await EngineExecution.aggregate<{
      executions: number;
      terminal: number;
      succeeded: number;
      failures: number;
      cancelled: number;
      waiting: number;
      costUsd: number;
      tokensInput: number;
      tokensOutput: number;
      cachedInputTokens: number;
      activeMsSum: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          executions: { $sum: 1 },
          terminal: {
            $sum: { $cond: [{ $in: ["$status", TERMINAL_STATUSES] }, 1, 0] },
          },
          succeeded: { $sum: { $cond: [{ $eq: ["$status", "succeeded"] }, 1, 0] } },
          failures: { $sum: { $cond: [{ $in: ["$status", FAILURE_STATUSES] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          waiting: {
            $sum: {
              $cond: [
                { $in: ["$status", ["waiting_for_input", "waiting_for_subtask", "paused"]] },
                1,
                0,
              ],
            },
          },
          costUsd: { $sum: "$costUsd" },
          tokensInput: { $sum: "$tokensInput" },
          tokensOutput: { $sum: "$tokensOutput" },
          cachedInputTokens: { $sum: "$cachedInputTokens" },
          activeMsSum: { $sum: "$activeMs" },
        },
      },
    ]);

    const t = totals ?? {
      executions: 0,
      terminal: 0,
      succeeded: 0,
      failures: 0,
      cancelled: 0,
      waiting: 0,
      costUsd: 0,
      tokensInput: 0,
      tokensOutput: 0,
      cachedInputTokens: 0,
      activeMsSum: 0,
    };

    // Percentiles sobre las que TIENEN duración. Se traen ordenados y se corta
    // en JS: `$percentile` exige Mongo 7 y acá no se puede asumir la versión.
    const durations = await EngineExecution.find(
      { ...(match as object), activeMs: { $gt: 0 } },
      { activeMs: 1 },
    )
      .sort({ activeMs: 1 })
      .limit(20_000)
      .lean();

    const values = durations.map((d) => d.activeMs);
    const pct = (p: number): number =>
      values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * p))];

    const cacheTotal = t.tokensInput + t.cachedInputTokens;

    return ok(res, {
      range: range(req),
      executions: t.executions,
      terminal: t.terminal,
      succeeded: t.succeeded,
      failures: t.failures,
      cancelled: t.cancelled,
      waiting: t.waiting,
      // Denominador = FINALES. Sobre el total, una cola larga parece una caída.
      successRate: t.terminal ? t.succeeded / t.terminal : null,
      failureRate: t.terminal ? t.failures / t.terminal : null,
      costUsd: Math.round(t.costUsd * 1e6) / 1e6,
      tokensInput: t.tokensInput,
      tokensOutput: t.tokensOutput,
      cachedInputTokens: t.cachedInputTokens,
      /** Proporción del input servida desde caché: la palanca de costo #1. */
      cacheHitRatio: cacheTotal ? t.cachedInputTokens / cacheTotal : 0,
      latency: {
        meanMs: values.length ? Math.round(t.activeMsSum / Math.max(1, t.executions)) : 0,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        p99Ms: pct(0.99),
      },
    });
  },

  /** Serie temporal por día. Alimenta el gráfico de la consola. */
  async timeseries(req: Request, res: Response) {
    const rows = await EngineExecution.aggregate<{
      _id: string;
      executions: number;
      succeeded: number;
      failures: number;
      costUsd: number;
      tokens: number;
    }>([
      { $match: baseMatch(req) },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          executions: { $sum: 1 },
          succeeded: { $sum: { $cond: [{ $eq: ["$status", "succeeded"] }, 1, 0] } },
          failures: { $sum: { $cond: [{ $in: ["$status", FAILURE_STATUSES] }, 1, 0] } },
          costUsd: { $sum: "$costUsd" },
          tokens: { $sum: { $add: ["$tokensInput", "$tokensOutput"] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return ok(
      res,
      rows.map((r) => ({
        day: r._id,
        executions: r.executions,
        succeeded: r.succeeded,
        failures: r.failures,
        costUsd: Math.round(r.costUsd * 1e6) / 1e6,
        tokens: r.tokens,
      })),
    );
  },

  /** Desglose por agente: quién consume y quién falla. */
  async byAgent(req: Request, res: Response) {
    const rows = await EngineExecution.aggregate<{
      _id: string;
      executions: number;
      terminal: number;
      succeeded: number;
      failures: number;
      costUsd: number;
      tokens: number;
      activeMsSum: number;
    }>([
      { $match: baseMatch(req) },
      {
        $group: {
          _id: "$agentId",
          executions: { $sum: 1 },
          terminal: { $sum: { $cond: [{ $in: ["$status", TERMINAL_STATUSES] }, 1, 0] } },
          succeeded: { $sum: { $cond: [{ $eq: ["$status", "succeeded"] }, 1, 0] } },
          failures: { $sum: { $cond: [{ $in: ["$status", FAILURE_STATUSES] }, 1, 0] } },
          costUsd: { $sum: "$costUsd" },
          tokens: { $sum: { $add: ["$tokensInput", "$tokensOutput"] } },
          activeMsSum: { $sum: "$activeMs" },
        },
      },
      { $sort: { costUsd: -1 } },
      { $limit: 50 },
    ]);

    const { EngineAgent } = await import("../../engine/models/agent.model");
    const agents = await EngineAgent.find(
      { agentId: { $in: rows.map((r) => r._id) } },
      { agentId: 1, name: 1, slug: 1 },
    ).lean();
    const names = new Map(agents.map((a) => [a.agentId, a.name]));

    return ok(
      res,
      rows.map((r) => ({
        agentId: r._id,
        name: names.get(r._id) ?? r._id,
        executions: r.executions,
        succeeded: r.succeeded,
        failures: r.failures,
        successRate: r.terminal ? r.succeeded / r.terminal : null,
        costUsd: Math.round(r.costUsd * 1e6) / 1e6,
        tokens: r.tokens,
        avgActiveMs: r.executions ? Math.round(r.activeMsSum / r.executions) : 0,
      })),
    );
  },

  /**
   * Desglose por modelo, desde los ASIENTOS (una fila por llamada). Agregar
   * sobre las ejecuciones perdería el detalle de un turno que usó tres modelos
   * distintos entre el padre, un sub-agente y el auto-titulado.
   */
  async byModel(req: Request, res: Response) {
    const { from, to } = range(req);
    const clause = scopeClause();
    const match: Record<string, unknown> = { occurredAt: { $gte: from, $lte: to } };

    const rows = await EngineUsageRecord.aggregate<{
      _id: string;
      calls: number;
      tokensInput: number;
      tokensOutput: number;
      cacheReadTokens: number;
      costUsd: number;
      notionalUsd: number;
      latencySum: number;
    }>([
      { $match: Object.keys(clause).length ? { $and: [match, clause] } : match },
      {
        $group: {
          _id: "$model",
          calls: { $sum: 1 },
          tokensInput: { $sum: "$tokensInput" },
          tokensOutput: { $sum: "$tokensOutput" },
          cacheReadTokens: { $sum: "$cacheReadTokens" },
          costUsd: { $sum: "$costTotalUsd" },
          notionalUsd: { $sum: "$costNotionalUsd" },
          latencySum: { $sum: "$latencyMs" },
        },
      },
      { $sort: { costUsd: -1 } },
    ]);

    return ok(
      res,
      rows.map((r) => ({
        model: r._id,
        calls: r.calls,
        tokensInput: r.tokensInput,
        tokensOutput: r.tokensOutput,
        cacheReadTokens: r.cacheReadTokens,
        costUsd: Math.round(r.costUsd * 1e6) / 1e6,
        // Cubierto por suscripción: se muestra aparte y NUNCA se suma al costo.
        notionalUsd: Math.round(r.notionalUsd * 1e6) / 1e6,
        avgLatencyMs: r.calls ? Math.round(r.latencySum / r.calls) : 0,
      })),
    );
  },

  /**
   * Fallas agrupadas por motivo LEGIBLE POR MÁQUINA. El texto libre del error
   * es para el humano; esto es lo que permite ver que el 60% de las caídas de
   * la semana son desbordes de contexto y no "errores varios".
   */
  async failures(req: Request, res: Response) {
    const match = baseMatch(req);
    const rows = await EngineExecution.aggregate<{
      _id: string | null;
      count: number;
      sample: string;
    }>([
      { $match: { $and: [match, { status: { $in: FAILURE_STATUSES } }] } },
      {
        $group: {
          _id: "$failureReason",
          count: { $sum: 1 },
          sample: { $first: "$errorMessage" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    return ok(
      res,
      rows.map((r) => ({ reason: r._id ?? "unknown", count: r.count, sample: r.sample })),
    );
  },

  /**
   * Descomposición de latencia por fases NO SOLAPADAS. Es lo que responde
   * "¿es lento el modelo o son las herramientas?" sin adivinar.
   */
  async latency(req: Request, res: Response) {
    const [row] = await EngineExecution.aggregate<{
      queueMs: number;
      setupMs: number;
      llmMs: number;
      toolMs: number;
      overheadMs: number;
      finalizeMs: number;
      n: number;
    }>([
      { $match: baseMatch(req) },
      {
        $group: {
          _id: null,
          queueMs: { $sum: "$phaseTimings.queueMs" },
          setupMs: { $sum: "$phaseTimings.setupMs" },
          llmMs: { $sum: "$phaseTimings.llmMs" },
          toolMs: { $sum: "$phaseTimings.toolMs" },
          overheadMs: { $sum: "$phaseTimings.overheadMs" },
          finalizeMs: { $sum: "$phaseTimings.finalizeMs" },
          n: { $sum: 1 },
        },
      },
    ]);

    const t = row ?? {
      queueMs: 0,
      setupMs: 0,
      llmMs: 0,
      toolMs: 0,
      overheadMs: 0,
      finalizeMs: 0,
      n: 0,
    };
    const n = Math.max(1, t.n);

    return ok(res, {
      executions: t.n,
      totals: {
        queueMs: t.queueMs,
        setupMs: t.setupMs,
        llmMs: t.llmMs,
        toolMs: t.toolMs,
        overheadMs: t.overheadMs,
        finalizeMs: t.finalizeMs,
      },
      averages: {
        queueMs: Math.round(t.queueMs / n),
        setupMs: Math.round(t.setupMs / n),
        llmMs: Math.round(t.llmMs / n),
        toolMs: Math.round(t.toolMs / n),
        overheadMs: Math.round(t.overheadMs / n),
        finalizeMs: Math.round(t.finalizeMs / n),
      },
    });
  },

  /**
   * Herramientas más usadas y su tasa de error. Responde "¿qué herramienta se
   * está rompiendo?", que es la causa más común de un agente que "anda mal"
   * sin que el modelo tenga nada que ver.
   */
  async tools(req: Request, res: Response) {
    const { from, to } = range(req);
    const { EngineExecutionStep } = await import("../../engine/models/executionStep.model");
    const clause = scopeClause();
    const match: Record<string, unknown> = {
      createdAt: { $gte: from, $lte: to },
      kind: { $in: ["tool_call", "sub_agent_call"] },
    };

    const rows = await EngineExecutionStep.aggregate<{
      _id: string;
      calls: number;
      errors: number;
      blocked: number;
      durationSum: number;
    }>([
      { $match: Object.keys(clause).length ? { $and: [match, clause] } : match },
      {
        $group: {
          _id: "$name",
          calls: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ["$outcome", "error"] }, 1, 0] } },
          blocked: { $sum: { $cond: [{ $eq: ["$outcome", "blocked"] }, 1, 0] } },
          durationSum: { $sum: "$durationMs" },
        },
      },
      { $sort: { calls: -1 } },
      { $limit: 50 },
    ]);

    return ok(
      res,
      rows.map((r) => ({
        name: r._id,
        calls: r.calls,
        errors: r.errors,
        blocked: r.blocked,
        errorRate: r.calls ? r.errors / r.calls : 0,
        avgDurationMs: r.calls ? Math.round(r.durationSum / r.calls) : 0,
      })),
    );
  },
};
