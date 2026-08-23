import { makeId } from "../../shared/utils/ids";
import {
  getCompanyModel,
  getPropertyModel,
  getUnitModel,
} from "../hotels/pmsModels";
import { UsageDailyRollup } from "../usage/usage.model";
import {
  MktAccount,
  MktContact,
  MktEvent,
  domainOf,
  sanitizeDoc,
  type AccountLifecycle,
  type AccountSource,
  type MktEventType,
} from "./crm.model";

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

/**
 * Consumers del outbox registrados por otros modulos.
 *
 * Es un registro y no un import directo a proposito: `campaigns` ya importa
 * `crm` (para resolver segmentos y contactos), asi que si `crm` importara
 * `campaigns` para encolar, el ciclo rompe la carga de modulos. Cada modulo se
 * engancha al arrancar (ver `index.ts`).
 */
export interface OutboxEvent {
  eventId: string;
  type: string;
  accountId?: string | null;
  companyId?: string | null;
  correlationId: string;
  payload?: Record<string, unknown>;
}
type EventConsumer = (evt: OutboxEvent) => Promise<unknown>;
const eventConsumers: EventConsumer[] = [];

export function registerEventConsumer(fn: EventConsumer) {
  eventConsumers.push(fn);
}

/** Backoff del outbox: 1min, 5min, 25min, 2h, 10h. Se corta a los 5 intentos. */
const MAX_DELIVERY_ATTEMPTS = 5;
function nextRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * Math.pow(5, attempts), 10 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

export interface ListAccountsInput {
  lifecycle?: AccountLifecycle;
  source?: AccountSource;
  tag?: string;
  ownerUserId?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}

export const crmService = {
  async listAccounts(input: ListAccountsInput) {
    const q: Record<string, unknown> = {};
    if (input.lifecycle) q.lifecycle = input.lifecycle;
    if (input.source) q.source = input.source;
    if (input.tag) q.tags = input.tag;
    if (input.ownerUserId) q.ownerUserId = input.ownerUserId;
    if (input.search) {
      const rx = new RegExp(input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ name: rx }, { website: rx }, { companyId: rx }];
    }

    const [rows, total] = await Promise.all([
      MktAccount.find(q).sort({ updatedAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      MktAccount.countDocuments(q),
    ]);

    return {
      data: rows.map(sanitizeDoc),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  async getAccount(accountId: string) {
    const account = await MktAccount.findOne({ accountId }).lean();
    if (!account) throw httpError(404, "Cuenta no encontrada", "not_found");

    const [contacts, events] = await Promise.all([
      MktContact.find({ accountId }).sort({ isPrimary: -1, createdAt: 1 }).lean(),
      MktEvent.find({ accountId }).sort({ occurredAt: -1 }).limit(50).lean(),
    ]);

    return {
      ...sanitizeDoc(account),
      contacts: contacts.map(sanitizeDoc),
      timeline: events.map(sanitizeDoc),
    };
  },

  async createAccount(input: Record<string, any>) {
    const websiteDomain = domainOf(input.website);

    // Dedupe: por companyId si viene, si no por dominio del sitio.
    if (input.companyId) {
      const dup = await MktAccount.findOne({ companyId: input.companyId }).lean();
      if (dup) throw httpError(409, "Ya existe una cuenta para esa company", "duplicate");
    } else if (websiteDomain) {
      const dup = await MktAccount.findOne({ websiteDomain }).lean();
      if (dup) throw httpError(409, "Ya existe una cuenta con ese dominio", "duplicate");
    }

    const doc = await MktAccount.create({
      ...input,
      accountId: makeId("acc"),
      websiteDomain,
      lifecycleChangedAt: new Date(),
    });
    return sanitizeDoc(doc.toObject());
  },

  async updateAccount(accountId: string, patch: Record<string, any>) {
    const current = await MktAccount.findOne({ accountId });
    if (!current) throw httpError(404, "Cuenta no encontrada", "not_found");

    if (patch.website !== undefined) patch.websiteDomain = domainOf(patch.website);
    // El reloj de la etapa se reinicia solo cuando la etapa realmente cambia.
    if (patch.lifecycle && patch.lifecycle !== current.lifecycle) {
      patch.lifecycleChangedAt = new Date();
    }

    const doc = await MktAccount.findOneAndUpdate(
      { accountId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    return sanitizeDoc(doc);
  },

  // -------------------------------------------------------------------------
  // Contactos
  // -------------------------------------------------------------------------

  async listContacts(accountId?: string) {
    const q = accountId ? { accountId } : {};
    const rows = await MktContact.find(q).sort({ isPrimary: -1, createdAt: 1 }).lean();
    return rows.map(sanitizeDoc);
  },

  async createContact(input: Record<string, any>) {
    const account = await MktAccount.findOne({ accountId: input.accountId }).lean();
    if (!account) throw httpError(404, "La cuenta no existe", "not_found");

    const email = String(input.email).toLowerCase().trim();
    const dup = await MktContact.findOne({ email }).lean();
    if (dup) throw httpError(409, "Ya existe un contacto con ese email", "duplicate");

    // El primero de la cuenta queda como principal aunque no lo pidan.
    const count = await MktContact.countDocuments({ accountId: input.accountId });
    const doc = await MktContact.create({
      ...input,
      email,
      contactId: makeId("cnt"),
      isPrimary: count === 0 ? true : Boolean(input.isPrimary),
    });
    return sanitizeDoc(doc.toObject());
  },

  async updateContact(contactId: string, patch: Record<string, any>) {
    if (patch.email) patch.email = String(patch.email).toLowerCase().trim();
    const doc = await MktContact.findOneAndUpdate(
      { contactId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Contacto no encontrado", "not_found");
    return sanitizeDoc(doc);
  },

  async deleteContact(contactId: string) {
    const res = await MktContact.deleteOne({ contactId });
    if (res.deletedCount === 0) {
      throw httpError(404, "Contacto no encontrado", "not_found");
    }
    return { deleted: true };
  },

  /**
   * Import masivo desde las planillas de hoy. Nunca falla entero: cada fila se
   * resuelve sola y se devuelve el detalle de las que se saltearon, para poder
   * corregir el CSV sin adivinar.
   */
  async importAccounts(rows: Record<string, any>[]) {
    let created = 0;
    let contactsCreated = 0;
    const skipped: { row: number; name: string; reason: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const websiteDomain = domainOf(row.website);
        if (websiteDomain) {
          const dup = await MktAccount.findOne({ websiteDomain }).lean();
          if (dup) {
            skipped.push({ row: i + 1, name: row.name, reason: "dominio duplicado" });
            continue;
          }
        }

        const account = await MktAccount.create({
          accountId: makeId("acc"),
          name: row.name,
          website: row.website || undefined,
          websiteDomain,
          country: row.country || undefined,
          city: row.city || undefined,
          lifecycle: row.lifecycle ?? "lead",
          source: "import",
          tags: row.tags ?? [],
          lifecycleChangedAt: new Date(),
        });
        created++;

        if (row.email) {
          const email = String(row.email).toLowerCase().trim();
          const dupContact = await MktContact.findOne({ email }).lean();
          if (!dupContact) {
            await MktContact.create({
              contactId: makeId("cnt"),
              accountId: account.accountId,
              email,
              firstName: row.firstName || undefined,
              lastName: row.lastName || undefined,
              phone: row.phone || undefined,
              isPrimary: true,
            });
            contactsCreated++;
          }
        }
      } catch (err: any) {
        skipped.push({
          row: i + 1,
          name: row?.name ?? "",
          reason: String(err?.message ?? err).slice(0, 200),
        });
      }
    }

    return { received: rows.length, created, contactsCreated, skipped };
  },

  // -------------------------------------------------------------------------
  // Eventos
  // -------------------------------------------------------------------------

  /**
   * Ingesta idempotente. El emisor manda su `correlationId`; repetirlo devuelve
   * el evento que ya existia en vez de duplicarlo. Es lo que hace seguro el
   * reintento del cliente fire-and-forget de los repos del PMS.
   */
  async ingestEvent(input: {
    type: MktEventType;
    correlationId: string;
    accountId?: string;
    companyId?: string;
    payload?: Record<string, unknown>;
    source?: string;
    occurredAt?: Date;
  }) {
    const existing = await MktEvent.findOne({
      correlationId: input.correlationId,
    }).lean();
    if (existing) return { event: sanitizeDoc(existing), duplicate: true };

    // Si vino companyId pero no accountId, se resuelve la cuenta acá para que
    // el timeline quede colgado de ella sin depender del consumer.
    let accountId = input.accountId;
    if (!accountId && input.companyId) {
      const acc = await MktAccount.findOne({ companyId: input.companyId })
        .select({ accountId: 1 })
        .lean();
      accountId = acc?.accountId;
    }

    const doc = await MktEvent.create({
      eventId: makeId("evt"),
      type: input.type,
      correlationId: input.correlationId,
      accountId,
      companyId: input.companyId,
      payload: input.payload ?? {},
      source: input.source ?? "internal",
      occurredAt: input.occurredAt ?? new Date(),
    });
    return { event: sanitizeDoc(doc.toObject()), duplicate: false };
  },

  async listEvents(input: {
    type?: MktEventType;
    accountId?: string;
    status?: string;
    page: number;
    limit: number;
    skip: number;
  }) {
    const q: Record<string, unknown> = {};
    if (input.type) q.type = input.type;
    if (input.accountId) q.accountId = input.accountId;
    if (input.status) q["delivery.status"] = input.status;

    const [rows, total] = await Promise.all([
      MktEvent.find(q).sort({ occurredAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      MktEvent.countDocuments(q),
    ]);
    return { data: rows.map(sanitizeDoc), total, page: input.page, limit: input.limit };
  },

  /**
   * Drena el outbox: aplica el efecto de cada evento pendiente sobre la cuenta.
   *
   * Un fallo no frena al resto ni se pierde: se agenda un reintento con backoff
   * y despues de `MAX_DELIVERY_ATTEMPTS` queda en `failed` para inspeccion
   * manual, nunca descartado en silencio.
   */
  async drainOutbox(limit = 200) {
    const now = new Date();
    const pending = await MktEvent.find({
      "delivery.status": "pending",
      $or: [
        { "delivery.nextRetryAt": { $exists: false } },
        { "delivery.nextRetryAt": null },
        { "delivery.nextRetryAt": { $lte: now } },
      ],
    })
      .sort({ occurredAt: 1 })
      .limit(limit);

    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (const evt of pending) {
      try {
        const applied = await applyEvent(evt);
        evt.set("delivery.status", applied ? "delivered" : "skipped");
        evt.set("delivery.lastAttemptAt", new Date());
        evt.set("delivery.lastError", undefined);
        await evt.save();
        applied ? delivered++ : skipped++;
      } catch (err: any) {
        const attempts = (evt.delivery?.attempts ?? 0) + 1;
        const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
        evt.set("delivery.attempts", attempts);
        evt.set("delivery.status", exhausted ? "failed" : "pending");
        evt.set("delivery.lastAttemptAt", new Date());
        evt.set("delivery.lastError", String(err?.message ?? err).slice(0, 500));
        evt.set(
          "delivery.nextRetryAt",
          exhausted ? undefined : new Date(Date.now() + nextRetryDelayMs(attempts)),
        );
        await evt.save();
        failed++;
      }
    }

    return { processed: pending.length, delivered, skipped, failed };
  },

  /** Resumen del embudo y de la salud de la base para la portada de Marketing. */
  async dashboard() {
    const now = Date.now();
    const monthAgo = new Date(now - 30 * 86_400_000);

    const [byLifecycle, bySource, newThisMonth, atRisk, totals, recentEvents] =
      await Promise.all([
        MktAccount.aggregate<{ _id: string; count: number }>([
          { $group: { _id: "$lifecycle", count: { $sum: 1 } } },
        ]),
        MktAccount.aggregate<{ _id: string; count: number }>([
          { $group: { _id: "$source", count: { $sum: 1 } } },
        ]),
        MktAccount.countDocuments({ createdAt: { $gte: monthAgo } }),
        // Mismo criterio que el segmento "Riesgo de churn": una cuenta sin
        // actividad registrada cuenta como en riesgo. Si acá se usara un `$gt`
        // pelado, el tablero diria 0 mientras el segmento muestra 11, y no hay
        // forma de que el numero de la portada contradiga a la lista.
        MktAccount.countDocuments({
          lifecycle: "customer",
          $or: [
            { "stats.daysInactive": { $gt: 30 } },
            { "stats.daysInactive": { $exists: false } },
          ],
        }),
        Promise.all([
          MktAccount.countDocuments(),
          MktContact.countDocuments(),
          MktEvent.countDocuments({ "delivery.status": "failed" }),
        ]),
        MktEvent.find().sort({ occurredAt: -1 }).limit(15).lean(),
      ]);

    const [accounts, contacts, failedEvents] = totals;
    const lifecycle = Object.fromEntries(byLifecycle.map((r) => [r._id, r.count]));

    // Conversion de lead a cliente sobre el total que alguna vez entro al embudo.
    const everInFunnel =
      (lifecycle.lead ?? 0) +
      (lifecycle.mql ?? 0) +
      (lifecycle.demo ?? 0) +
      (lifecycle.trial ?? 0) +
      (lifecycle.customer ?? 0) +
      (lifecycle.lost ?? 0) +
      (lifecycle.churned ?? 0);
    const customers = lifecycle.customer ?? 0;

    return {
      accounts,
      contacts,
      lifecycle,
      bySource: Object.fromEntries(bySource.map((r) => [r._id, r.count])),
      newThisMonth,
      atRisk,
      customers,
      conversionRate:
        everInFunnel > 0 ? Math.round((customers / everInFunnel) * 1000) / 10 : 0,
      failedEvents,
      recentEvents: recentEvents.map(sanitizeDoc),
    };
  },

  // -------------------------------------------------------------------------
  // Sincronizacion con el PMS
  // -------------------------------------------------------------------------

  /**
   * Trae las companies del PMS como cuentas-cliente. Idempotente: una company
   * ya representada se actualiza, no se duplica.
   *
   * Solo `status: "active"`: las suspendidas y borradas ensuciarian el pipeline
   * (ver D2 de la spec).
   */
  async backfillFromPms() {
    const CompanyModel = await getCompanyModel();
    const companies = await CompanyModel.find({ status: "active" }).lean();

    let created = 0;
    let updated = 0;

    for (const company of companies) {
      if (!company.companyId) continue;
      const existing = await MktAccount.findOne({ companyId: company.companyId });

      if (existing) {
        // El lifecycle no se pisa: si alguien lo movio a mano en el CRM, manda
        // esa decision y no el estado del PMS.
        existing.set("name", company.name ?? existing.name);
        if (company.email && !existing.website) existing.set("website", undefined);
        await existing.save();
        updated++;
        continue;
      }

      await MktAccount.create({
        accountId: makeId("acc"),
        companyId: company.companyId,
        name: company.name ?? company.companyId,
        lifecycle: "customer",
        source: "pms_backfill",
        stats: { plan: company.plan },
        lifecycleChangedAt: company.createdAt ?? new Date(),
      });
      created++;

      // El contacto del dueño, si la company trae email.
      if (company.email) {
        const email = String(company.email).toLowerCase().trim();
        const dup = await MktContact.findOne({ email }).lean();
        if (!dup) {
          const acc = await MktAccount.findOne({ companyId: company.companyId })
            .select({ accountId: 1 })
            .lean();
          if (acc) {
            await MktContact.create({
              contactId: makeId("cnt"),
              accountId: acc.accountId,
              email,
              isPrimary: true,
            });
          }
        }
      }
    }

    return { scanned: companies.length, created, updated };
  },

  /**
   * Recalcula `stats` de las cuentas con companyId. Lee properties del PMS y
   * consumo de `usage_daily_rollups` (que es la senal de actividad con datos
   * reales hoy; `analytics_events` todavia esta vacio del lado emisor).
   */
  async refreshStats() {
    const accounts = await MktAccount.find({
      companyId: { $type: "string" },
    });
    if (accounts.length === 0) return { refreshed: 0 };

    const companyIds = accounts.map((a) => a.companyId as string);
    const [PropertyModel, UnitModel] = await Promise.all([
      getPropertyModel(),
      getUnitModel(),
    ]);

    const [properties, units, usage] = await Promise.all([
      PropertyModel.find({ companyId: { $in: companyIds } })
        .select({ companyId: 1, status: 1 })
        .lean(),
      UnitModel.aggregate<{ _id: string; count: number }>([
        { $match: { companyId: { $in: companyIds }, status: { $ne: "deleted" } } },
        { $group: { _id: "$companyId", count: { $sum: 1 } } },
      ]),
      UsageDailyRollup.aggregate<{
        _id: string;
        totalTokens: number;
        lastDay: string;
      }>([
        { $match: { companyId: { $in: companyIds } } },
        {
          $group: {
            _id: "$companyId",
            totalTokens: { $sum: "$totalTokens" },
            lastDay: { $max: "$day" },
          },
        },
      ]),
    ]);

    const propsBy = new Map<string, number>();
    for (const p of properties) {
      if (p.status === "deleted") continue;
      propsBy.set(p.companyId, (propsBy.get(p.companyId) ?? 0) + 1);
    }

    const unitsBy = new Map(units.map((u) => [u._id, u.count]));
    const usageBy = new Map(usage.map((u) => [u._id, u]));
    const now = Date.now();
    let refreshed = 0;

    for (const acc of accounts) {
      const cid = acc.companyId as string;
      const u = usageBy.get(cid);

      // `day` es "YYYY-MM-DD" UTC; se ancla a mediodia para que el redondeo a
      // dias no cambie de valor segun la hora en que corra el cron.
      const lastActivityAt = u?.lastDay ? new Date(`${u.lastDay}T12:00:00Z`) : undefined;
      const daysInactive = lastActivityAt
        ? Math.max(0, Math.floor((now - lastActivityAt.getTime()) / 86_400_000))
        : undefined;

      acc.set("stats.propertiesCount", propsBy.get(cid) ?? 0);
      acc.set("stats.unitsCount", unitsBy.get(cid) ?? 0);
      acc.set("stats.iaCreditsUsed", u?.totalTokens ?? 0);
      acc.set("stats.lastActivityAt", lastActivityAt);
      acc.set("stats.daysInactive", daysInactive);
      acc.set("stats.refreshedAt", new Date());
      await acc.save();
      refreshed++;
    }

    return { refreshed };
  },
};

/**
 * Efecto de un evento sobre su cuenta. Devuelve `false` cuando el evento no
 * tiene cuenta que tocar (se marca `skipped`, no es un error).
 */
async function applyEvent(evt: {
  eventId: string;
  type: string;
  accountId?: string | null;
  companyId?: string | null;
  correlationId: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  let accountId = evt.accountId ?? undefined;

  if (!accountId && evt.companyId) {
    const acc = await MktAccount.findOne({ companyId: evt.companyId })
      .select({ accountId: 1 })
      .lean();
    accountId = acc?.accountId;
  }
  if (!accountId) return false;

  const account = await MktAccount.findOne({ accountId });
  if (!account) return false;

  // Solo avanza el embudo, nunca lo retrocede: un evento viejo que llega tarde
  // no puede devolver un cliente a "lead".
  const advanceTo = (next: AccountLifecycle) => {
    const order: AccountLifecycle[] = [
      "lead",
      "mql",
      "demo",
      "trial",
      "customer",
    ];
    const from = order.indexOf(account.lifecycle as AccountLifecycle);
    const to = order.indexOf(next);
    if (from === -1 || to === -1 || to <= from) return;
    account.set("lifecycle", next);
    account.set("lifecycleChangedAt", new Date());
  };

  switch (evt.type) {
    case "lead.qualified":
      advanceTo("mql");
      break;
    case "demo.requested":
      advanceTo("demo");
      break;
    case "trial.started":
      advanceTo("trial");
      break;
    case "account.converted":
    case "account.onboarded":
      advanceTo("customer");
      if (evt.companyId && !account.companyId) account.set("companyId", evt.companyId);
      break;
    case "account.churned":
      account.set("lifecycle", "churned");
      account.set("lifecycleChangedAt", new Date());
      break;
    case "account.app_activated": {
      const app = String(evt.payload?.appId ?? "").trim();
      if (app) {
        const tag = `app:${app}`;
        if (!account.tags.includes(tag)) account.tags.push(tag);
      }
      break;
    }
    default:
      break;
  }

  account.set("stats.lastActivityAt", new Date());
  await account.save();

  // Consumers externos (campañas). Si uno falla se propaga: el evento queda
  // pendiente y se reintenta con backoff, que es justo lo que se quiere para
  // que no se pierda un disparo de campaña por un error transitorio.
  for (const consumer of eventConsumers) {
    await consumer({
      eventId: evt.eventId,
      type: evt.type,
      accountId,
      companyId: evt.companyId,
      correlationId: evt.correlationId,
      payload: evt.payload,
    });
  }

  return true;
}
