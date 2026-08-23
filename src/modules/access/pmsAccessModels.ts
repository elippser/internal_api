import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../shared/pmsDb";

/**
 * Schemas read-only sobre la conexión secundaria del PMS (USERS-ACTIONS-SPEC §11).
 *
 * Mismo criterio que `hotels/pmsModels.ts`: declaramos sólo los campos que las
 * pantallas del internal muestran o filtran, con `strict: false` para que un
 * campo nuevo del PMS no se pierda al leer ni obligue a un deploy acá. El
 * módulo es 100 % lectura: nadie escribe estas colecciones desde internal.
 */

/** Tipos de evento que hoy emite el PMS. La UI cae al `type` crudo si aparece uno nuevo. */
export const ACCESS_EVENT_TYPES = [
  "account_created",
  "user_registered",
  "login_succeeded",
  "login_failed",
  "session_started",
  "logout",
  "password_changed",
  "password_reset_requested",
  "password_reset_completed",
  "company_switched",
  // Intento frenado por una regla de bloqueo (USERS-ACTIONS-SPEC §20).
  "access_blocked",
] as const;

export type AccessEventType = (typeof ACCESS_EVENT_TYPES)[number];

export const ACCESS_OUTCOMES = [
  "success",
  "failure",
  "denied",
  "timeout",
  "unavailable",
] as const;

export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

/**
 * Flags "de atención": los que hacen que un acceso o un usuario merezcan una
 * mirada. El PMS emite más flags (private_ip, clock_skew, client_ctx_*, …) que
 * son ruido operativo, no señal de riesgo, así que el filtro `hasFlags` y el
 * KPI `flagged` sólo cuentan estos.
 */
export const ATTENTION_FLAGS = [
  "new_country",
  "impossible_travel",
  "tz_mismatch",
  "hosting_asn",
  "automation",
] as const;

export interface PmsAccessEvent {
  eventId: string;
  type: string;
  outcome: string;
  at: Date;
  clientAt?: Date;
  clockSkewSec?: number;

  userId?: string | null;
  emailAttempted?: string | null;
  userSnapshot?: { name?: string; email?: string; role?: string } | null;
  companyId?: string | null;
  operativeSpaceId?: string | null;
  method?: string | null;

  deviceId?: string | null;
  clientSessionId?: string | null;
  telemetrySessionId?: string | null;
  requestId?: string;
  viaProxy?: boolean;
  ipTrusted?: boolean;

  ip?: string | null;
  ipVersion?: number;
  isPrivateIp?: boolean;
  asn?: { number?: number; org?: string; isHosting?: boolean } | null;

  geo?: {
    ip?: Record<string, unknown> | null;
    precise?: Record<string, unknown> | null;
    best?: {
      country?: string;
      region?: string;
      city?: string;
      lat?: number;
      lng?: number;
      source?: string;
      confidence?: string;
    } | null;
    edgeRaw?: Record<string, string>;
  } | null;

  device?: {
    raw?: Record<string, unknown> | null;
    ua?: Record<string, unknown>;
    summary?: {
      deviceType?: string;
      browser?: string;
      os?: string;
      platformLabel?: string;
      screen?: string;
      isTouch?: boolean;
      isPwa?: boolean;
      language?: string;
      timeZone?: string;
    };
    clientHints?: Record<string, string>;
    acceptLanguage?: string;
    fingerprintHash?: string;
  } | null;

  flags?: string[];
  detail?: Record<string, unknown>;
}

export interface PmsUserDevice {
  userId: string;
  deviceId: string;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  seenCount?: number;
  lastEventId?: string;
  summary?: Record<string, unknown>;
  fingerprintHash?: string;
  knownCities?: Array<{ country?: string; city?: string; count?: number; lastAt?: Date }>;
  knownIps?: Array<{ ip?: string; count?: number; lastAt?: Date }>;
  lastGeoBest?: Record<string, unknown>;
  trusted?: boolean;
  label?: string;
}

export interface PmsUser {
  userId: string;
  name?: string;
  email?: string;
  avatar?: string;
  role?: string;
  status?: string;
  memberships?: Array<{ companyId?: string; role?: string; status?: string }>;
  activeCompanyId?: string;
  companyId?: string;
  activeCompany?: string;
  lastLoginAt?: Date;
  lastAccessAt?: Date;
  lastAccessGeo?: { country?: string; city?: string };
  lastDeviceId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// `geo` y `device` van como Mixed: son sub-documentos profundos y variables
// (el PMS guarda ahí lo que declaró el navegador). Declararlos campo por campo
// sólo agregaría una forma que tendríamos que mantener en dos repos.
const accessEventSchema = new Schema(
  {
    eventId: String,
    type: String,
    outcome: String,
    at: Date,
    clientAt: Date,
    clockSkewSec: Number,

    userId: String,
    emailAttempted: String,
    userSnapshot: Schema.Types.Mixed,
    companyId: String,
    operativeSpaceId: String,
    method: String,

    deviceId: String,
    clientSessionId: String,
    telemetrySessionId: String,
    requestId: String,
    viaProxy: Boolean,
    ipTrusted: Boolean,

    ip: String,
    ipVersion: Number,
    isPrivateIp: Boolean,
    asn: Schema.Types.Mixed,

    geo: Schema.Types.Mixed,
    device: Schema.Types.Mixed,

    flags: [String],
    detail: Schema.Types.Mixed,
  },
  { strict: false, collection: "user_access_events" },
);

const userDeviceSchema = new Schema(
  {
    userId: String,
    deviceId: String,
    firstSeenAt: Date,
    lastSeenAt: Date,
    seenCount: Number,
    lastEventId: String,
    summary: Schema.Types.Mixed,
    fingerprintHash: String,
    knownCities: Schema.Types.Mixed,
    knownIps: Schema.Types.Mixed,
    lastGeoBest: Schema.Types.Mixed,
    trusted: Boolean,
    label: String,
  },
  { strict: false, collection: "user_devices" },
);

// `password` NO se declara a propósito, pero con `strict: false` igual vendría
// en un `.lean()`: todas las queries de este módulo proyectan explícitamente
// (`-password`) para que el hash no salga nunca del PMS.
const userSchema = new Schema(
  {
    userId: String,
    name: String,
    email: String,
    avatar: String,
    role: String,
    status: String,
    memberships: Schema.Types.Mixed,
    activeCompanyId: String,
    companyId: String,
    activeCompany: String,
    lastLoginAt: Date,
    lastAccessAt: Date,
    lastAccessGeo: Schema.Types.Mixed,
    lastDeviceId: String,
    createdAt: Date,
    updatedAt: Date,
  },
  { strict: false, collection: "users" },
);

let accessEventModel: Model<PmsAccessEvent> | null = null;
let userDeviceModel: Model<PmsUserDevice> | null = null;
let pmsUserModel: Model<PmsUser> | null = null;

export async function getAccessEventModel(): Promise<Model<PmsAccessEvent>> {
  if (accessEventModel) return accessEventModel;
  const conn = await getPmsConnection();
  accessEventModel = conn.model<PmsAccessEvent>("PmsAccessEvent", accessEventSchema);
  return accessEventModel;
}

export async function getUserDeviceModel(): Promise<Model<PmsUserDevice>> {
  if (userDeviceModel) return userDeviceModel;
  const conn = await getPmsConnection();
  userDeviceModel = conn.model<PmsUserDevice>("PmsUserDevice", userDeviceSchema);
  return userDeviceModel;
}

export async function getPmsUserModel(): Promise<Model<PmsUser>> {
  if (pmsUserModel) return pmsUserModel;
  const conn = await getPmsConnection();
  pmsUserModel = conn.model<PmsUser>("PmsUser", userSchema);
  return pmsUserModel;
}
