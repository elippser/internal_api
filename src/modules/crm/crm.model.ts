import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * CRM B2B de bookfer: los "contactos" son hoteles prospecto y clientes, no
 * huespedes. Ver `internal-laupser/MKT-HUB-SPEC.md`.
 *
 * No hay multi-tenancy: bookfer es el unico tenant. `companyId` aparece como
 * REFERENCIA a la company del PMS cuando la cuenta ya convirtio, no como
 * discriminador de aislamiento.
 */

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

export const ACCOUNT_LIFECYCLES = [
  "lead",
  "mql",
  "demo",
  "trial",
  "customer",
  "churned",
  "lost",
] as const;
export type AccountLifecycle = (typeof ACCOUNT_LIFECYCLES)[number];

export const ACCOUNT_SOURCES = [
  "website",
  "referral",
  "outbound",
  "ads",
  "event",
  "import",
  "pms_backfill",
  "other",
] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export const ACCOUNT_SIZES = ["1-10", "11-50", "51-200", "200+"] as const;

// Metricas de adopcion. Las recalcula el cron desde el Mongo del PMS y desde
// usage_daily_rollups; nunca se computan por request.
const statsSchema = new Schema(
  {
    propertiesCount: { type: Number, default: 0 },
    unitsCount: { type: Number, default: 0 },
    reservationsProcessed: { type: Number, default: 0 },
    iaCreditsUsed: { type: Number, default: 0 },
    lastActivityAt: { type: Date, required: false },
    daysInactive: { type: Number, required: false },
    plan: { type: String, required: false },
    mrr: { type: Number, required: false },
    refreshedAt: { type: Date, required: false },
  },
  { _id: false },
);

const optInSchema = new Schema(
  {
    email: { type: Boolean, default: false },
    whatsapp: { type: Boolean, default: false },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const accountSchema = new Schema(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    website: { type: String, required: false },
    /** Dominio normalizado del website. Clave de dedupe cuando no hay companyId. */
    websiteDomain: { type: String, required: false, index: true },
    country: { type: String, required: false },
    city: { type: String, required: false },
    size: { type: String, enum: ACCOUNT_SIZES, required: false },

    lifecycle: {
      type: String,
      enum: ACCOUNT_LIFECYCLES,
      default: "lead",
      index: true,
    },
    source: { type: String, enum: ACCOUNT_SOURCES, default: "other", index: true },
    ownerUserId: { type: String, required: false, index: true },

    /** Puente con el PMS. Se puebla al convertir o en el backfill.
     *  El indice se declara abajo (unico y parcial); no va `index: true` acá
     *  o mongoose crea dos indices sobre el mismo campo. */
    companyId: { type: String, required: false },

    stats: { type: statsSchema, default: () => ({}) },
    tags: { type: [String], default: [], index: true },
    optIn: { type: optInSchema, default: () => ({}) },
    notes: { type: String, default: "" },

    lifecycleChangedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: "mkt_accounts" },
);

// Una company del PMS no puede estar en dos cuentas.
accountSchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { companyId: { $type: "string" } } },
);
accountSchema.index({ lifecycle: 1, updatedAt: -1 });
accountSchema.index({ "stats.daysInactive": -1 });

export type MktAccountDoc = InferSchemaType<typeof accountSchema>;
export const MktAccount = model("MktAccount", accountSchema);

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------

const contactSchema = new Schema(
  {
    contactId: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, required: false },
    firstName: { type: String, required: false },
    lastName: { type: String, required: false },
    role: { type: String, required: false },
    isPrimary: { type: Boolean, default: false },
    optIn: { type: optInSchema, default: () => ({}) },
    unsubscribedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_contacts" },
);

contactSchema.index({ accountId: 1, isPrimary: -1 });

export type MktContactDoc = InferSchemaType<typeof contactSchema>;
export const MktContact = model("MktContact", contactSchema);

// ---------------------------------------------------------------------------
// Eventos + outbox
// ---------------------------------------------------------------------------

export const MKT_EVENT_TYPES = [
  "lead.captured",
  "lead.qualified",
  "demo.requested",
  "trial.started",
  "account.converted",
  "account.onboarded",
  "account.app_activated",
  "account.inactive",
  "account.churned",
  "nps.submitted",
] as const;
export type MktEventType = (typeof MKT_EVENT_TYPES)[number];

export const DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "skipped",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// El outbox vive embebido en el evento y no en una coleccion aparte: un evento
// tiene exactamente un consumer interno (el que actualiza stats y dispara
// campanas), asi que no hace falta el fan-out de una tabla de entregas.
const deliverySchema = new Schema(
  {
    status: { type: String, enum: DELIVERY_STATUSES, default: "pending" },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, required: false },
    lastError: { type: String, required: false },
    nextRetryAt: { type: Date, required: false },
  },
  { _id: false },
);

const eventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: MKT_EVENT_TYPES, required: true, index: true },
    accountId: { type: String, required: false, index: true },
    companyId: { type: String, required: false, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    /**
     * Idempotencia de ingesta: el emisor manda su propio id estable. Dos POST
     * con el mismo correlationId son el mismo evento, no dos.
     */
    correlationId: { type: String, required: true, unique: true, index: true },
    source: { type: String, default: "internal" },
    occurredAt: { type: Date, default: () => new Date(), index: true },
    delivery: { type: deliverySchema, default: () => ({}) },
  },
  { timestamps: true, collection: "mkt_events" },
);

eventSchema.index({ type: 1, occurredAt: -1 });
// El drenado del outbox: pendientes cuya proxima reintento ya vencio.
eventSchema.index({ "delivery.status": 1, "delivery.nextRetryAt": 1 });

export type MktEventDoc = InferSchemaType<typeof eventSchema>;
export const MktEvent = model("MktEvent", eventSchema);

// ---------------------------------------------------------------------------

export function sanitizeDoc<T>(doc: T): T {
  if (!doc) return doc;
  const obj = doc && typeof doc === "object" && "toObject" in (doc as object)
    ? (doc as unknown as { toObject: () => Record<string, unknown> }).toObject()
    : (doc as unknown as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}

/** Dominio normalizado, para dedupe de cuentas sin companyId. */
export function domainOf(website?: string | null): string | undefined {
  if (!website) return undefined;
  const raw = website.trim().toLowerCase();
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}
