import { AnalyticsEvent } from "./analytics.model";
import { getEventDefinition, type EventSource } from "./analytics.registry";
import { getCompanyModel, getPropertyModel } from "../hotels/pmsModels";

interface DateRange {
  dateFrom?: Date;
  dateTo?: Date;
}

interface IngestInput {
  eventName: string;
  category?: string;
  source: string;
  companyId?: string | null;
  propertyId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  userRole?: string | null;
  payload?: Record<string, unknown>;
  clientTimestamp: Date | string;
  correlationId?: string | null;
}

/** Motivo por el que un evento no llegó a persistirse. */
export type DropReason =
  | "unknown_event"
  | "source_not_allowed"
  | "invalid_payload"
  | "unresolved_company"
  | "duplicate"
  | "insert_error";

/**
 * Contadores en memoria de eventos descartados, expuestos por la métrica de
 * salud. Se reinician con el proceso: son para detectar un emisor roto ahora,
 * no para auditar histórico.
 */
const dropped: Record<DropReason, number> = {
  unknown_event: 0,
  source_not_allowed: 0,
  invalid_payload: 0,
  unresolved_company: 0,
  duplicate: 0,
  insert_error: 0,
};
/** Nombres desconocidos vistos, para saber QUÉ emisor está mal. */
const unknownEventNames = new Map<string, number>();

function drop(reason: DropReason, detail?: string): void {
  dropped[reason] += 1;
  if (reason === "unknown_event" && detail) {
    unknownEventNames.set(detail, (unknownEventNames.get(detail) ?? 0) + 1);
  }
}

/**
 * Caché property → company. Los eventos públicos traen `propertyId` pero no
 * `companyId`, y resolverlo con una query por evento no escala. Cachea también
 * los misses para no re-consultar una property que no existe.
 * (Mismo patrón que `companyByProperty` de guestOriginService en staypass.)
 */
const companyByProperty = new Map<string, string | null>();

async function resolveCompanyId(
  propertyId: string,
): Promise<string | null> {
  if (companyByProperty.has(propertyId)) {
    return companyByProperty.get(propertyId) ?? null;
  }
  try {
    const Property = await getPropertyModel();
    const doc = await Property.findOne({ propertyId })
      .select({ companyId: 1 })
      .lean();
    const companyId = doc?.companyId ?? null;
    companyByProperty.set(propertyId, companyId);
    return companyId;
  } catch (err) {
    console.error("[analytics] no se pudo resolver companyId:", err);
    return null;
  }
}

export interface IngestResult {
  accepted: number;
  dropped: number;
}

/**
 * Compañías vivas de la plataforma (base del PMS), denominador honesto de
 * cualquier tasa de adopción. Si la conexión al PMS falla devuelve 0 y el
 * llamador cae a su piso — preferible a inventar un denominador.
 */
async function activeCompanyCount(): Promise<number> {
  try {
    const Company = await getCompanyModel();
    return await Company.countDocuments({ status: { $ne: "deleted" } });
  } catch (err) {
    console.error("[analytics] no se pudo contar companies del PMS:", err);
    return 0;
  }
}

/**
 * Pasos del embudo del motor, en orden. `engine_checkout_started` se sumó al
 * instrumentar: sin él, "categoría elegida → autenticación" tapaba el abandono
 * en la pantalla de datos del huésped, que es donde más se cae la gente.
 */
const FUNNEL_STEPS: { eventName: string; label: string }[] = [
  { eventName: "engine_search_initiated", label: "Busqueda iniciada" },
  { eventName: "engine_results_viewed", label: "Resultados vistos" },
  { eventName: "engine_category_selected", label: "Categoria elegida" },
  { eventName: "engine_checkout_started", label: "Checkout iniciado" },
  { eventName: "engine_auth_completed", label: "Autenticacion completa" },
  { eventName: "engine_reservation_created", label: "Reserva creada" },
];

function buildRangeFilter(range: DateRange): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (range.dateFrom || range.dateTo) {
    const ts: Record<string, Date> = {};
    if (range.dateFrom) ts.$gte = new Date(range.dateFrom);
    if (range.dateTo) ts.$lte = new Date(range.dateTo);
    f.serverTimestamp = ts;
  }
  return f;
}

export const analyticsService = {
  /**
   * Ingiere un lote. Nunca lanza: cada evento se acepta o se descarta con
   * contador, y el endpoint responde 202 igual (es telemetría; un problema acá
   * no puede convertirse en un error visible para un huésped o un hotelero).
   */
  async ingestBatch(inputs: IngestInput[]): Promise<IngestResult> {
    const docs: Record<string, unknown>[] = [];

    for (const input of inputs) {
      const def = getEventDefinition(input.eventName);
      if (!def) {
        drop("unknown_event", input.eventName);
        continue;
      }
      if (!def.sources.includes(input.source as EventSource)) {
        drop("source_not_allowed");
        console.warn(
          `[analytics] ${input.eventName} no puede emitirse desde ${input.source}`,
        );
        continue;
      }

      const { error, value: payload } = def.payload.validate(
        input.payload ?? {},
        // Tolera campos extra: un emisor que agrega contexto no debe perder el
        // evento entero. Lo que importa es que los campos del contrato estén.
        { allowUnknown: true, stripUnknown: false },
      );
      if (error) {
        drop("invalid_payload");
        console.warn(
          `[analytics] payload invalido en ${input.eventName}: ${error.message}`,
        );
        continue;
      }

      let companyId = input.companyId?.trim() || null;
      if (!companyId && input.propertyId) {
        companyId = await resolveCompanyId(input.propertyId);
      }
      if (!companyId) {
        drop("unresolved_company");
        continue;
      }

      docs.push({
        eventName: input.eventName,
        // La categoría la fija el registry, no el emisor: si dependiera del
        // cliente, el mismo evento podría llegar con categorías distintas.
        category: def.category,
        source: input.source,
        companyId,
        propertyId: input.propertyId || null,
        userId: input.userId || null,
        sessionId: input.sessionId || "server",
        userRole: input.userRole || null,
        payload,
        clientTimestamp: new Date(input.clientTimestamp),
        serverTimestamp: new Date(),
        correlationId: input.correlationId || null,
      });
    }

    if (docs.length === 0) {
      return { accepted: 0, dropped: inputs.length };
    }

    try {
      // `ordered:false` + índice unique sparse sobre correlationId: los
      // duplicados de un reintento fallan individualmente y el resto entra.
      const inserted = await AnalyticsEvent.insertMany(docs, {
        ordered: false,
        rawResult: true,
      });
      const accepted =
        (inserted as unknown as { insertedCount?: number }).insertedCount ??
        docs.length;
      const dupes = docs.length - accepted;
      if (dupes > 0) dropped.duplicate += dupes;
      return { accepted, dropped: inputs.length - accepted };
    } catch (err) {
      // insertMany con ordered:false lanza aunque haya insertado parte del
      // lote: los errores por duplicado son esperables, no un fallo real.
      const writeErrors =
        (err as { writeErrors?: unknown[] }).writeErrors?.length ?? 0;
      const duplicates =
        (err as { writeErrors?: { code?: number }[] }).writeErrors?.filter(
          (e) => e.code === 11000,
        ).length ?? 0;
      dropped.duplicate += duplicates;
      dropped.insert_error += writeErrors - duplicates;
      if (writeErrors - duplicates > 0) {
        console.error("[analytics] insert parcial fallo:", err);
      }
      return {
        accepted: docs.length - writeErrors,
        dropped: inputs.length - (docs.length - writeErrors),
      };
    }
  },

  /** Estado de la ingesta para la métrica de salud (§4.H del spec). */
  ingestHealth() {
    return {
      dropped: { ...dropped },
      unknownEventNames: [...unknownEventNames.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([eventName, count]) => ({ eventName, count })),
    };
  },

  async summary(range: DateRange & { companyId?: string }) {
    const filter: Record<string, unknown> = buildRangeFilter(range);
    if (range.companyId) filter.companyId = range.companyId;

    const [totalEvents, distinctCompanies, conversion, sitesPublished] =
      await Promise.all([
        AnalyticsEvent.countDocuments(filter),
        AnalyticsEvent.distinct("companyId", filter),
        this.conversionRate(range),
        AnalyticsEvent.distinct("companyId", {
          ...filter,
          eventName: "site_published",
        }),
      ]);

    return {
      totalCompanies: distinctCompanies.length,
      totalEvents,
      conversionRate: conversion,
      sitesPublished: sitesPublished.length,
    };
  },

  async conversionRate(range: DateRange) {
    const base = buildRangeFilter(range);
    const [searches, reservations] = await Promise.all([
      AnalyticsEvent.countDocuments({
        ...base,
        eventName: "engine_search_initiated",
        "payload.hasAvailability": true,
      }),
      AnalyticsEvent.countDocuments({
        ...base,
        eventName: "engine_reservation_created",
      }),
    ]);
    if (!searches) return 0;
    return Math.round((reservations / searches) * 10000) / 100; // 2 decimales
  },

  async adoption(range: DateRange) {
    const filter: Record<string, unknown> = {
      ...buildRangeFilter(range),
      eventName: "app_opened",
    };

    const [perApp, totalCompanies] = await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { appId: "$payload.appId", companyId: "$companyId" },
            opens: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: "$_id.appId",
            totalOpens: { $sum: "$opens" },
            uniqueCompanies: { $sum: 1 },
          },
        },
        { $sort: { totalOpens: -1 } },
      ]),
      // Denominador: compañías REALES de la plataforma, no las que tienen
      // eventos. Con el denominador viejo, una app usada por las 3 únicas
      // compañías que emitieron algo daba 100% de adopción.
      activeCompanyCount(),
    ]);

    const denom = Math.max(1, totalCompanies);
    return perApp
      .filter((r: { _id: unknown }) => r._id)
      .map((r: { _id: string; totalOpens: number; uniqueCompanies: number }) => ({
        appId: r._id,
        totalOpens: r.totalOpens,
        uniqueCompanies: r.uniqueCompanies,
        adoptionRate: Math.round((r.uniqueCompanies / denom) * 10000) / 100,
      }));
  },

  /**
   * Embudo del motor **por sesión distinta**, no por cantidad de eventos.
   *
   * La versión anterior hacía un `countDocuments` por paso sin correlacionar
   * `sessionId`, así que no medía dropoff: un huésped que repite la búsqueda
   * cinco veces inflaba el paso 1 y hundía la conversión, y el "porcentaje"
   * comparaba poblaciones distintas. Ahora cada paso cuenta sesiones que lo
   * alcanzaron, que es lo que hace comparable un paso con el anterior.
   *
   * Se excluye el centinela "server": los eventos server-side sin sesión no
   * pertenecen a ningún recorrido y romperían el conteo.
   */
  async funnel(range: DateRange & { propertySlug?: string }) {
    const match: Record<string, unknown> = {
      ...buildRangeFilter(range),
      eventName: { $in: FUNNEL_STEPS.map((s) => s.eventName) },
      sessionId: { $ne: "server" },
    };
    if (range.propertySlug) match["payload.propertySlug"] = range.propertySlug;

    const rows = await AnalyticsEvent.aggregate<{
      _id: string;
      sessions: number;
    }>([
      { $match: match },
      // Una sesión cuenta una sola vez por paso, aunque lo repita.
      { $group: { _id: { eventName: "$eventName", sessionId: "$sessionId" } } },
      { $group: { _id: "$_id.eventName", sessions: { $sum: 1 } } },
    ]);

    const byEvent = new Map(rows.map((r) => [r._id, r.sessions]));
    const first = byEvent.get(FUNNEL_STEPS[0].eventName) || 0;

    return FUNNEL_STEPS.map((step, i) => {
      const count = byEvent.get(step.eventName) ?? 0;
      const prev =
        i === 0 ? count : byEvent.get(FUNNEL_STEPS[i - 1].eventName) ?? 0;
      return {
        eventName: step.eventName,
        label: step.label,
        count,
        /** Sobre el paso 1: cuánto del tráfico inicial sigue vivo acá. */
        percentage:
          i === 0 || !first ? 100 : Math.round((count / first) * 10000) / 100,
        /** Sobre el paso anterior: dónde se cae realmente la gente. */
        stepConversion:
          i === 0 || !prev ? 100 : Math.round((count / prev) * 10000) / 100,
      };
    });
  },

  async engagement(range: DateRange) {
    const filter = {
      ...buildRangeFilter(range),
      eventName: "app_session_ended",
    };

    const rows = await AnalyticsEvent.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$payload.appId",
          sessions: { $sum: 1 },
          durations: { $push: "$payload.durationSeconds" },
        },
      },
      { $sort: { sessions: -1 } },
    ]);

    return rows
      .filter((r: { _id: unknown }) => r._id)
      .map((r: { _id: string; sessions: number; durations: number[] }) => {
        const valid = (r.durations || []).filter(
          (d) => typeof d === "number" && !isNaN(d),
        );
        const avg = valid.length
          ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
          : 0;
        const sorted = [...valid].sort((a, b) => a - b);
        const median = sorted.length
          ? sorted[Math.floor(sorted.length / 2)]
          : 0;
        return {
          appId: r._id,
          sessions: r.sessions,
          avgDurationSeconds: avg,
          medianDurationSeconds: median,
        };
      });
  },

  async builder(range: DateRange) {
    const filter = buildRangeFilter(range);
    const [published, active, components] = await Promise.all([
      AnalyticsEvent.distinct("companyId", {
        ...filter,
        eventName: "site_published",
      }),
      AnalyticsEvent.distinct("companyId", {
        ...filter,
        eventName: { $in: ["builder_page_edited", "builder_component_added"] },
      }),
      AnalyticsEvent.aggregate([
        {
          $match: {
            ...filter,
            eventName: "builder_component_added",
          },
        },
        {
          $group: {
            _id: "$payload.componentType",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    return {
      companiesPublished: published.length,
      companiesActive: active.length,
      topComponents: components
        .filter((c: { _id: unknown }) => c._id)
        .map((c: { _id: string; count: number }) => ({
          componentType: c._id,
          count: c.count,
        })),
    };
  },

  async listEvents(
    input: DateRange & {
      companyId?: string;
      eventName?: string;
      page: number;
      limit: number;
      skip: number;
    },
  ) {
    const filter: Record<string, unknown> = buildRangeFilter(input);
    if (input.companyId) filter.companyId = input.companyId;
    if (input.eventName) filter.eventName = input.eventName;

    const [data, total] = await Promise.all([
      AnalyticsEvent.find(filter)
        .sort({ serverTimestamp: -1 })
        .skip(input.skip)
        .limit(input.limit)
        .lean(),
      AnalyticsEvent.countDocuments(filter),
    ]);
    return { data, total, page: input.page, limit: input.limit };
  },
};
