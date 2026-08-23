import type { PipelineStage } from "mongoose";

import { AnalyticsEvent } from "../analytics/analytics.model";
import { getCompanyModel } from "../hotels/pmsModels";
import {
  ATTENTION_FLAGS,
  getAccessEventModel,
  getPmsUserModel,
  getUserDeviceModel,
  type PmsAccessEvent,
  type PmsUser,
  type PmsUserDevice,
} from "./pmsAccessModels";

/**
 * Lectura de la bitácora de accesos del PMS (USERS-ACTIONS-SPEC §11).
 *
 * Todo sale por la conexión secundaria (`pmsDb`) salvo `/users/:id/actions`,
 * que lee `analytics_events` de la base PROPIA de internal: "desde dónde entró"
 * lo sabe el PMS, "qué hizo adentro" lo sabe la telemetría. Son dos clusters
 * distintos, así que no hay forma de cruzarlos en una query — se cruzan por
 * `userId` recién en la pantalla.
 *
 * El módulo es 100 % lectura: no escribe ninguna de estas colecciones.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ventana por defecto cuando la query no trae fechas. */
const DEFAULT_RANGE_DAYS = 30;
/** Ventana fija de las métricas por usuario ("accesses30d", "flags30d", …). */
const METRICS_WINDOW_DAYS = 30;
/**
 * Topes de los rankings que se resuelven con un `$in` de ids. Un `$in` de
 * decenas de miles de strings deja de aprovechar el índice y termina pesando
 * más que la query que ahorra; con estos números el panel sigue siendo útil.
 */
const ACTIVITY_RANK_CAP = 1000;
const FLAGGED_IDS_CAP = 5000;

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

export interface ListEventsInput {
  dateFrom?: Date;
  dateTo?: Date;
  companyId?: string;
  userId?: string;
  type?: string[];
  outcome?: string;
  method?: string;
  country?: string;
  city?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
  flag?: string[];
  q?: string;
  includeAutomation: boolean;
  page: number;
  limit: number;
}

export interface ListUsersInput {
  q?: string;
  companyId?: string;
  role?: string;
  status?: string;
  hasFlags: boolean;
  lastAccessFrom?: Date;
  lastAccessTo?: Date;
  page: number;
  limit: number;
  sort: "lastAccessAt" | "createdAt" | "accesses30d";
}

export interface UserActionsInput {
  dateFrom?: Date;
  dateTo?: Date;
  category?: string;
  limit: number;
}

export interface SummaryInput {
  dateFrom?: Date;
  dateTo?: Date;
  companyId?: string;
}

export interface GeoPointsInput {
  dateFrom?: Date;
  dateTo?: Date;
  companyId?: string;
  userId?: string;
  limit: number;
}

interface UserMetrics30d {
  accesses: number;
  logins: number;
  failedLogins: number;
  citiesCount: number;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Neutraliza los metacaracteres antes de meter texto del usuario en un
 * `$regex`. Sin esto, un `q` con "(" rompe la query y uno con ".*.*.*" la
 * convierte en un escaneo catastrófico de la colección.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** Rango efectivo: sin fechas, los últimos 30 días hasta ahora. */
function resolveRange(dateFrom?: Date, dateTo?: Date) {
  const to = dateTo ?? new Date();
  const from = dateFrom ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  return { from, to };
}

/**
 * Campos que las vistas de usuario necesitan. Proyección explícita en vez de un
 * `-password`: la colección `users` del PMS trae además `recentSites`,
 * `guideProgress` y el hash de la contraseña, y nada de eso tiene por qué
 * cruzar la red hasta el panel interno.
 */
const USER_LIST_FIELDS = {
  userId: 1,
  name: 1,
  email: 1,
  avatar: 1,
  role: 1,
  status: 1,
  createdAt: 1,
  lastLoginAt: 1,
  lastAccessAt: 1,
  lastAccessGeo: 1,
  lastDeviceId: 1,
  memberships: 1,
  activeCompanyId: 1,
};

/**
 * Fila del feed. Deliberadamente sin `device.raw` ni `geo.edgeRaw`: son blobs
 * de cientos de claves que sólo se miran en el detalle de un evento.
 */
function mapEventRow(
  doc: PmsAccessEvent,
  users: Map<string, PmsUser>,
  companies: Map<string, { companyId: string; name: string }>,
) {
  const best = doc.geo?.best ?? null;
  const summary = doc.device?.summary ?? null;
  const company = doc.companyId ? companies.get(doc.companyId) : undefined;

  return {
    eventId: doc.eventId,
    type: doc.type,
    outcome: doc.outcome,
    at: doc.at,
    userId: doc.userId ?? null,
    user: resolveEventUser(doc, users),
    companyId: doc.companyId ?? null,
    company: company ? { name: company.name } : null,
    method: doc.method ?? null,
    geo: best
      ? {
          country: best.country ?? null,
          region: best.region ?? null,
          city: best.city ?? null,
          source: best.source ?? null,
          confidence: best.confidence ?? null,
          lat: best.lat ?? null,
          lng: best.lng ?? null,
        }
      : null,
    geoPreciseSource: (best?.source as "precise" | "ip" | undefined) ?? null,
    device: summary
      ? {
          deviceType: summary.deviceType ?? null,
          browser: summary.browser ?? null,
          os: summary.os ?? null,
          platformLabel: summary.platformLabel ?? null,
          screen: summary.screen ?? null,
        }
      : null,
    deviceId: doc.deviceId ?? null,
    ip: doc.ip ?? null,
    asnOrg: doc.asn?.org ?? null,
    flags: doc.flags ?? [],
    viaProxy: doc.viaProxy ?? false,
    detail: doc.detail ?? {},
  };
}

/**
 * Quién es el de la fila, en orden de confianza: el usuario vivo del PMS, la
 * foto que guardó el evento (sirve cuando la cuenta se borró) y, para los
 * `login_failed` contra un email que nunca existió, el email tipeado — si no,
 * esas filas se verían vacías, que es justo cuando más importa mirarlas.
 */
function resolveEventUser(doc: PmsAccessEvent, users: Map<string, PmsUser>) {
  const live = doc.userId ? users.get(doc.userId) : undefined;
  if (live) {
    return {
      name: live.name ?? null,
      email: live.email ?? null,
      role: live.role ?? null,
    };
  }
  const snap = doc.userSnapshot;
  if (snap && (snap.name || snap.email)) {
    return {
      name: snap.name ?? null,
      email: snap.email ?? null,
      role: snap.role ?? null,
    };
  }
  if (doc.emailAttempted) {
    return { name: null, email: doc.emailAttempted, role: null };
  }
  return null;
}

/** Sub-pipeline de distribución: top 10 por un campo, ignorando los nulos. */
function topBy(field: string): PipelineStage.FacetPipelineStage[] {
  return [
    // `field` viene con el "$" del operador; el `$match` necesita el path pelado.
    { $match: { [field.slice(1)]: { $ne: null } } },
    { $group: { _id: field, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
    { $project: { _id: 0, key: "$_id", count: 1 } },
  ];
}

export const accessService = {
  // -------------------------------------------------------------------------
  // Eventos
  // -------------------------------------------------------------------------

  async listEvents(opts: ListEventsInput) {
    const AccessEvent = await getAccessEventModel();
    const filter = this._buildEventFilter(opts);
    const skip = (opts.page - 1) * opts.limit;

    const [docs, total] = await Promise.all([
      AccessEvent.find(filter)
        // Proyección por exclusión: los dos blobs pesados afuera, el resto
        // queda disponible aunque el PMS agregue campos nuevos.
        .select({ "device.raw": 0, "geo.edgeRaw": 0 })
        .sort({ at: -1 })
        .skip(skip)
        .limit(opts.limit)
        .lean(),
      AccessEvent.countDocuments(filter),
    ]);

    const events = docs as unknown as PmsAccessEvent[];
    const { users, companies } = await this._resolveRefs(events);

    return {
      data: events.map((d) => mapEventRow(d, users, companies)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },

  async getEvent(eventId: string) {
    const AccessEvent = await getAccessEventModel();
    const doc = (await AccessEvent.findOne({
      eventId,
    }).lean()) as unknown as PmsAccessEvent | null;
    if (!doc) return null;

    // Acá sí va el documento entero: `device.raw`, `geo.edgeRaw` y `detail` son
    // el motivo por el que uno abre el detalle de un evento.
    const { users, companies } = await this._resolveRefs([doc]);
    const company = doc.companyId ? companies.get(doc.companyId) : undefined;

    return {
      ...doc,
      user: resolveEventUser(doc, users),
      company: company ? { companyId: company.companyId, name: company.name } : null,
    };
  },

  // -------------------------------------------------------------------------
  // Usuarios
  // -------------------------------------------------------------------------

  async listUsers(opts: ListUsersInput) {
    const User = await getPmsUserModel();
    const since = daysAgo(METRICS_WINDOW_DAYS);

    // Se acumula en `$and` en vez de escribir sobre `filter.$or`: `q` y
    // `companyId` necesitan los dos un `$or` y el segundo pisaría al primero.
    const and: Record<string, unknown>[] = [];

    if (opts.q) {
      const re = { $regex: escapeRegex(opts.q), $options: "i" };
      and.push({ $or: [{ name: re }, { email: re }, { userId: re }] });
    }
    if (opts.role) and.push({ role: opts.role });
    if (opts.status) and.push({ status: opts.status });
    if (opts.companyId) {
      // La pertenencia real es la membership; `activeCompanyId` cubre a los
      // usuarios viejos que todavía no la tienen escrita.
      and.push({
        $or: [
          { "memberships.companyId": opts.companyId },
          { activeCompanyId: opts.companyId },
        ],
      });
    }
    if (opts.lastAccessFrom || opts.lastAccessTo) {
      const range: Record<string, Date> = {};
      if (opts.lastAccessFrom) range.$gte = opts.lastAccessFrom;
      if (opts.lastAccessTo) range.$lte = opts.lastAccessTo;
      and.push({ lastAccessAt: range });
    }
    if (opts.hasFlags) {
      and.push({ userId: { $in: await this._flaggedUserIds(since, opts.companyId) } });
    }

    const skip = (opts.page - 1) * opts.limit;
    let rows: PmsUser[];
    let total: number;

    if (opts.sort === "accesses30d") {
      // El orden por actividad no vive en `users`: hay que rankear primero
      // sobre la bitácora y recién después traer los documentos. Consecuencia
      // asumida: quien no tuvo ningún acceso en 30 días no aparece con este
      // orden — es un ranking de actividad, no el padrón completo.
      const ranked = await this._activityRanking(since, opts.companyId);
      const position = new Map(ranked.map((id, i) => [id, i] as const));
      const docs = (await User.find({ $and: [...and, { userId: { $in: ranked } }] })
        .select(USER_LIST_FIELDS)
        .lean()) as unknown as PmsUser[];
      docs.sort(
        (a, b) =>
          (position.get(a.userId) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.userId) ?? Number.MAX_SAFE_INTEGER),
      );
      total = docs.length;
      rows = docs.slice(skip, skip + opts.limit);
    } else {
      const filter = and.length > 0 ? { $and: and } : {};
      const sortSpec: Record<string, -1> =
        opts.sort === "createdAt" ? { createdAt: -1 } : { lastAccessAt: -1 };
      const [docs, count] = await Promise.all([
        User.find(filter)
          .select(USER_LIST_FIELDS)
          .sort(sortSpec)
          .skip(skip)
          .limit(opts.limit)
          .lean(),
        User.countDocuments(filter),
      ]);
      rows = docs as unknown as PmsUser[];
      total = count;
    }

    const ids = rows.map((u) => u.userId);
    const [metrics, devices, companyNames] = await Promise.all([
      this._metrics30d(ids, since),
      this._deviceCounts(ids),
      this._companyNamesOf(rows),
    ]);

    const data = rows.map((u) => {
      const m = metrics.get(u.userId);
      const companyIds = new Set<string>();
      for (const ms of u.memberships ?? []) {
        if (ms.companyId) companyIds.add(ms.companyId);
      }
      if (u.activeCompanyId) companyIds.add(u.activeCompanyId);

      return {
        userId: u.userId,
        name: u.name ?? null,
        email: u.email ?? null,
        avatar: u.avatar ?? null,
        role: u.role ?? null,
        status: u.status ?? null,
        createdAt: u.createdAt ?? null,
        lastLoginAt: u.lastLoginAt ?? null,
        lastAccessAt: u.lastAccessAt ?? null,
        lastAccessGeo: u.lastAccessGeo ?? null,
        companies: [...companyIds].map((cid) => ({
          companyId: cid,
          name: companyNames.get(cid) ?? cid,
        })),
        devicesCount: devices.get(u.userId) ?? 0,
        citiesCount: m?.citiesCount ?? 0,
        accesses30d: m?.accesses ?? 0,
        failedLogins30d: m?.failedLogins ?? 0,
        flags30d: m?.flags ?? [],
      };
    });

    return { data, total, page: opts.page, limit: opts.limit };
  },

  async getUser(userId: string) {
    const [User, Device, AccessEvent] = await Promise.all([
      getPmsUserModel(),
      getUserDeviceModel(),
      getAccessEventModel(),
    ]);

    const user = (await User.findOne({ userId })
      .select(USER_LIST_FIELDS)
      .lean()) as unknown as PmsUser | null;
    if (!user) return null;

    const since = daysAgo(METRICS_WINDOW_DAYS);
    const [metrics, devicesCount, firstEvent, devices, lastEventDocs, companyNames] =
      await Promise.all([
        this._metrics30d([userId], since),
        Device.countDocuments({ userId }),
        AccessEvent.findOne({ userId }).select({ at: 1 }).sort({ at: 1 }).lean(),
        Device.find({ userId }).sort({ lastSeenAt: -1 }).lean(),
        AccessEvent.find({ userId })
          .select({ "device.raw": 0, "geo.edgeRaw": 0 })
          .sort({ at: -1 })
          .limit(20)
          .lean(),
        this._companyNamesOf([user]),
      ]);

    const m = metrics.get(userId);
    const events = lastEventDocs as unknown as PmsAccessEvent[];
    const refs = await this._resolveRefs(events);

    return {
      user,
      companies: (user.memberships ?? []).map((ms) => ({
        companyId: ms.companyId ?? null,
        name: ms.companyId ? companyNames.get(ms.companyId) ?? ms.companyId : null,
        role: ms.role ?? null,
        status: ms.status ?? null,
      })),
      stats: {
        accesses30d: m?.accesses ?? 0,
        logins30d: m?.logins ?? 0,
        failedLogins30d: m?.failedLogins ?? 0,
        devicesCount,
        citiesCount: m?.citiesCount ?? 0,
        firstSeenAt: (firstEvent as { at?: Date } | null)?.at ?? null,
        lastAccessAt: user.lastAccessAt ?? null,
      },
      devices: devices as unknown as PmsUserDevice[],
      lastEvents: events.map((d) => mapEventRow(d, refs.users, refs.companies)),
    };
  },

  /** ¿Existe el usuario en el PMS? Para responder 404 antes de agregar nada. */
  async userExists(userId: string): Promise<boolean> {
    const User = await getPmsUserModel();
    return (await User.countDocuments({ userId })) > 0;
  },

  async listUserDevices(userId: string) {
    const Device = await getUserDeviceModel();
    return (await Device.find({ userId })
      .sort({ lastSeenAt: -1 })
      .lean()) as unknown as PmsUserDevice[];
  },

  /**
   * "Qué hizo adentro". Sale de `analytics_events`, que vive en la base propia
   * de internal (no en la del PMS), así que es la única query del módulo que no
   * pasa por `pmsDb`.
   */
  async listUserActions(userId: string, opts: UserActionsInput) {
    const { from, to } = resolveRange(opts.dateFrom, opts.dateTo);
    const filter: Record<string, unknown> = {
      userId,
      serverTimestamp: { $gte: from, $lte: to },
    };
    if (opts.category) filter.category = opts.category;

    const docs = await AnalyticsEvent.find(filter)
      .sort({ serverTimestamp: -1 })
      .limit(opts.limit)
      .lean();

    return docs.map((e) => ({
      eventName: e.eventName,
      category: e.category,
      source: e.source,
      companyId: e.companyId ?? null,
      propertyId: e.propertyId ?? null,
      payload: e.payload ?? {},
      serverTimestamp: e.serverTimestamp,
    }));
  },

  // -------------------------------------------------------------------------
  // Agregados
  // -------------------------------------------------------------------------

  async summary(opts: SummaryInput) {
    const AccessEvent = await getAccessEventModel();
    const { from, to } = resolveRange(opts.dateFrom, opts.dateTo);

    const match: Record<string, unknown> = { at: { $gte: from, $lte: to } };
    if (opts.companyId) match.companyId = opts.companyId;

    const attention = [...ATTENTION_FLAGS];

    // Un solo `$facet`: los diez cortes comparten el mismo `$match`, que es la
    // única etapa que puede usar índice. Diez pipelines sueltos leerían diez
    // veces el mismo rango de la bitácora.
    const [result] = await AccessEvent.aggregate([
      { $match: match },
      {
        $facet: {
          kpis: [
            {
              $group: {
                _id: null,
                accesses: { $sum: 1 },
                users: { $addToSet: "$userId" },
                sessions: {
                  $sum: { $cond: [{ $eq: ["$type", "session_started"] }, 1, 0] },
                },
                logins: {
                  $sum: { $cond: [{ $eq: ["$type", "login_succeeded"] }, 1, 0] },
                },
                failedLogins: {
                  $sum: { $cond: [{ $eq: ["$type", "login_failed"] }, 1, 0] },
                },
                registrations: {
                  $sum: { $cond: [{ $eq: ["$type", "user_registered"] }, 1, 0] },
                },
                accountsCreated: {
                  $sum: { $cond: [{ $eq: ["$type", "account_created"] }, 1, 0] },
                },
                newDevices: {
                  $sum: { $cond: [{ $in: ["new_device", { $ifNull: ["$flags", []] }] }, 1, 0] },
                },
                flagged: {
                  $sum: {
                    $cond: [
                      {
                        $gt: [
                          {
                            $size: {
                              $setIntersection: [{ $ifNull: ["$flags", []] }, attention],
                            },
                          },
                          0,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                accesses: 1,
                sessions: 1,
                logins: 1,
                failedLogins: 1,
                registrations: 1,
                accountsCreated: 1,
                newDevices: 1,
                flagged: 1,
                // Los eventos anónimos (login fallido contra un email que no
                // existe) entran al set como null y no son un usuario.
                uniqueUsers: {
                  $size: {
                    $filter: { input: "$users", as: "u", cond: { $ne: ["$$u", null] } },
                  },
                },
              },
            },
          ],
          byCountry: topBy("$geo.best.country"),
          byCity: [
            { $match: { "geo.best.city": { $ne: null } } },
            {
              $group: {
                _id: { city: "$geo.best.city", country: "$geo.best.country" },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $project: { _id: 0, key: "$_id.city", country: "$_id.country", count: 1 } },
          ],
          byDeviceType: topBy("$device.summary.deviceType"),
          byBrowser: topBy("$device.summary.browser"),
          byOs: topBy("$device.summary.os"),
          byMethod: topBy("$method"),
          byDay: [
            {
              $group: {
                // Día civil UTC, igual que el rollup de métricas: el panel es
                // multi-país y el único día que no depende de quién mira.
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$at" } },
                accesses: { $sum: 1 },
                logins: {
                  $sum: { $cond: [{ $eq: ["$type", "login_succeeded"] }, 1, 0] },
                },
                failedLogins: {
                  $sum: { $cond: [{ $eq: ["$type", "login_failed"] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: "$_id", accesses: 1, logins: 1, failedLogins: 1 } },
          ],
          topFlags: [
            { $unwind: "$flags" },
            { $group: { _id: "$flags", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $project: { _id: 0, key: "$_id", count: 1 } },
          ],
        },
      },
    ]);

    const kpis = result?.kpis?.[0] ?? {};
    return {
      range: { from, to },
      kpis: {
        accesses: kpis.accesses ?? 0,
        uniqueUsers: kpis.uniqueUsers ?? 0,
        sessions: kpis.sessions ?? 0,
        logins: kpis.logins ?? 0,
        failedLogins: kpis.failedLogins ?? 0,
        registrations: kpis.registrations ?? 0,
        accountsCreated: kpis.accountsCreated ?? 0,
        newDevices: kpis.newDevices ?? 0,
        flagged: kpis.flagged ?? 0,
      },
      byCountry: result?.byCountry ?? [],
      byCity: result?.byCity ?? [],
      byDeviceType: result?.byDeviceType ?? [],
      byBrowser: result?.byBrowser ?? [],
      byOs: result?.byOs ?? [],
      byMethod: result?.byMethod ?? [],
      byDay: result?.byDay ?? [],
      topFlags: result?.topFlags ?? [],
    };
  },

  async geoPoints(opts: GeoPointsInput) {
    const AccessEvent = await getAccessEventModel();
    const { from, to } = resolveRange(opts.dateFrom, opts.dateTo);

    const match: Record<string, unknown> = {
      at: { $gte: from, $lte: to },
      // `$ne: null` descarta también los documentos donde el campo no existe:
      // un punto sin coordenadas no se puede dibujar en el mapa.
      "geo.best.lat": { $ne: null },
      "geo.best.lng": { $ne: null },
    };
    if (opts.companyId) match.companyId = opts.companyId;
    if (opts.userId) match.userId = opts.userId;

    const points = (await AccessEvent.aggregate([
      { $match: match },
      // Ordenar antes de agrupar hace que `$first` sea el evento más reciente
      // de esa ciudad: las coordenadas del punto son las de la última lectura,
      // no las de una cualquiera.
      { $sort: { at: -1 } },
      {
        $group: {
          _id: { city: "$geo.best.city", country: "$geo.best.country" },
          lat: { $first: "$geo.best.lat" },
          lng: { $first: "$geo.best.lng" },
          source: { $first: "$geo.best.source" },
          lastAt: { $first: "$at" },
          count: { $sum: 1 },
          userIds: { $addToSet: "$userId" },
          /**
           * Quién entró desde esta ciudad, para el popup del mapa.
           *
           * Va con `$addToSet` sobre el par y no con `$push`: acumular un
           * elemento por evento cargaría en memoria decenas de miles de
           * entradas en una ciudad activa. Como conjunto, el tamaño lo acota la
           * cantidad de personas distintas, que es lo que se va a mostrar.
           *
           * El par lleva la company porque la misma persona puede entrar a dos
           * hoteles: son dos filas distintas en el popup, no una.
           */
          visitors: {
            $addToSet: { userId: "$userId", companyId: "$companyId" },
          },
        },
      },
      {
        $project: {
          _id: 0,
          city: "$_id.city",
          country: "$_id.country",
          lat: 1,
          lng: 1,
          source: 1,
          lastAt: 1,
          count: 1,
          users: {
            $size: {
              $filter: { input: "$userIds", as: "u", cond: { $ne: ["$$u", null] } },
            },
          },
          // Los pares sin usuario (un login fallido contra un email que no
          // existe) no representan a nadie y no van al popup.
          visitors: {
            $filter: {
              input: "$visitors",
              as: "v",
              cond: { $ne: ["$$v.userId", null] },
            },
          },
        },
      },
      { $sort: { count: -1 } },
      { $limit: opts.limit },
    ])) as Array<{
      city: string | null;
      country: string | null;
      lat: number;
      lng: number;
      source: string | null;
      lastAt: Date;
      count: number;
      users: number;
      visitors: Array<{ userId: string; companyId?: string | null }>;
    }>;

    return this._attachVisitors(points);
  },

  /**
   * Le pone cara y hotel a cada punto del mapa.
   *
   * El popup muestra quién entró desde esa ciudad, y para eso hacen falta datos
   * que no están en la bitácora: el nombre, la foto y el nombre del hotel. Se
   * resuelven en DOS queries para todo el mapa —una de usuarios y una de
   * companies— y no una por ciudad: con 300 ciudades eso serían 600 viajes a la
   * base para dibujar una pantalla.
   */
  async _attachVisitors<
    T extends { visitors: Array<{ userId: string; companyId?: string | null }> },
  >(points: T[]) {
    const userIds = new Set<string>();
    const companyIds = new Set<string>();
    for (const point of points) {
      for (const v of point.visitors ?? []) {
        if (v.userId) userIds.add(v.userId);
        if (v.companyId) companyIds.add(v.companyId);
      }
    }

    const [User, Company] = await Promise.all([getPmsUserModel(), getCompanyModel()]);
    const [userDocs, companyDocs] = await Promise.all([
      userIds.size > 0
        ? User.find({ userId: { $in: [...userIds] } })
            .select({ userId: 1, name: 1, email: 1, avatar: 1, role: 1 })
            .lean()
        : Promise.resolve([]),
      companyIds.size > 0
        ? Company.find({ companyId: { $in: [...companyIds] } })
            .select({ companyId: 1, name: 1 })
            .lean()
        : Promise.resolve([]),
    ]);

    const users = new Map(
      (userDocs as unknown as PmsUser[]).map((u) => [u.userId, u] as const),
    );
    const companies = new Map(
      (
        companyDocs as unknown as Array<{ companyId: string; name: string }>
      ).map((c) => [c.companyId, c] as const),
    );

    return points.map((point) => ({
      ...point,
      visitors: (point.visitors ?? [])
        .map((v) => {
          const user = users.get(v.userId);
          const company = v.companyId ? companies.get(v.companyId) : undefined;
          return {
            userId: v.userId,
            // El usuario pudo haberse borrado después del acceso: la fila se
            // muestra igual con el id, que es más que un hueco.
            name: user?.name ?? null,
            email: user?.email ?? null,
            avatar: user?.avatar ?? null,
            role: user?.role ?? null,
            companyId: v.companyId ?? null,
            companyName: company?.name ?? null,
          };
        })
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
    }));
  },

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  _buildEventFilter(opts: ListEventsInput): Record<string, unknown> {
    const { from, to } = resolveRange(opts.dateFrom, opts.dateTo);
    const filter: Record<string, unknown> = { at: { $gte: from, $lte: to } };

    if (opts.companyId) filter.companyId = opts.companyId;
    if (opts.userId) filter.userId = opts.userId;
    if (opts.type && opts.type.length > 0) filter.type = { $in: opts.type };
    if (opts.outcome) filter.outcome = opts.outcome;
    if (opts.method) filter.method = opts.method;
    if (opts.country) filter["geo.best.country"] = opts.country;
    if (opts.city) filter["geo.best.city"] = opts.city;
    if (opts.deviceType) filter["device.summary.deviceType"] = opts.deviceType;

    // `browser` y `os` se guardan con la versión pegada ("Chrome 128",
    // "Windows 11"), así que un igual exacto no sirve para filtrar "todo
    // Chrome": se ancla al principio y se compara sin distinguir mayúsculas.
    if (opts.browser) {
      filter["device.summary.browser"] = {
        $regex: `^${escapeRegex(opts.browser)}`,
        $options: "i",
      };
    }
    if (opts.os) {
      filter["device.summary.os"] = {
        $regex: `^${escapeRegex(opts.os)}`,
        $options: "i",
      };
    }

    // Varios flags pedidos = todos presentes (`$all`); es lo que espera quien
    // filtra "nuevo país Y viaje imposible".
    const flagConditions: Record<string, unknown> = {};
    if (opts.flag && opts.flag.length > 0) flagConditions.$all = opts.flag;
    // Los accesos de bots y escáneres son mayoría en el feed crudo y tapan la
    // actividad real, así que quedan afuera salvo pedido explícito.
    if (!opts.includeAutomation) flagConditions.$ne = "automation";
    if (Object.keys(flagConditions).length > 0) filter.flags = flagConditions;

    if (opts.q) {
      const re = { $regex: escapeRegex(opts.q), $options: "i" };
      filter.$or = [
        { emailAttempted: re },
        { "userSnapshot.email": re },
        { "userSnapshot.name": re },
        { ip: re },
        { deviceId: re },
        { userId: re },
      ];
    }

    return filter;
  },

  /**
   * Resuelve usuario y company de una página de eventos.
   *
   * Dos `find` con `$in` y no un `$lookup`: aunque las tres colecciones vivan
   * hoy en el mismo cluster, `$lookup` corre una vez por documento y ata la
   * consulta a que sigan estando en la misma base. Con la página ya acotada a
   * ≤100 filas, dos queries indexadas cuestan menos y sobreviven a que mañana
   * el PMS parta `users` o `companies` a otro lado.
   */
  async _resolveRefs(events: PmsAccessEvent[]) {
    const userIds = [
      ...new Set(events.map((e) => e.userId).filter(Boolean)),
    ] as string[];
    const companyIds = [
      ...new Set(events.map((e) => e.companyId).filter(Boolean)),
    ] as string[];

    const [User, Company] = await Promise.all([getPmsUserModel(), getCompanyModel()]);
    const [userDocs, companyDocs] = await Promise.all([
      userIds.length > 0
        ? User.find({ userId: { $in: userIds } })
            .select({ userId: 1, name: 1, email: 1, role: 1, avatar: 1 })
            .lean()
        : Promise.resolve([]),
      companyIds.length > 0
        ? Company.find({ companyId: { $in: companyIds } })
            .select({ companyId: 1, name: 1 })
            .lean()
        : Promise.resolve([]),
    ]);

    return {
      users: new Map(
        (userDocs as unknown as PmsUser[]).map((u) => [u.userId, u] as const),
      ),
      companies: new Map(
        (companyDocs as unknown as Array<{ companyId: string; name: string }>).map(
          (c) => [c.companyId, c] as const,
        ),
      ),
    };
  },

  /** Nombres de las companies que aparecen en una página de usuarios. */
  async _companyNamesOf(users: PmsUser[]) {
    const ids = new Set<string>();
    for (const u of users) {
      for (const ms of u.memberships ?? []) {
        if (ms.companyId) ids.add(ms.companyId);
      }
      if (u.activeCompanyId) ids.add(u.activeCompanyId);
    }
    if (ids.size === 0) return new Map<string, string>();

    const Company = await getCompanyModel();
    const docs = (await Company.find({ companyId: { $in: [...ids] } })
      .select({ companyId: 1, name: 1 })
      .lean()) as unknown as Array<{ companyId: string; name: string }>;
    return new Map(docs.map((c) => [c.companyId, c.name] as const));
  },

  /**
   * Métricas de 30 días de TODA la página en una sola agregación. Una query por
   * usuario serían 50 roundtrips por pantalla; así es uno solo, y el `$match`
   * por `userId` + `at` cae en el índice `{userId: 1, at: -1}` de la bitácora.
   */
  async _metrics30d(userIds: string[], since: Date) {
    const out = new Map<string, UserMetrics30d>();
    if (userIds.length === 0) return out;

    const AccessEvent = await getAccessEventModel();
    const rows = await AccessEvent.aggregate([
      { $match: { userId: { $in: userIds }, at: { $gte: since } } },
      {
        $group: {
          _id: "$userId",
          accesses: { $sum: 1 },
          logins: { $sum: { $cond: [{ $eq: ["$type", "login_succeeded"] }, 1, 0] } },
          failedLogins: { $sum: { $cond: [{ $eq: ["$type", "login_failed"] }, 1, 0] } },
          // `flags` es un array por evento, así que `$addToSet` junta arrays;
          // se aplanan con `$setUnion` en el `$project` de abajo.
          flagSets: { $addToSet: "$flags" },
          cities: { $addToSet: "$geo.best.city" },
        },
      },
      {
        $project: {
          accesses: 1,
          logins: 1,
          failedLogins: 1,
          flags: {
            $reduce: {
              input: "$flagSets",
              initialValue: [],
              in: { $setUnion: ["$$value", { $ifNull: ["$$this", []] }] },
            },
          },
          citiesCount: {
            $size: {
              $filter: { input: "$cities", as: "c", cond: { $ne: ["$$c", null] } },
            },
          },
        },
      },
    ]);

    for (const r of rows as Array<Record<string, any>>) {
      out.set(r._id, {
        accesses: r.accesses ?? 0,
        logins: r.logins ?? 0,
        failedLogins: r.failedLogins ?? 0,
        citiesCount: r.citiesCount ?? 0,
        flags: ((r.flags ?? []) as string[]).filter(Boolean),
      });
    }
    return out;
  },

  /** Cuántos equipos conocidos tiene cada usuario de la página, en una query. */
  async _deviceCounts(userIds: string[]) {
    const counts = new Map<string, number>();
    if (userIds.length === 0) return counts;

    const Device = await getUserDeviceModel();
    const rows = await Device.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);
    for (const r of rows as Array<{ _id: string; count: number }>) {
      counts.set(r._id, r.count);
    }
    return counts;
  },

  /**
   * Usuarios con al menos un flag de atención en la ventana, más recientes
   * primero. Sale como lista de ids para poder cruzarla con el filtro de
   * `users`, que vive en otra colección.
   */
  async _flaggedUserIds(since: Date, companyId?: string): Promise<string[]> {
    const AccessEvent = await getAccessEventModel();
    const match: Record<string, unknown> = {
      at: { $gte: since },
      userId: { $ne: null },
      flags: { $in: [...ATTENTION_FLAGS] },
    };
    if (companyId) match.companyId = companyId;

    const rows = await AccessEvent.aggregate([
      { $match: match },
      { $group: { _id: "$userId", lastAt: { $max: "$at" } } },
      { $sort: { lastAt: -1 } },
      { $limit: FLAGGED_IDS_CAP },
    ]);
    return (rows as Array<{ _id: string }>).map((r) => r._id);
  },

  /** Ranking de usuarios por cantidad de accesos en la ventana. */
  async _activityRanking(since: Date, companyId?: string): Promise<string[]> {
    const AccessEvent = await getAccessEventModel();
    const match: Record<string, unknown> = {
      at: { $gte: since },
      userId: { $ne: null },
    };
    if (companyId) match.companyId = companyId;

    const rows = await AccessEvent.aggregate([
      { $match: match },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: ACTIVITY_RANK_CAP },
    ]);
    return (rows as Array<{ _id: string }>).map((r) => r._id);
  },
};
