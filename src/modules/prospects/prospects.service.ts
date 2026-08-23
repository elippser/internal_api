import { makeId } from "../../shared/utils/ids";
import { MktAccount } from "../crm/crm.model";
import { InternalUser } from "../users/users.model";
import { normalizeProspect, type RawProspectInput } from "./normalize";
import {
  ATTEMPT_TYPES,
  CONNECTED_OUTCOMES,
  PIPELINE_STATUSES,
  Prospect,
  ProspectActivity,
  isReached,
  outcomeOf,
  recomputeDerived,
  sanitizeDoc,
  type ActivityOutcome,
  type ActivityType,
  type LodgingType,
  type LostReason,
  type ProspectPriority,
  type ProspectSource,
  type ProspectStatus,
} from "./prospects.model";

interface HttpError extends Error {
  status: number;
  code?: string;
}
function httpError(status: number, message: string, code?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

function rx(search: string): RegExp {
  return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

export type ProspectSort = "score" | "recent" | "name" | "attempts" | "next";

export interface ListProspectsInput {
  status?: ProspectStatus;
  outcome?: "open" | "won" | "lost";
  priority?: ProspectPriority;
  lodgingType?: LodgingType;
  source?: ProspectSource;
  country?: string;
  region?: string;
  tag?: string;
  ownerUserId?: string;
  /** "unassigned" para los que no tienen duenio: filtrar por vacio no se puede. */
  unassigned?: boolean;
  contactability?: "phone" | "digital" | "none";
  /** Solo los que tienen un seguimiento vencido a hoy. */
  due?: boolean;
  /** Nunca intentados: la parte de la lista que todavia no se toco. */
  untouched?: boolean;
  includeDoNotCall?: boolean;
  search?: string;
  sort?: ProspectSort;
  page: number;
  limit: number;
  skip: number;
}

const SORTS: Record<ProspectSort, Record<string, 1 | -1>> = {
  score: { score: -1, lastPostAt: -1 },
  recent: { updatedAt: -1 },
  name: { name: 1 },
  attempts: { attempts: -1, lastAttemptAt: -1 },
  next: { nextActionAt: 1, score: -1 },
};

function buildQuery(input: ListProspectsInput): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (input.status) q.status = input.status;
  if (input.outcome) q.outcome = input.outcome;
  if (input.priority) q.priority = input.priority;
  if (input.lodgingType) q.lodgingType = input.lodgingType;
  if (input.source) q.source = input.source;
  if (input.country) q.country = input.country.toUpperCase();
  if (input.region) q.region = rx(input.region);
  if (input.tag) q.tags = input.tag;
  if (input.contactability) q.contactability = input.contactability;
  if (input.unassigned) q.ownerUserId = { $in: [null, ""] };
  else if (input.ownerUserId) q.ownerUserId = input.ownerUserId;
  if (input.due) q.nextActionAt = { $lte: new Date() };
  if (input.untouched) q.attempts = 0;
  // El "no llamar" se esconde salvo que lo pidan: es una lista de llamadas y
  // ver ahi a alguien que pidio que no lo llamen es peor que no verlo.
  if (!input.includeDoNotCall) q.doNotCall = { $ne: true };
  if (input.search) {
    const r = rx(input.search);
    q.$or = [
      { name: r },
      { handle: r },
      { location: r },
      { "contact.phoneRaw": r },
      { "contact.phone": r },
      { "contact.email": r },
      { "contact.websiteDomain": r },
    ];
  }
  return q;
}

// ---------------------------------------------------------------------------
// Alta y edicion
// ---------------------------------------------------------------------------

export interface CreateProspectInput extends RawProspectInput {
  source?: ProspectSource;
  sourceBatch?: string;
  priority?: ProspectPriority;
  ownerUserId?: string;
  tags?: string[];
  notes?: string;
  postUrl?: string;
  postedAt?: string | Date;
}

export interface UpdateProspectInput {
  name?: string;
  handle?: string | null;
  lodgingType?: LodgingType;
  location?: string | null;
  country?: string | null;
  region?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  status?: ProspectStatus;
  lostReason?: LostReason | null;
  lostNote?: string;
  priority?: ProspectPriority;
  ownerUserId?: string | null;
  nextActionAt?: string | Date | null;
  nextActionNote?: string;
  doNotCall?: boolean;
  tags?: string[];
  notes?: string;
}

/**
 * Aplica un cambio de etapa cuidando los efectos que van con el: la marca de
 * tiempo, el motivo de perdida y el primer contacto. Vive suelto porque lo
 * usan el PATCH, el registro de actividad y las acciones masivas, y las tres
 * tienen que dejar la ficha en el mismo estado.
 */
function applyStatus(doc: Record<string, unknown>, next: ProspectStatus, when: Date) {
  const prev = doc.status as ProspectStatus | undefined;
  if (prev === next) return;
  doc.status = next;
  doc.outcome = outcomeOf(next);
  doc.statusChangedAt = when;
  if (isReached(next) && !doc.firstReachedAt) doc.firstReachedAt = when;
  // Salir de un terminal negativo borra el motivo: dejarlo colgado hace que el
  // tablero cuente como "perdido por precio" a alguien que hoy esta en demo.
  if (outcomeOf(next) !== "lost") {
    doc.lostReason = undefined;
    doc.lostNote = "";
  }
  // Ganado o descartado: no hay proxima llamada que agendar.
  if (outcomeOf(next) !== "open") {
    doc.nextActionAt = undefined;
    doc.nextActionNote = "";
  }
}

// ---------------------------------------------------------------------------

export const prospectsService = {
  async list(input: ListProspectsInput) {
    const q = buildQuery(input);
    const sort = SORTS[input.sort ?? "score"];
    const [rows, total] = await Promise.all([
      Prospect.find(q).sort(sort).skip(input.skip).limit(input.limit).lean(),
      Prospect.countDocuments(q),
    ]);
    return { data: rows.map(sanitizeDoc), total, page: input.page, limit: input.limit };
  },

  async get(prospectId: string) {
    const prospect = await Prospect.findOne({ prospectId }).lean();
    if (!prospect) throw httpError(404, "Prospecto no encontrado", "not_found");
    const activities = await ProspectActivity.find({ prospectId })
      .sort({ occurredAt: -1 })
      .limit(200)
      .lean();
    const owner = prospect.ownerUserId
      ? await InternalUser.findOne({ userId: prospect.ownerUserId })
          .select("userId firstName lastName email")
          .lean()
      : null;
    return {
      ...sanitizeDoc(prospect),
      activities: activities.map(sanitizeDoc),
      owner: owner ? sanitizeDoc(owner) : null,
    };
  },

  async create(input: CreateProspectInput) {
    const norm = normalizeProspect(input);
    if (norm.handle) {
      const dupe = await Prospect.findOne({ handle: norm.handle })
        .select("prospectId name")
        .lean();
      if (dupe) {
        throw httpError(
          409,
          `@${norm.handle} ya esta en la lista como "${dupe.name}"`,
          "duplicate_handle",
        );
      }
    }

    const postedAt = input.postedAt ? new Date(input.postedAt) : undefined;
    const doc = new Prospect({
      prospectId: makeId("prosp"),
      ...norm,
      source: input.source ?? "manual",
      sourceBatch: input.sourceBatch,
      posts: input.postUrl ? [{ url: input.postUrl, postedAt }] : [],
      lastPostAt: postedAt,
      priority: input.priority ?? "C",
      ownerUserId: input.ownerUserId,
      tags: input.tags ?? [],
      notes: input.notes ?? "",
      status: "new",
    });
    recomputeDerived(doc as never);
    await doc.save();
    return sanitizeDoc(doc.toObject());
  },

  async update(prospectId: string, input: UpdateProspectInput) {
    const doc = await Prospect.findOne({ prospectId });
    if (!doc) throw httpError(404, "Prospecto no encontrado", "not_found");
    const now = new Date();

    // Los campos que pasan por el normalizador se recalculan juntos: cambiar
    // solo el telefono igual tiene que re-deducir el pais y la contactabilidad.
    const touchesIdentity =
      input.name !== undefined ||
      input.handle !== undefined ||
      input.lodgingType !== undefined ||
      input.location !== undefined ||
      input.country !== undefined ||
      input.region !== undefined ||
      input.phone !== undefined ||
      input.email !== undefined ||
      input.website !== undefined;

    if (touchesIdentity) {
      const norm = normalizeProspect({
        name: input.name ?? doc.name,
        handle: input.handle !== undefined ? input.handle : doc.handle,
        lodgingType: input.lodgingType ?? doc.lodgingType,
        location: input.location !== undefined ? input.location : doc.location,
        country: input.country !== undefined ? input.country : doc.country,
        region: input.region !== undefined ? input.region : doc.region,
        phone: input.phone !== undefined ? input.phone : doc.contact?.phoneRaw,
        email: input.email !== undefined ? input.email : doc.contact?.email,
        website: input.website !== undefined ? input.website : doc.contact?.website,
      });
      if (norm.handle && norm.handle !== doc.handle) {
        const dupe = await Prospect.findOne({
          handle: norm.handle,
          prospectId: { $ne: prospectId },
        })
          .select("name")
          .lean();
        if (dupe) {
          throw httpError(
            409,
            `@${norm.handle} ya esta en la lista como "${dupe.name}"`,
            "duplicate_handle",
          );
        }
      }
      doc.name = norm.name;
      doc.handle = norm.handle;
      doc.handleUrl = norm.handleUrl;
      doc.lodgingType = norm.lodgingType;
      doc.location = norm.location;
      doc.country = norm.country;
      doc.region = norm.region;
      doc.set("contact", norm.contact);
    }

    if (input.status !== undefined) applyStatus(doc as never, input.status, now);
    // El motivo se aplica DESPUES del cambio de etapa: si el mismo PATCH mueve
    // a `lost` y manda el motivo, `applyStatus` acaba de limpiarlo.
    if (input.lostReason !== undefined) {
      doc.lostReason = input.lostReason || undefined;
    }
    if (input.lostNote !== undefined) doc.lostNote = input.lostNote;
    if (input.priority !== undefined) doc.priority = input.priority;
    if (input.ownerUserId !== undefined) doc.ownerUserId = input.ownerUserId || undefined;
    if (input.nextActionAt !== undefined) {
      doc.nextActionAt = input.nextActionAt ? new Date(input.nextActionAt) : undefined;
    }
    if (input.nextActionNote !== undefined) doc.nextActionNote = input.nextActionNote;
    if (input.doNotCall !== undefined) {
      doc.doNotCall = input.doNotCall;
      if (input.doNotCall) doc.nextActionAt = undefined;
    }
    if (input.tags !== undefined) doc.tags = input.tags;
    if (input.notes !== undefined) doc.notes = input.notes;

    recomputeDerived(doc as never);
    await doc.save();
    return sanitizeDoc(doc.toObject());
  },

  async remove(prospectId: string) {
    const doc = await Prospect.findOneAndDelete({ prospectId });
    if (!doc) throw httpError(404, "Prospecto no encontrado", "not_found");
    const { deletedCount } = await ProspectActivity.deleteMany({ prospectId });
    return { deleted: true, activitiesDeleted: deletedCount ?? 0 };
  },

  // -------------------------------------------------------------------------
  // Actividad: el registro de la llamada
  // -------------------------------------------------------------------------

  /**
   * Registra un intento de contacto y mueve la ficha en consecuencia. Es EL
   * punto de escritura del dia a dia: contar intentos, avanzar la etapa y
   * agendar el proximo llamado en una sola operacion evita el estado clasico
   * de "llame tres veces pero la ficha sigue en Nuevo".
   */
  async logActivity(
    prospectId: string,
    input: {
      type: ActivityType;
      outcome?: ActivityOutcome;
      notes?: string;
      durationSec?: number;
      status?: ProspectStatus;
      nextActionAt?: string | Date | null;
      nextActionNote?: string;
      lostReason?: LostReason | null;
      lostNote?: string;
      occurredAt?: string | Date;
      doNotCall?: boolean;
    },
    user?: { userId: string; email: string },
  ) {
    const doc = await Prospect.findOne({ prospectId });
    if (!doc) throw httpError(404, "Prospecto no encontrado", "not_found");

    const when = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const outcome = input.outcome ?? "none";
    const statusFrom = doc.status as ProspectStatus;
    const isAttempt = ATTEMPT_TYPES.includes(input.type);

    if (isAttempt) {
      doc.attempts = (doc.attempts ?? 0) + 1;
      doc.lastAttemptAt = when;
      doc.lastOutcome = outcome;
    }

    // Si el operador no eligio etapa, se infiere del resultado. Solo hacia
    // adelante y solo desde las dos primeras: si ya esta en `demo`, un
    // "no atiende" no lo devuelve a `attempting`.
    let nextStatus = input.status;
    if (!nextStatus && isAttempt && (statusFrom === "new" || statusFrom === "attempting")) {
      if (CONNECTED_OUTCOMES.includes(outcome)) nextStatus = "contacted";
      else if (outcome === "wrong_number") nextStatus = "unreachable";
      else nextStatus = "attempting";
    }
    if (nextStatus) applyStatus(doc as never, nextStatus, when);
    if (input.lostReason !== undefined) doc.lostReason = input.lostReason || undefined;
    if (input.lostNote !== undefined) doc.lostNote = input.lostNote;

    if (input.nextActionAt !== undefined) {
      doc.nextActionAt = input.nextActionAt ? new Date(input.nextActionAt) : undefined;
    } else if (doc.nextActionAt && doc.nextActionAt <= when) {
      // El seguimiento vencido ya se cumplio con este intento: se limpia para
      // que la ficha no quede eternamente "vencida" en la cola.
      doc.nextActionAt = undefined;
    }
    if (input.nextActionNote !== undefined) doc.nextActionNote = input.nextActionNote;
    if (input.doNotCall !== undefined) {
      doc.doNotCall = input.doNotCall;
      if (input.doNotCall) doc.nextActionAt = undefined;
    }

    recomputeDerived(doc as never);
    await doc.save();

    const activity = await ProspectActivity.create({
      activityId: makeId("pact"),
      prospectId,
      type: input.type,
      outcome,
      notes: input.notes ?? "",
      durationSec: input.durationSec,
      statusFrom,
      statusTo: doc.status,
      userId: user?.userId,
      userEmail: user?.email,
      occurredAt: when,
    });

    return {
      prospect: sanitizeDoc(doc.toObject()),
      activity: sanitizeDoc(activity.toObject()),
    };
  },

  async listActivities(input: {
    prospectId?: string;
    type?: ActivityType;
    userId?: string;
    since?: Date;
    page: number;
    limit: number;
    skip: number;
  }) {
    const q: Record<string, unknown> = {};
    if (input.prospectId) q.prospectId = input.prospectId;
    if (input.type) q.type = input.type;
    if (input.userId) q.userId = input.userId;
    if (input.since) q.occurredAt = { $gte: input.since };

    const [rows, total] = await Promise.all([
      ProspectActivity.find(q)
        .sort({ occurredAt: -1 })
        .skip(input.skip)
        .limit(input.limit)
        .lean(),
      ProspectActivity.countDocuments(q),
    ]);

    // El feed sin el nombre del prospecto no se lee: "llamada · no atiende" no
    // dice nada. Se resuelven en un solo find en vez de N+1.
    const ids = [...new Set(rows.map((r) => r.prospectId))];
    const names = new Map(
      (await Prospect.find({ prospectId: { $in: ids } }).select("prospectId name").lean()).map(
        (p) => [p.prospectId, p.name],
      ),
    );

    return {
      data: rows.map((r) => ({
        ...sanitizeDoc(r),
        prospectName: names.get(r.prospectId) ?? null,
      })),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  // -------------------------------------------------------------------------
  // Cola de llamadas
  // -------------------------------------------------------------------------

  /**
   * A quien llamar ahora, en orden. Tres tramos, y ese orden es la politica:
   *
   *   1. seguimientos vencidos — hay una promesa hecha, se cumple primero
   *   2. intentados sin respuesta y ya "enfriados" — el reintento se espacia
   *      segun cuantas veces se probo (1d, 3d, 7d, 14d...) para no quemar la
   *      ficha llamando cuatro veces el mismo dia
   *   3. nunca intentados, por score
   *
   * Se excluyen los cerrados, los `doNotCall` y los que no tienen por donde
   * llamar: una cola con fichas que no se pueden llamar deja de usarse.
   */
  async queue(input: { limit: number; ownerUserId?: string; onlyMine?: boolean }) {
    const now = new Date();
    const base: Record<string, unknown> = {
      doNotCall: { $ne: true },
      outcome: "open",
      contactability: { $ne: "none" },
    };
    if (input.onlyMine && input.ownerUserId) base.ownerUserId = input.ownerUserId;

    const due = await Prospect.find({ ...base, nextActionAt: { $lte: now } })
      .sort({ nextActionAt: 1 })
      .limit(input.limit)
      .lean();

    const remaining = input.limit - due.length;
    let cooled: typeof due = [];
    let fresh: typeof due = [];

    if (remaining > 0) {
      // Reintento escalonado: 1, 3, 7, 14, 30 dias segun los intentos hechos.
      const LADDER = [1, 3, 7, 14, 30];
      const cooledOr = LADDER.map((days, i) => ({
        attempts: i + 1,
        lastAttemptAt: { $lte: new Date(now.getTime() - days * DAY_MS) },
      }));
      cooled = await Prospect.find({
        ...base,
        nextActionAt: { $in: [null, undefined] },
        $or: [
          ...cooledOr,
          // Mas de 5 intentos: el ultimo escalon se mantiene, no se abandona.
          {
            attempts: { $gt: LADDER.length },
            lastAttemptAt: { $lte: new Date(now.getTime() - 30 * DAY_MS) },
          },
        ],
      })
        .sort({ score: -1, lastAttemptAt: 1 })
        .limit(remaining)
        .lean();
    }

    const left = input.limit - due.length - cooled.length;
    if (left > 0) {
      fresh = await Prospect.find({ ...base, attempts: 0 })
        .sort({ score: -1, lastPostAt: -1 })
        .limit(left)
        .lean();
    }

    const tag = (rows: typeof due, bucket: "due" | "retry" | "fresh") =>
      rows.map((r) => ({ ...sanitizeDoc(r), queueBucket: bucket }));

    const items = [...tag(due, "due"), ...tag(cooled, "retry"), ...tag(fresh, "fresh")];

    // El total pendiente NO es `items.length`: la cola esta paginada por
    // `limit` y el numero que le importa al vendedor es cuanto le falta.
    const [pendingDue, pendingFresh, pendingOpen] = await Promise.all([
      Prospect.countDocuments({ ...base, nextActionAt: { $lte: now } }),
      Prospect.countDocuments({ ...base, attempts: 0 }),
      Prospect.countDocuments(base),
    ]);

    return {
      items,
      counts: { due: pendingDue, fresh: pendingFresh, open: pendingOpen },
    };
  },

  // -------------------------------------------------------------------------
  // Tablero
  // -------------------------------------------------------------------------

  /**
   * Los numeros del modulo: cuantos hay, en que etapa estan, cuantos fueron
   * exito y cuantos fracaso, y por que. Todo sale de agregaciones — nunca de
   * traer las fichas y contar en memoria.
   */
  async dashboard(input: { days: number }) {
    const since = new Date(Date.now() - input.days * DAY_MS);
    const now = new Date();

    const [
      byStatus,
      byOutcome,
      byLostReason,
      byType,
      byCountry,
      byContactability,
      bySource,
      totals,
      activityByDay,
      activityByOutcome,
      byOwnerRaw,
      dueNow,
      overdue,
    ] = await Promise.all([
      Prospect.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      Prospect.aggregate([{ $group: { _id: "$outcome", n: { $sum: 1 } } }]),
      Prospect.aggregate([
        { $match: { outcome: "lost", lostReason: { $ne: null } } },
        { $group: { _id: "$lostReason", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      Prospect.aggregate([
        { $group: { _id: "$lodgingType", n: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ["$outcome", "won"] }, 1, 0] } } } },
        { $sort: { n: -1 } },
      ]),
      Prospect.aggregate([
        { $group: { _id: "$country", n: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ["$outcome", "won"] }, 1, 0] } } } },
        { $sort: { n: -1 } },
        { $limit: 15 },
      ]),
      Prospect.aggregate([{ $group: { _id: "$contactability", n: { $sum: 1 } } }]),
      Prospect.aggregate([{ $group: { _id: "$source", n: { $sum: 1 } } }]),
      Prospect.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            attempts: { $sum: "$attempts" },
            touched: { $sum: { $cond: [{ $gt: ["$attempts", 0] }, 1, 0] } },
            // $ifNull y no $ne contra null: el campo AUSENTE no compara igual a
            // null en una expresion de agregacion, y sin esto "alcanzados"
            // contaba la coleccion entera.
            reached: { $sum: { $cond: [{ $ifNull: ["$firstReachedAt", false] }, 1, 0] } },
            doNotCall: { $sum: { $cond: ["$doNotCall", 1, 0] } },
            withPhone: { $sum: { $cond: [{ $eq: ["$contactability", "phone"] }, 1, 0] } },
            avgScore: { $avg: "$score" },
          },
        },
      ]),
      ProspectActivity.aggregate([
        { $match: { occurredAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" } },
            n: { $sum: 1 },
            connected: {
              $sum: { $cond: [{ $in: ["$outcome", CONNECTED_OUTCOMES] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ProspectActivity.aggregate([
        { $match: { occurredAt: { $gte: since } } },
        { $group: { _id: "$outcome", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      Prospect.aggregate([
        { $match: { ownerUserId: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$ownerUserId",
            total: { $sum: 1 },
            won: { $sum: { $cond: [{ $eq: ["$outcome", "won"] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ["$outcome", "lost"] }, 1, 0] } },
            attempts: { $sum: "$attempts" },
          },
        },
        { $sort: { total: -1 } },
      ]),
      Prospect.countDocuments({
        doNotCall: { $ne: true },
        outcome: "open",
        nextActionAt: { $lte: now },
      }),
      Prospect.countDocuments({
        doNotCall: { $ne: true },
        outcome: "open",
        nextActionAt: { $lte: new Date(now.getTime() - 2 * DAY_MS) },
      }),
    ]);

    const toMap = (rows: Array<{ _id: unknown; n: number }>) =>
      Object.fromEntries(rows.map((r) => [String(r._id ?? "unknown"), r.n]));

    const statusMap = toMap(byStatus);
    const t = totals[0] ?? {};
    const total = t.total ?? 0;
    const reached = t.reached ?? 0;
    const touched = t.touched ?? 0;
    const won = statusMap.won ?? 0;

    // Nombres de los duenios en un solo find: el tablero muestra personas.
    const ownerIds = byOwnerRaw.map((o) => String(o._id));
    const owners = ownerIds.length
      ? await InternalUser.find({ userId: { $in: ownerIds } })
          .select("userId firstName lastName email")
          .lean()
      : [];
    const ownerById = new Map(owners.map((u) => [u.userId, u]));

    return {
      generatedAt: now.toISOString(),
      windowDays: input.days,
      totals: {
        total,
        open: (byOutcome.find((o) => o._id === "open")?.n as number) ?? 0,
        won,
        lost: (byOutcome.find((o) => o._id === "lost")?.n as number) ?? 0,
        untouched: total - touched,
        touched,
        reached,
        attempts: t.attempts ?? 0,
        withPhone: t.withPhone ?? 0,
        doNotCall: t.doNotCall ?? 0,
        avgScore: Math.round(t.avgScore ?? 0),
        dueNow,
        overdue,
      },
      /**
       * Las tres tasas que definen si la operacion funciona: si la lista se
       * puede contactar, si el pitch engancha, y si el interes cierra.
       */
      rates: {
        contactRate: touched > 0 ? reached / touched : 0,
        interestRate: reached > 0 ? ((statusMap.interested ?? 0) + (statusMap.demo ?? 0) + (statusMap.proposal ?? 0) + won) / reached : 0,
        winRate: reached > 0 ? won / reached : 0,
        attemptsPerReach: reached > 0 ? (t.attempts ?? 0) / reached : 0,
      },
      funnel: PIPELINE_STATUSES.map((status) => ({
        status,
        count: statusMap[status] ?? 0,
      })),
      byStatus: statusMap,
      byOutcome: toMap(byOutcome),
      byLostReason: byLostReason.map((r) => ({ reason: String(r._id), count: r.n })),
      byLodgingType: byType.map((r) => ({
        lodgingType: String(r._id ?? "other"),
        count: r.n,
        won: r.won,
      })),
      byCountry: byCountry.map((r) => ({
        country: r._id ? String(r._id) : null,
        count: r.n,
        won: r.won,
      })),
      byContactability: toMap(byContactability),
      bySource: toMap(bySource),
      byOwner: byOwnerRaw.map((r) => {
        const u = ownerById.get(String(r._id));
        return {
          userId: String(r._id),
          name: u ? `${u.firstName} ${u.lastName}`.trim() : String(r._id),
          email: u?.email ?? null,
          total: r.total,
          won: r.won,
          lost: r.lost,
          attempts: r.attempts,
        };
      }),
      activity: {
        byDay: activityByDay.map((r) => ({
          date: String(r._id),
          count: r.n,
          connected: r.connected,
        })),
        byOutcome: activityByOutcome.map((r) => ({
          outcome: String(r._id),
          count: r.n,
        })),
        total: activityByDay.reduce((acc, r) => acc + r.n, 0),
      },
    };
  },

  // -------------------------------------------------------------------------
  // Import y acciones masivas
  // -------------------------------------------------------------------------

  /**
   * Alta masiva idempotente. La clave es el handle: correr el mismo lote dos
   * veces no duplica nada, y sobre un prospecto que ya existe SOLO se
   * completan huecos — nunca se pisa lo que cargo un operador (etapa, notas,
   * duenio, seguimiento).
   */
  async importRows(
    rows: Array<CreateProspectInput & { postUrl?: string; postedAt?: string }>,
    opts: { source?: ProspectSource; sourceBatch?: string } = {},
  ) {
    let created = 0;
    let updated = 0;
    const skipped: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row?.name?.trim()) {
        skipped.push({ row: i, reason: "sin nombre" });
        continue;
      }
      const norm = normalizeProspect(row);
      const postedAt = row.postedAt ? new Date(row.postedAt) : undefined;
      const post = row.postUrl ? { url: row.postUrl, postedAt } : null;

      const existing = norm.handle ? await Prospect.findOne({ handle: norm.handle }) : null;

      if (existing) {
        // Solo rellenar. `??=` no sirve: los strings vacios tambien son huecos.
        if (!existing.location && norm.location) existing.location = norm.location;
        if (!existing.country && norm.country) existing.country = norm.country;
        if (!existing.region && norm.region) existing.region = norm.region;
        if (existing.lodgingType === "other" && norm.lodgingType !== "other") {
          existing.lodgingType = norm.lodgingType;
        }
        const c = existing.contact ?? {};
        if (!c.phoneRaw && norm.contact.phoneRaw) {
          c.phoneRaw = norm.contact.phoneRaw;
          c.phone = norm.contact.phone;
          c.phoneCountry = norm.contact.phoneCountry;
        }
        if (!c.email && norm.contact.email) c.email = norm.contact.email;
        if (!c.website && norm.contact.website) {
          c.website = norm.contact.website;
          c.websiteDomain = norm.contact.websiteDomain;
        }
        existing.set("contact", c);

        if (post && !(existing.posts ?? []).some((p) => p.url === post.url)) {
          existing.posts.push(post);
        }
        if (postedAt && (!existing.lastPostAt || postedAt > existing.lastPostAt)) {
          existing.lastPostAt = postedAt;
        }
        recomputeDerived(existing as never);
        await existing.save();
        updated++;
        continue;
      }

      const doc = new Prospect({
        prospectId: makeId("prosp"),
        ...norm,
        source: row.source ?? opts.source ?? "import",
        sourceBatch: row.sourceBatch ?? opts.sourceBatch,
        posts: post ? [post] : [],
        lastPostAt: postedAt,
        priority: row.priority ?? "C",
        tags: row.tags ?? [],
        notes: row.notes ?? "",
        status: "new",
      });
      recomputeDerived(doc as never);
      await doc.save();
      created++;
    }

    return { received: rows.length, created, updated, skipped };
  },

  /**
   * Acciones sobre una seleccion: asignar duenio, mover de etapa, etiquetar,
   * marcar "no llamar". Sin esto, repartir 700 fichas entre dos vendedores es
   * abrir 700 fichas.
   */
  async bulk(input: {
    prospectIds: string[];
    ownerUserId?: string | null;
    status?: ProspectStatus;
    priority?: ProspectPriority;
    addTags?: string[];
    removeTags?: string[];
    doNotCall?: boolean;
    nextActionAt?: string | Date | null;
  }) {
    const docs = await Prospect.find({ prospectId: { $in: input.prospectIds } });
    const now = new Date();
    for (const doc of docs) {
      if (input.ownerUserId !== undefined) {
        doc.ownerUserId = input.ownerUserId || undefined;
      }
      if (input.status) applyStatus(doc as never, input.status, now);
      if (input.priority) doc.priority = input.priority;
      if (input.addTags?.length) {
        doc.tags = [...new Set([...(doc.tags ?? []), ...input.addTags])];
      }
      if (input.removeTags?.length) {
        const drop = new Set(input.removeTags);
        doc.tags = (doc.tags ?? []).filter((t) => !drop.has(t));
      }
      if (input.doNotCall !== undefined) {
        doc.doNotCall = input.doNotCall;
        if (input.doNotCall) doc.nextActionAt = undefined;
      }
      if (input.nextActionAt !== undefined) {
        doc.nextActionAt = input.nextActionAt ? new Date(input.nextActionAt) : undefined;
      }
      recomputeDerived(doc as never);
      await doc.save();
    }
    return { matched: input.prospectIds.length, updated: docs.length };
  },

  // -------------------------------------------------------------------------
  // Puente con el CRM
  // -------------------------------------------------------------------------

  /**
   * Un prospecto ganado pasa a ser cuenta del CRM. No se copia el historial de
   * llamadas: la ficha del prospecto sigue existiendo con su timeline y queda
   * enlazada por `accountId`, asi que la trazabilidad no se pierde y el CRM no
   * se llena de actividad de prospeccion.
   */
  async convert(
    prospectId: string,
    input: { lifecycle?: "lead" | "mql" | "demo" | "trial" | "customer" } = {},
  ) {
    const doc = await Prospect.findOne({ prospectId });
    if (!doc) throw httpError(404, "Prospecto no encontrado", "not_found");
    if (doc.accountId) {
      throw httpError(409, "Este prospecto ya tiene cuenta en el CRM", "already_converted");
    }

    const websiteDomain = doc.contact?.websiteDomain;
    // Si ya existe una cuenta con el mismo dominio se enlaza a esa en vez de
    // crear una segunda: el CRM dedupea por dominio y crear otra rompe su
    // indice unico apenas alguien le cargue el companyId.
    const existing = websiteDomain
      ? await MktAccount.findOne({ websiteDomain }).lean()
      : null;

    let accountId: string;
    if (existing) {
      accountId = existing.accountId;
    } else {
      accountId = makeId("acc");
      await MktAccount.create({
        accountId,
        name: doc.name,
        website: doc.contact?.website,
        websiteDomain,
        country: doc.country,
        city: doc.region,
        lifecycle: input.lifecycle ?? "customer",
        source: "outbound",
        ownerUserId: doc.ownerUserId,
        tags: [...new Set([...(doc.tags ?? []), "prospeccion"])],
        notes: doc.notes,
      });
    }

    doc.accountId = accountId;
    applyStatus(doc as never, "won", new Date());
    recomputeDerived(doc as never);
    await doc.save();

    return {
      prospect: sanitizeDoc(doc.toObject()),
      accountId,
      accountCreated: !existing,
    };
  },

  /**
   * Recalcula score, outcome y contactabilidad de toda la coleccion. Hace falta
   * cuando cambia la formula del score: si no, las fichas viejas quedan con el
   * valor de la formula anterior y el orden de la cola miente.
   */
  async recomputeAll() {
    const docs = await Prospect.find({});
    for (const doc of docs) {
      recomputeDerived(doc as never);
      await doc.save();
    }
    return { recomputed: docs.length };
  },

  /** Valores presentes en la coleccion, para poblar los filtros del panel. */
  async facets() {
    const [countries, regions, tags, owners] = await Promise.all([
      Prospect.distinct("country"),
      Prospect.aggregate([
        { $match: { region: { $nin: [null, ""] } } },
        { $group: { _id: "$region", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 60 },
      ]),
      Prospect.distinct("tags"),
      Prospect.distinct("ownerUserId"),
    ]);
    const ownerIds = owners.filter(Boolean) as string[];
    const users = ownerIds.length
      ? await InternalUser.find({ userId: { $in: ownerIds } })
          .select("userId firstName lastName email")
          .lean()
      : [];
    return {
      countries: (countries.filter(Boolean) as string[]).sort(),
      regions: regions.map((r) => ({ region: String(r._id), count: r.n })),
      tags: (tags.filter(Boolean) as string[]).sort(),
      owners: users.map((u) => ({
        userId: u.userId,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
      })),
    };
  },
};
