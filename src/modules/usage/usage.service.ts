import { makeId } from "../../shared/utils/ids";
import { computeCostUsd } from "./usage.pricing";
import {
  DIM_NONE,
  UsageDailyRollup,
  UsageRecord,
  type UsageSource,
} from "./usage.model";

export interface RecordUsageInput {
  source: UsageSource;
  agentId?: string | null;
  agentSlug?: string | null;
  model: string;
  companyId: string;
  propertyId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  turnIndex?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  latencyMs?: number;
  toolCallCount?: number;
  occurredAt?: Date | string | null;
}

interface DateRange {
  dateFrom?: Date;
  dateTo?: Date;
}

interface DimFilter {
  companyId?: string;
  propertyId?: string;
  userId?: string;
  source?: UsageSource | string;
  agentId?: string;
  model?: string;
}

// "YYYY-MM-DD" en UTC para la clave del rollup.
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// El rango se aplica sobre el campo string `day`. Como los dias son ISO
// (YYYY-MM-DD), la comparacion lexicografica coincide con la cronologica.
function rollupRangeFilter(range: DateRange): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (range.dateFrom || range.dateTo) {
    const day: Record<string, string> = {};
    if (range.dateFrom) day.$gte = dayKey(new Date(range.dateFrom));
    if (range.dateTo) day.$lte = dayKey(new Date(range.dateTo));
    f.day = day;
  }
  return f;
}

function rollupDimFilter(dims: DimFilter): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (dims.companyId) f.companyId = dims.companyId;
  if (dims.propertyId) f.propertyId = dims.propertyId;
  if (dims.userId) f.userId = dims.userId;
  if (dims.source) f.source = dims.source;
  if (dims.agentId) f.agentId = dims.agentId;
  if (dims.model) f.model = dims.model;
  return f;
}

// Acumuladores estandar para cualquier $group sobre el rollup.
const SUM_METRICS = {
  turns: { $sum: "$turns" },
  inputTokens: { $sum: "$inputTokens" },
  outputTokens: { $sum: "$outputTokens" },
  cacheCreationTokens: { $sum: "$cacheCreationTokens" },
  cacheReadTokens: { $sum: "$cacheReadTokens" },
  totalTokens: { $sum: "$totalTokens" },
  costUsd: { $sum: "$costUsd" },
  latencyMsSum: { $sum: "$latencyMsSum" },
  toolCallCount: { $sum: "$toolCallCount" },
} as const;

// Normaliza el shape de salida de un $group y deriva metricas presentables.
function shapeBucket(row: any) {
  const turns = row.turns ?? 0;
  return {
    turns,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    totalTokens: row.totalTokens ?? 0,
    costUsd: Math.round((row.costUsd ?? 0) * 1_000_000) / 1_000_000,
    avgLatencyMs: turns ? Math.round((row.latencyMsSum ?? 0) / turns) : 0,
    toolCallCount: row.toolCallCount ?? 0,
  };
}

export const usageService = {
  /**
   * Registra un turno: inserta el record crudo y upsertea el rollup diario.
   * Es idempotente a nivel de insercion solo por usageId (que generamos), no
   * deduplica reintentos del cliente — el llamador debe reportar una vez por
   * turno. Devuelve el record creado (con costo ya calculado).
   */
  async record(input: RecordUsageInput) {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const cacheCreationTokens = input.cacheCreationTokens ?? 0;
    const cacheReadTokens = input.cacheReadTokens ?? 0;
    const totalTokens =
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const costUsd = computeCostUsd(input.model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
    const occurredAt = input.occurredAt
      ? new Date(input.occurredAt)
      : new Date();

    const doc = await UsageRecord.create({
      usageId: makeId("usage"),
      source: input.source,
      agentId: input.agentId ?? null,
      agentSlug: input.agentSlug ?? null,
      model: input.model,
      companyId: input.companyId,
      propertyId: input.propertyId ?? null,
      userId: input.userId ?? null,
      userRole: input.userRole ?? null,
      conversationId: input.conversationId ?? null,
      sessionId: input.sessionId ?? null,
      turnIndex: input.turnIndex ?? null,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens,
      costUsd,
      latencyMs: input.latencyMs ?? 0,
      toolCallCount: input.toolCallCount ?? 0,
      occurredAt,
    });

    await UsageDailyRollup.updateOne(
      {
        day: dayKey(occurredAt),
        companyId: input.companyId,
        propertyId: input.propertyId ?? DIM_NONE,
        userId: input.userId ?? DIM_NONE,
        agentId: input.agentId ?? DIM_NONE,
        source: input.source,
        model: input.model,
      },
      {
        $inc: {
          turns: 1,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          totalTokens,
          costUsd,
          latencyMsSum: input.latencyMs ?? 0,
          toolCallCount: input.toolCallCount ?? 0,
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    );

    return doc;
  },

  /**
   * Suma de tokens consumidos por una company en un rango de fechas. Lee del
   * rollup diario (rapido). Lo usa el enforcement de creditos del contrato.
   */
  async consumedTokens(
    companyId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<number> {
    const [agg] = await UsageDailyRollup.aggregate([
      {
        $match: {
          companyId,
          day: { $gte: dayKey(dateFrom), $lte: dayKey(dateTo) },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalTokens" } } },
    ]);
    return agg?.total ?? 0;
  },

  /** Totales globales (o de una company) en el rango. */
  async summary(range: DateRange, dims: DimFilter = {}) {
    const match = { ...rollupRangeFilter(range), ...rollupDimFilter(dims) };
    const [agg] = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: null, ...SUM_METRICS } },
    ]);
    const [companies, properties, users] = await Promise.all([
      UsageDailyRollup.distinct("companyId", match),
      UsageDailyRollup.distinct("propertyId", { ...match, propertyId: { $ne: DIM_NONE } }),
      UsageDailyRollup.distinct("userId", { ...match, userId: { $ne: DIM_NONE } }),
    ]);
    return {
      ...shapeBucket(agg ?? {}),
      distinctCompanies: companies.length,
      distinctProperties: properties.length,
      distinctUsers: users.length,
    };
  },

  /** Nivel 1 de la jerarquia: consumo agregado por company. */
  async byCompany(range: DateRange, dims: DimFilter = {}) {
    const match = { ...rollupRangeFilter(range), ...rollupDimFilter(dims) };
    const rows = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: "$companyId", ...SUM_METRICS } },
      { $sort: { costUsd: -1 } },
    ]);
    return rows.map((r: any) => ({
      companyId: r._id,
      ...shapeBucket(r),
    }));
  },

  /** Nivel 2: dentro de una company, desglose por property. */
  async byProperty(companyId: string, range: DateRange, dims: DimFilter = {}) {
    const match = {
      ...rollupRangeFilter(range),
      ...rollupDimFilter({ ...dims, companyId }),
    };
    const rows = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: "$propertyId", ...SUM_METRICS } },
      { $sort: { costUsd: -1 } },
    ]);
    return rows.map((r: any) => ({
      // El editor reporta sin property: cae en el bucket DIM_NONE, que
      // exponemos como null para que el front lo muestre como "(sin propiedad)".
      propertyId: r._id === DIM_NONE ? null : r._id,
      ...shapeBucket(r),
    }));
  },

  /** Nivel 3: dentro de company+property, desglose por usuario. */
  async byUser(
    companyId: string,
    propertyId: string,
    range: DateRange,
    dims: DimFilter = {},
  ) {
    const match = {
      ...rollupRangeFilter(range),
      ...rollupDimFilter({ ...dims, companyId }),
      propertyId: propertyId === "none" || propertyId === DIM_NONE ? DIM_NONE : propertyId,
    };
    const rows = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: "$userId", ...SUM_METRICS } },
      { $sort: { costUsd: -1 } },
    ]);
    return rows.map((r: any) => ({
      userId: r._id === DIM_NONE ? null : r._id,
      ...shapeBucket(r),
    }));
  },

  /**
   * Detalle de un usuario concreto: desglose por agente+modelo+source y serie
   * temporal por dia. Es la hoja de la jerarquia company > property > usuario.
   */
  async userDetail(
    companyId: string,
    propertyId: string,
    userId: string,
    range: DateRange,
  ) {
    const match = {
      ...rollupRangeFilter(range),
      companyId,
      propertyId: propertyId === "none" || propertyId === DIM_NONE ? DIM_NONE : propertyId,
      userId,
    };
    const [byAgentModel, daily, totals] = await Promise.all([
      UsageDailyRollup.aggregate([
        { $match: match },
        {
          $group: {
            _id: { agentId: "$agentId", source: "$source", model: "$model" },
            ...SUM_METRICS,
          },
        },
        { $sort: { costUsd: -1 } },
      ]),
      UsageDailyRollup.aggregate([
        { $match: match },
        { $group: { _id: "$day", ...SUM_METRICS } },
        { $sort: { _id: 1 } },
      ]),
      UsageDailyRollup.aggregate([
        { $match: match },
        { $group: { _id: null, ...SUM_METRICS } },
      ]),
    ]);
    return {
      totals: shapeBucket(totals[0] ?? {}),
      breakdown: byAgentModel.map((r: any) => ({
        agentId: r._id.agentId === DIM_NONE ? null : r._id.agentId,
        source: r._id.source,
        model: r._id.model,
        ...shapeBucket(r),
      })),
      timeseries: daily.map((r: any) => ({ day: r._id, ...shapeBucket(r) })),
    };
  },

  /** Desglose por modelo (para ver que modelo concentra el costo). */
  async byModel(range: DateRange, dims: DimFilter = {}) {
    const match = { ...rollupRangeFilter(range), ...rollupDimFilter(dims) };
    const rows = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: "$model", ...SUM_METRICS } },
      { $sort: { costUsd: -1 } },
    ]);
    return rows.map((r: any) => ({ model: r._id, ...shapeBucket(r) }));
  },

  /** Serie temporal diaria global o filtrada. */
  async timeseries(range: DateRange, dims: DimFilter = {}) {
    const match = { ...rollupRangeFilter(range), ...rollupDimFilter(dims) };
    const rows = await UsageDailyRollup.aggregate([
      { $match: match },
      { $group: { _id: "$day", ...SUM_METRICS } },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((r: any) => ({ day: r._id, ...shapeBucket(r) }));
  },

  /** Drill-down crudo: lista de records individuales (auditoria). */
  async listRecords(
    input: DateRange &
      DimFilter & { page: number; limit: number; skip: number },
  ) {
    const filter: Record<string, unknown> = {};
    if (input.dateFrom || input.dateTo) {
      const ts: Record<string, Date> = {};
      if (input.dateFrom) ts.$gte = new Date(input.dateFrom);
      if (input.dateTo) ts.$lte = new Date(input.dateTo);
      filter.occurredAt = ts;
    }
    if (input.companyId) filter.companyId = input.companyId;
    if (input.propertyId) filter.propertyId = input.propertyId;
    if (input.userId) filter.userId = input.userId;
    if (input.source) filter.source = input.source;
    if (input.agentId) filter.agentId = input.agentId;
    if (input.model) filter.model = input.model;

    const [data, total] = await Promise.all([
      UsageRecord.find(filter)
        .sort({ occurredAt: -1 })
        .skip(input.skip)
        .limit(input.limit)
        .lean(),
      UsageRecord.countDocuments(filter),
    ]);
    return { data, total, page: input.page, limit: input.limit };
  },
};
