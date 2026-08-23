import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../shared/pmsDb";
import { getRmsConnection } from "../../shared/rmsDb";

/**
 * Modelos de LECTURA sobre las bases de las otras apps, para consolidar
 * métricas sin pedirle un endpoint nuevo a cada servicio.
 *
 * Todos `strict:false` y sólo con los campos que las métricas usan: si el
 * modelo de origen evoluciona, esto no se rompe (mongoose ignora lo que no
 * declaramos al hacer `.lean()`).
 *
 * Dos bases distintas:
 *  - pmsDb (`elippser-sites_tests`): la comparten pms-core, booking-app y
 *    staypass, así que reservas, huéspedes, sitios y espacios salen todos de
 *    la misma conexión y SÍ se pueden cruzar entre sí.
 *  - rmsDb (`laupser_rms`): sólo el RMS. NO cruza con la anterior.
 *
 * Ver METRICAS-COMPORTAMIENTO-SPEC.md §3.1 y §10.3.
 */

const lean = { strict: false as const };

// ── Base del PMS ──────────────────────────────────────────────────────────

export interface PmsReservation {
  reservationId: string;
  propertyId: string;
  guestId?: string;
  status: string;
  channel?: string;
  sourceChannelId?: string;
  /** F0: superficie que creó la reserva. Discriminante de la métrica del piloto. */
  origin?: "engine" | "staff" | "agent";
  engineSessionId?: string;
  nights?: number;
  totalAmount?: number;
  currency?: string;
  createdAt?: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
  checkedInAt?: Date;
  checkedOutAt?: Date;
  noShowAt?: Date;
}

const reservationSchema = new Schema(
  {
    reservationId: String,
    propertyId: String,
    guestId: String,
    status: String,
    channel: String,
    sourceChannelId: String,
    origin: String,
    engineSessionId: String,
    nights: Number,
    totalAmount: Number,
    currency: String,
    createdAt: Date,
    confirmedAt: Date,
    cancelledAt: Date,
    checkedInAt: Date,
    checkedOutAt: Date,
    noShowAt: Date,
  },
  { ...lean, collection: "reservations" },
);

export interface PmsSearchEvent {
  propertyId: string;
  hadAvailability?: boolean;
  source?: string;
  sessionId?: string;
  createdAt?: Date;
}

const searchEventSchema = new Schema(
  {
    propertyId: String,
    hadAvailability: Boolean,
    source: String,
    sessionId: String,
    createdAt: Date,
  },
  { ...lean, collection: "searchevents" },
);

export interface PmsLinkhubEvent {
  linkhubId: string;
  propertyId: string;
  companyId: string;
  type: "view" | "click";
  kind?: string | null;
  source?: string | null;
  visitorId?: string;
  day: string;
}

const linkhubEventSchema = new Schema(
  {
    linkhubId: String,
    propertyId: String,
    companyId: String,
    type: String,
    kind: String,
    source: String,
    visitorId: String,
    day: String,
  },
  { ...lean, collection: "linkhubevents" },
);

export interface PmsSiteEvent {
  subSiteId: string;
  propertyId?: string;
  companyId: string;
  type: "view" | "click";
  kind?: string | null;
  visitorId?: string;
  day: string;
}

const siteEventSchema = new Schema(
  {
    subSiteId: String,
    propertyId: String,
    companyId: String,
    type: String,
    kind: String,
    visitorId: String,
    day: String,
  },
  { ...lean, collection: "siteevents" },
);

export interface PmsGuest {
  guestId: string;
  originCompanyIds?: string[];
  /** F0: entries fechados por compañía. `method:"backfill"` = fecha aproximada. */
  originLog?: Array<{
    companyId: string;
    propertyId?: string;
    method?: string;
    at?: Date;
  }>;
  auth0Sub?: string;
  emailVerified?: boolean;
  status?: string;
  lastLoginAt?: Date;
  createdAt?: Date;
}

const guestSchema = new Schema(
  {
    guestId: String,
    originCompanyIds: [String],
    originLog: [
      {
        _id: false,
        companyId: String,
        propertyId: String,
        method: String,
        at: Date,
      },
    ],
    auth0Sub: String,
    emailVerified: Boolean,
    status: String,
    lastLoginAt: Date,
    createdAt: Date,
  },
  { ...lean, collection: "guests" },
);

export interface PmsSite {
  _id: unknown;
  companyId: string;
  sitesByLanguage?: Array<{
    _id?: unknown;
    propertyId?: string;
    language?: string;
    status?: string;
    publishedAt?: Date;
    domain?: string;
    customHostnames?: unknown[];
  }>;
}

const siteSchema = new Schema(
  { companyId: String, sitesByLanguage: [Schema.Types.Mixed] },
  { ...lean, collection: "sites" },
);

export interface PmsOperativeSpace {
  operativeSpaceId: string;
  propertyId: string;
  companyId: string;
  isAdminSpace?: boolean;
  status?: string;
  integrationsAppsOS?: Array<{
    appId: string;
    enabled?: boolean;
    enabledAt?: Date;
  }>;
}

const operativeSpaceSchema = new Schema(
  {
    operativeSpaceId: String,
    propertyId: String,
    companyId: String,
    isAdminSpace: Boolean,
    status: String,
    integrationsAppsOS: [Schema.Types.Mixed],
  },
  { ...lean, collection: "operativespaces" },
);

export interface PmsInductionProgress {
  userId: string;
  companyId: string;
  propertyId: string;
  operativeSpaceId: string;
  status?: string;
  completedAt?: Date;
  hubs?: unknown[];
}

const inductionSchema = new Schema(
  {
    userId: String,
    companyId: String,
    propertyId: String,
    operativeSpaceId: String,
    status: String,
    completedAt: Date,
    hubs: [Schema.Types.Mixed],
  },
  { ...lean, collection: "inductionprogresses" },
);

export interface PmsReview {
  propertyId: string;
  companyId: string;
  rating?: number;
  responded?: boolean;
  isActive?: boolean;
  createdAt?: Date;
}

const reviewSchema = new Schema(
  {
    propertyId: String,
    companyId: String,
    rating: Number,
    responded: Boolean,
    isActive: Boolean,
    createdAt: Date,
  },
  { ...lean, collection: "reviews" },
);

// ── Base del RMS ──────────────────────────────────────────────────────────

export interface RmsDailyFact {
  propertyId: string;
  /** "YYYY-MM-DD". Ojo: se materializan días futuros vacíos, filtrar <= hoy. */
  date: string;
  revenue_total_usd?: number;
  revenue_direct_usd?: number;
  revenue_ota_usd?: number;
  occupancy_pct?: number;
  adr_usd?: number;
  revpar_usd?: number;
  reservations?: number;
  cancellations?: number;
  searches_total?: number;
  searches_no_availability?: number;
}

const rmsFactSchema = new Schema(
  {
    propertyId: String,
    date: String,
    revenue_total_usd: Number,
    revenue_direct_usd: Number,
    revenue_ota_usd: Number,
    occupancy_pct: Number,
    adr_usd: Number,
    revpar_usd: Number,
    reservations: Number,
    cancellations: Number,
    searches_total: Number,
    searches_no_availability: Number,
  },
  { ...lean, collection: "rms_daily_facts" },
);

export interface RmsRecommendation {
  propertyId: string;
  companyId?: string;
  /**
   * OJO con la semántica: `applied` es el éxito (el humano aceptó Y el push
   * funcionó); `accepted` significa que el push FALLÓ; `superseded` lo pisa
   * cada corrida diaria del motor y domina el volumen.
   */
  status: string;
  resolvedByUserId?: string;
  resolvedAt?: Date;
  createdAt?: Date;
}

const rmsRecommendationSchema = new Schema(
  {
    propertyId: String,
    companyId: String,
    status: String,
    resolvedByUserId: String,
    resolvedAt: Date,
    createdAt: Date,
  },
  { ...lean, collection: "rms_recommendations" },
);

export interface RmsRule {
  propertyId: string;
  companyId?: string;
  isActive?: boolean;
}

const rmsRuleSchema = new Schema(
  { propertyId: String, companyId: String, isActive: Boolean },
  { ...lean, collection: "rms_rules" },
);

export interface RmsPropertyConfig {
  propertyId: string;
  companyId?: string;
  isActive?: boolean;
  autoApply?: boolean;
  minRateUsd?: number;
  competitors?: unknown[];
  createdAt?: Date;
  updatedAt?: Date;
}

const rmsConfigSchema = new Schema(
  {
    propertyId: String,
    companyId: String,
    isActive: Boolean,
    autoApply: Boolean,
    minRateUsd: Number,
    competitors: [Schema.Types.Mixed],
    createdAt: Date,
    updatedAt: Date,
  },
  { ...lean, collection: "rms_property_config" },
);

// ── Registro perezoso de modelos ──────────────────────────────────────────
// Se cachean por nombre: mongoose lanza si se registra dos veces el mismo
// modelo sobre la misma conexión.

const cache = new Map<string, Model<unknown>>();

async function pmsModel<T>(name: string, schema: Schema): Promise<Model<T>> {
  const hit = cache.get(name);
  if (hit) return hit as unknown as Model<T>;
  const conn = await getPmsConnection();
  const model = conn.model(name, schema) as unknown as Model<unknown>;
  cache.set(name, model);
  return model as unknown as Model<T>;
}

async function rmsModel<T>(name: string, schema: Schema): Promise<Model<T>> {
  const hit = cache.get(name);
  if (hit) return hit as unknown as Model<T>;
  const conn = await getRmsConnection();
  const model = conn.model(name, schema) as unknown as Model<unknown>;
  cache.set(name, model);
  return model as unknown as Model<T>;
}

export const getReservationModel = () =>
  pmsModel<PmsReservation>("MxReservation", reservationSchema);
export const getSearchEventModel = () =>
  pmsModel<PmsSearchEvent>("MxSearchEvent", searchEventSchema);
export const getLinkhubEventModel = () =>
  pmsModel<PmsLinkhubEvent>("MxLinkhubEvent", linkhubEventSchema);
export const getSiteEventModel = () =>
  pmsModel<PmsSiteEvent>("MxSiteEvent", siteEventSchema);
export const getGuestModel = () => pmsModel<PmsGuest>("MxGuest", guestSchema);
export const getSiteModel = () => pmsModel<PmsSite>("MxSite", siteSchema);
export const getOperativeSpaceModel = () =>
  pmsModel<PmsOperativeSpace>("MxOperativeSpace", operativeSpaceSchema);
export const getInductionModel = () =>
  pmsModel<PmsInductionProgress>("MxInduction", inductionSchema);
export const getReviewModel = () => pmsModel<PmsReview>("MxReview", reviewSchema);

export const getRmsFactModel = () =>
  rmsModel<RmsDailyFact>("MxRmsFact", rmsFactSchema);
export const getRmsRecommendationModel = () =>
  rmsModel<RmsRecommendation>("MxRmsRecommendation", rmsRecommendationSchema);
export const getRmsRuleModel = () => rmsModel<RmsRule>("MxRmsRule", rmsRuleSchema);
export const getRmsConfigModel = () =>
  rmsModel<RmsPropertyConfig>("MxRmsConfig", rmsConfigSchema);
