import { Schema, model } from "mongoose";

/**
 * Inteligencia competitiva de bookfer (COMPETITIVE-INTEL-SPEC.md + -V2.md).
 * Tier 1 = battle set curado (`ci_competitors`); Tier 2 = radar
 * (`ci_radar_items`). v2 agrega procedencia por campo (`meta`), pricing
 * estructurado, taxonomia, perfiles sociales, paginas vigiladas, senales y
 * sugerencias. Enums en ingles; labels en espanol viven en el front.
 */

// ---------------------------------------------------------------------------
// Catalogos v1
// ---------------------------------------------------------------------------

export const COMPETITOR_SEGMENTS = ["global", "latam", "generic_lodging"] as const;
export type CompetitorSegment = (typeof COMPETITOR_SEGMENTS)[number];

export const COMPETITOR_PRIORITIES = ["A", "B", "C"] as const;
export type CompetitorPriority = (typeof COMPETITOR_PRIORITIES)[number];

export const COMPETITOR_STATUSES = ["active", "archived"] as const;

/**
 * Etapa en una UNICA lista de competidores (v2.2). Antes habia dos colecciones
 * —el battle set curado y la cola del radar— y entender cual era cual costaba
 * mas de lo que valia la separacion.
 *   detected  = lo trajo el radar, nadie lo miro todavia
 *   tracked   = se le sigue el rastro (lo que antes era "el battle set")
 *   discarded = ruido o descartado a mano
 */
export const COMPETITOR_STAGES = ["detected", "tracked", "discarded"] as const;
export type CompetitorStage = (typeof COMPETITOR_STAGES)[number];
export type CompetitorStatus = (typeof COMPETITOR_STATUSES)[number];

export const PRICING_UNITS = [
  "per_room",
  "per_property",
  "flat",
  "commission",
  "freemium",
  "unknown",
] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/** v1: yes|no|unknown. v2 (FEATURE_HAS) distingue nativo / add-on / integracion. */
export const FEATURE_COVERAGE = ["yes", "no", "unknown"] as const;
export type FeatureCoverage = (typeof FEATURE_COVERAGE)[number];

export const OUR_COVERAGE = ["yes", "partial", "no", "roadmap"] as const;
export type OurCoverage = (typeof OUR_COVERAGE)[number];

export const EVIDENCE_KINDS = [
  "review_g2",
  "review_capterra",
  "review_other",
  "forum",
  "prospect",
  "web",
  "radar",
  "other",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const PROMOTION_REASONS = ["prospect_mention", "traction", "same_segment"] as const;
export type PromotionReason = (typeof PROMOTION_REASONS)[number];

// Catalogo cerrado de features para la matriz (agregable en insights).
export const FEATURE_CATALOG = [
  { key: "booking_engine", label: "Motor de reservas" },
  { key: "channel_manager", label: "Channel manager" },
  { key: "payments", label: "Pasarela de pagos" },
  { key: "website_builder", label: "Sitio web / builder" },
  { key: "linkhub", label: "Link in bio / LinkHub" },
  { key: "whatsapp", label: "Mensajería WhatsApp" },
  { key: "ai_assistant", label: "Asistente IA" },
  { key: "revenue_management", label: "RMS / pricing dinámico" },
  { key: "housekeeping", label: "Housekeeping" },
  { key: "pos", label: "POS / cargos" },
  { key: "invoicing", label: "Facturación electrónica" },
  { key: "reports", label: "Reportes / BI" },
  { key: "multi_property", label: "Multi-propiedad" },
  { key: "ota_integrations", label: "Integraciones OTA" },
  { key: "mobile_app", label: "App móvil staff" },
  { key: "guest_app", label: "Portal / app de huésped" },
  { key: "crm_guests", label: "CRM de huéspedes" },
  { key: "reviews_management", label: "Reputación / reseñas" },
  { key: "door_locks", label: "Cerraduras / IoT" },
  { key: "accounting_integration", label: "Integración contable" },
] as const;
export const FEATURE_KEYS: string[] = FEATURE_CATALOG.map((f) => f.key);

// Temas de debilidad (cerrado + other): es lo que hace agregable positioning.
export const WEAKNESS_THEMES = [
  "price",
  "complexity",
  "support",
  "onboarding",
  "no_booking_engine",
  "no_website",
  "no_ai",
  "no_whatsapp",
  "no_channel_manager",
  "no_payments",
  "latam_fit",
  "performance",
  "lock_in",
  "outdated_ux",
  "other",
] as const;
export type WeaknessTheme = (typeof WEAKNESS_THEMES)[number];

export const AI_DRAFT_STATUSES = ["running", "ready", "applied", "discarded", "error"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

// v2 suma taxonomy / socialProfiles / watchedPages / weaknesses.
export const AI_DRAFT_APPLY_FIELDS = [
  "pricing",
  "keyFeatures",
  "featureMatrix",
  "statedPositioning",
  "segment",
  "weaknessThemes",
  "weaknesses",
  "evidence",
  "taxonomy",
  "socialProfiles",
  "watchedPages",
  "products",
] as const;

export const REVISION_SOURCES = [
  "manual",
  "ai_draft",
  "radar_promote",
  "review_only",
  "suggestion",
  "migration",
] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

export const RADAR_KINDS = ["new_entrant", "tracked_change", "signal", "mention"] as const;
export type RadarKind = (typeof RADAR_KINDS)[number];
export const RADAR_STATUSES = ["pending", "discarded", "promoted", "acknowledged"] as const;
export type RadarStatus = (typeof RADAR_STATUSES)[number];
export const RADAR_CLASSIFICATIONS = ["new_competitor", "noise", "already_tracked"] as const;
export type RadarClassification = (typeof RADAR_CLASSIFICATIONS)[number];
export const RADAR_SOURCES = ["web_search", "manual", "rss", "directory", "signal", "mention_detector"] as const;
export type RadarSource = (typeof RADAR_SOURCES)[number];
export const RADAR_RUN_MODES = ["search", "changes", "both", "signals", "mentions"] as const;
export type RadarRunMode = (typeof RADAR_RUN_MODES)[number];
export const RADAR_RUN_STATUSES = ["running", "ok", "partial", "error"] as const;
export const SNAPSHOT_PAGES = ["home", "pricing", "features", "blog", "changelog", "careers", "custom"] as const;
export type SnapshotPage = (typeof SNAPSHOT_PAGES)[number];
export const DECISION_TYPES = ["pricing", "positioning", "roadmap"] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PRUNE_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Catalogos v2
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 2;

export const PRODUCT_TYPES = [
  "pms",
  "booking_engine",
  "channel_manager",
  "website_builder",
  "revenue",
  "guest_messaging",
  "payments",
  "suite",
  "other",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const TARGET_SIZES = ["micro", "small", "mid", "large"] as const; // 1-10 · 11-50 · 51-150 · 150+/cadenas
export type TargetSize = (typeof TARGET_SIZES)[number];

export const GEO_REGIONS = ["latam", "global", "europe", "north_america", "asia", "africa"] as const;

export const PRICING_VISIBILITY = ["public", "partial", "quote_only", "freemium", "unknown"] as const;
export type PricingVisibility = (typeof PRICING_VISIBILITY)[number];

/** v2: grado de cobertura de una feature. "yes" (v1) migra a "native". */
export const FEATURE_HAS = ["native", "addon", "integration", "no", "unknown"] as const;
export type FeatureHas = (typeof FEATURE_HAS)[number];
/** Lo que acepta la API (compat v1). */
export const FEATURE_HAS_INPUT = [...FEATURE_HAS, "yes"] as const;

export const FIELD_SOURCES = ["manual", "ai_draft", "signal", "suggestion", "legacy", "radar"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export const MENTION_CONTEXTS = ["demo", "call", "whatsapp", "email", "event", "web_form", "other"] as const;
export type MentionContext = (typeof MENTION_CONTEXTS)[number];

export const SOCIAL_NETWORKS = [
  "instagram",
  "linkedin",
  "x",
  "facebook",
  "tiktok",
  "youtube",
  "producthunt",
  "g2",
  "capterra",
  "getapp",
  "app_store",
  "google_play",
  "blog",
  "changelog",
  "reddit",
  "other",
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const PROFILE_STATUSES = ["candidate", "confirmed", "unavailable", "ignored"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export const PROFILE_DISCOVERED_BY = ["ai_draft", "signal", "manual"] as const;

export const WATCHED_PAGE_KINDS = ["home", "pricing", "features", "blog", "changelog", "careers", "custom"] as const;
export type WatchedPageKind = (typeof WATCHED_PAGE_KINDS)[number];
export const WATCHED_PAGE_CADENCES = ["weekly", "monthly"] as const;
export const WATCHED_PAGE_STATUSES = ["active", "paused", "unavailable"] as const;

export const SIGNAL_CONNECTORS = [
  /**
   * No es un connector: es el origen de las series que escribe la curaduría
   * humana (hoy `priceMonthlyUsd`, cuando cambia el precio normalizado). Queda
   * fuera del registro, así que no aparece en el panel de salud ni en las
   * corridas.
   */
  "manual",
  "rss",
  "watched_pages",
  "app_store",
  "google_play",
  "reddit",
  "search_snippets",
  "youtube",
  "producthunt",
  "trends",
  "news",
] as const;
export type SignalConnectorId = (typeof SIGNAL_CONNECTORS)[number];

export const SIGNAL_EVENT_KINDS = [
  "launch",
  "feature_announce",
  "pricing_change",
  "page_change",
  "follower_jump",
  "activity_spike",
  "rating_drop",
  "app_release",
  "hiring_spike",
  "funding",
  "press",
  "ph_launch",
  "social_profile_found",
  // v2.1: campaña detectada (landing con UTM, promo, cupón, anuncio observado).
  "campaign",
  "other",
] as const;
export type SignalEventKind = (typeof SIGNAL_EVENT_KINDS)[number];
export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SIGNAL_EVENT_STATUSES = ["new", "seen", "archived"] as const;

export const SUGGESTION_SOURCES = ["signal", "ai_draft", "mention_detector", "priority_engine"] as const;
export const SUGGESTION_STATUSES = ["pending", "applied", "rejected", "superseded"] as const;

export const CADENCES = ["weekly", "biweekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

// ---------------------------------------------------------------------------
// Catalogos v2.1 (productos, anuncios, contenido)
// ---------------------------------------------------------------------------

/** Estado de un producto del competidor: lo que se puede comprar HOY vs lo anunciado. */
export const PRODUCT_STATUSES = ["live", "beta", "announced", "discontinued"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Redes de anuncios. El rastreo automatico NO existe por vias legitimas
 * (Meta responde 403 con challenge de JS a su biblioteca publica y su API
 * oficial solo cubre anuncios politicos; Google Transparency es un RPC interno
 * sin documentar). Se registran a mano desde la biblioteca publica, a la que
 * se entra con un click desde la ficha (`adLibraryLinks`).
 */
export const AD_NETWORKS = ["meta", "google", "linkedin", "tiktok", "other"] as const;
export type AdNetwork = (typeof AD_NETWORKS)[number];
export const AD_STATUSES = ["active", "paused", "unknown"] as const;

/** Tipo de publicacion en el feed unificado de contenido. */
export const CONTENT_KINDS = ["post", "video", "release", "case_study", "campaign", "other"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Tipos planos (lo que manejan los services y devuelve la API)
// ---------------------------------------------------------------------------

export interface LlmUsageRecord {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
  latencyMs: number;
}

export interface PricingPlan {
  planId: string;
  name: string;
  priceMonthly: number | null;
  priceAnnualMonthly: number | null;
  currency: string;
  unit: PricingUnit;
  minRooms: number | null;
  maxRooms: number | null;
  includesRooms: number | null;
  includes: string[];
  notes: string;
  sourceUrl: string;
  observedAt: Date | null;
}

export interface PricingNormalized {
  minMonthlyUsd: number | null;
  maxMonthlyUsd: number | null;
  basisRooms: number;
  fxNote: string;
  computedAt: Date;
}

export interface CompetitorPricing {
  model: string;
  range: string;
  unit: PricingUnit;
  minMonthlyUsd: number | null;
  maxMonthlyUsd: number | null;
  currency: string;
  pricingUrl: string;
  screenshotUrl: string;
  visibility: PricingVisibility;
  plans: PricingPlan[];
  normalized: PricingNormalized | null;
}

export interface FeatureMatrixItem {
  key: string;
  has: FeatureHas;
  note?: string;
  evidenceUrl?: string;
  verifiedAt?: Date | null;
  source?: FieldSource;
}

export interface EvidenceItem {
  evidenceId: string;
  kind: EvidenceKind;
  url: string;
  note: string;
  addedAt: Date;
  addedByUserId: string | null;
}

export interface MentionItem {
  mentionId: string;
  at: Date;
  note: string;
  context: MentionContext;
  source: "manual" | "auto";
  confidence: Confidence;
  accountId: string | null;
  conversationId: string | null;
  sourceRef: { kind: string; id: string; excerpt: string } | null;
  addedByUserId: string | null;
}

export interface WeaknessItem {
  weaknessId: string;
  theme: WeaknessTheme;
  note: string;
  evidenceUrl: string;
  source: FieldSource;
  addedAt: Date;
  addedByUserId: string | null;
}

export interface SocialProfile {
  profileId: string;
  network: SocialNetwork;
  handle: string;
  url: string;
  externalId: string;
  discoveredBy: "ai_draft" | "signal" | "manual";
  status: ProfileStatus;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
  latest: Record<string, unknown>;
}

export interface WatchedPage {
  pageId: string;
  kind: WatchedPageKind;
  url: string;
  feedUrl: string | null;
  cadence: "weekly" | "monthly";
  status: "active" | "paused" | "unavailable";
  lastHash: string | null;
  lastCheckedAt: Date | null;
  lastChangedAt: Date | null;
}

export interface FieldMeta {
  source: FieldSource;
  confidence: Confidence;
  sourceUrl: string;
  quote: string;
  observedAt: Date;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
}

export interface CompetitorQuality {
  score: number;
  completeness: number;
  verified: number;
  freshness: number;
  evidence: number;
  missing: string[];
  computedAt: Date;
}

export interface PrioritySuggested {
  value: CompetitorPriority;
  score: number;
  reasons: string[];
  computedAt: Date;
}

export interface AiDraftFields {
  pricing?: Partial<CompetitorPricing> & { plans?: Partial<PricingPlan>[] };
  keyFeatures?: string[];
  featureMatrix?: FeatureMatrixItem[];
  statedPositioning?: string | null;
  segmentGuess?: CompetitorSegment | null;
  weaknessThemesGuess?: WeaknessTheme[];
  weaknesses?: { theme: WeaknessTheme; note: string; evidenceUrl: string }[];
  evidence?: { kind: EvidenceKind; url: string; note: string }[];
  weaknessHints?: { text: string; sourceUrl: string }[];
  tractionSignals?: string[];
  taxonomy?: { productTypes?: ProductType[]; targetSizes?: TargetSize[]; geoFocus?: string[] };
  socialProfiles?: Partial<SocialProfile>[];
  watchedPages?: Partial<WatchedPage>[];
  products?: { name: string; category: ProductType; description: string; url: string; pricingNote: string; status: ProductStatus; isCore: boolean }[];
  quotes?: Record<string, { quote: string; sourceUrl: string }>;
  notes?: string;
}

export interface AiDraft {
  status: AiDraftStatus;
  requestedAt: Date;
  finishedAt: Date | null;
  requestedByUserId: string | null;
  errorMessage: string | null;
  includeEvidence: boolean;
  model: string;
  evidenceModel: string | null;
  sources: { kind: "home" | "pricing" | "web_search"; url: string; chars: number; ok: boolean }[];
  warnings: string[];
  confidence: Confidence;
  fields: AiDraftFields;
  usage: LlmUsageRecord;
  appliedFields: string[];
  appliedAt: Date | null;
}

export interface CompetitorPromotion {
  reasons: PromotionReason[];
  note: string;
  fromRadarId: string | null;
  at: Date;
  byUserId: string | null;
}

export interface RevisionChange {
  field: string;
  before: unknown;
  after: unknown;
}

// ---------------------------------------------------------------------------
// ci_competitors — Tier 1
// ---------------------------------------------------------------------------

const pricingPlanSchema = new Schema(
  {
    planId: { type: String, required: true },
    name: { type: String, default: "" },
    priceMonthly: { type: Number, default: null },
    priceAnnualMonthly: { type: Number, default: null },
    currency: { type: String, default: "USD" },
    unit: { type: String, enum: PRICING_UNITS, default: "unknown" },
    minRooms: { type: Number, default: null },
    maxRooms: { type: Number, default: null },
    includesRooms: { type: Number, default: null },
    includes: { type: [String], default: [] },
    notes: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    observedAt: { type: Date, default: null },
  },
  { _id: false },
);

const pricingSchema = new Schema(
  {
    model: { type: String, default: "" },
    range: { type: String, default: "" },
    unit: { type: String, enum: PRICING_UNITS, default: "unknown" },
    minMonthlyUsd: { type: Number, default: null },
    maxMonthlyUsd: { type: Number, default: null },
    currency: { type: String, default: "" },
    pricingUrl: { type: String, default: "" },
    screenshotUrl: { type: String, default: "" },
    // v2
    visibility: { type: String, enum: PRICING_VISIBILITY, default: "unknown" },
    plans: { type: [pricingPlanSchema], default: [] },
    normalized: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const featureMatrixItemSchema = new Schema(
  {
    key: { type: String, required: true },
    has: { type: String, enum: FEATURE_HAS_INPUT, default: "unknown" },
    note: { type: String, default: "" },
    evidenceUrl: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
    source: { type: String, enum: FIELD_SOURCES, default: "manual" },
  },
  { _id: false },
);

const evidenceSchema = new Schema(
  {
    evidenceId: { type: String, required: true },
    kind: { type: String, enum: EVIDENCE_KINDS, default: "other" },
    url: { type: String, default: "" },
    note: { type: String, default: "" },
    addedAt: { type: Date, default: () => new Date() },
    addedByUserId: { type: String, default: null },
  },
  { _id: false },
);

const mentionSchema = new Schema(
  {
    mentionId: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
    note: { type: String, default: "" },
    // v2
    context: { type: String, enum: MENTION_CONTEXTS, default: "other" },
    source: { type: String, enum: ["manual", "auto"], default: "manual" },
    confidence: { type: String, enum: CONFIDENCES, default: "high" },
    sourceRef: { type: Schema.Types.Mixed, default: null },
    accountId: { type: String, default: null },
    conversationId: { type: String, default: null },
    addedByUserId: { type: String, default: null },
  },
  { _id: false },
);

const weaknessSchema = new Schema(
  {
    weaknessId: { type: String, required: true },
    theme: { type: String, enum: WEAKNESS_THEMES, required: true },
    note: { type: String, default: "" },
    evidenceUrl: { type: String, default: "" },
    source: { type: String, enum: FIELD_SOURCES, default: "manual" },
    addedAt: { type: Date, default: () => new Date() },
    addedByUserId: { type: String, default: null },
  },
  { _id: false },
);

const socialProfileSchema = new Schema(
  {
    profileId: { type: String, required: true },
    network: { type: String, enum: SOCIAL_NETWORKS, required: true },
    handle: { type: String, default: "" },
    url: { type: String, default: "" },
    externalId: { type: String, default: "" },
    discoveredBy: { type: String, enum: PROFILE_DISCOVERED_BY, default: "manual" },
    status: { type: String, enum: PROFILE_STATUSES, default: "candidate" },
    lastCheckedAt: { type: Date, default: null },
    lastOkAt: { type: Date, default: null },
    latest: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const watchedPageSchema = new Schema(
  {
    pageId: { type: String, required: true },
    kind: { type: String, enum: WATCHED_PAGE_KINDS, required: true },
    url: { type: String, required: true },
    feedUrl: { type: String, default: null },
    cadence: { type: String, enum: WATCHED_PAGE_CADENCES, default: "weekly" },
    status: { type: String, enum: WATCHED_PAGE_STATUSES, default: "active" },
    lastHash: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastChangedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** v2.1: catalogo de productos/modulos que vende el competidor. */
const productSchema = new Schema(
  {
    productId: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, enum: PRODUCT_TYPES, default: "other" },
    description: { type: String, default: "" },
    url: { type: String, default: "" },
    pricingNote: { type: String, default: "" },
    status: { type: String, enum: PRODUCT_STATUSES, default: "live" },
    /** Producto núcleo (lo que venden primero) vs complemento. */
    isCore: { type: Boolean, default: false },
    source: { type: String, enum: FIELD_SOURCES, default: "manual" },
    evidenceUrl: { type: String, default: "" },
    addedAt: { type: Date, default: () => new Date() },
    addedByUserId: { type: String, default: null },
  },
  { _id: false },
);

/** v2.1: anuncio observado en una biblioteca publica (carga manual). */
const adSchema = new Schema(
  {
    adId: { type: String, required: true },
    network: { type: String, enum: AD_NETWORKS, default: "meta" },
    headline: { type: String, default: "" },
    copy: { type: String, default: "" },
    landingUrl: { type: String, default: "" },
    screenshotUrl: { type: String, default: "" },
    note: { type: String, default: "" },
    status: { type: String, enum: AD_STATUSES, default: "active" },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date() },
    source: { type: String, enum: FIELD_SOURCES, default: "manual" },
    addedByUserId: { type: String, default: null },
  },
  { _id: false },
);

const promotionSchema = new Schema(
  {
    reasons: { type: [{ type: String, enum: PROMOTION_REASONS }], default: [] },
    note: { type: String, default: "" },
    fromRadarId: { type: String, default: null },
    at: { type: Date, default: () => new Date() },
    byUserId: { type: String, default: null },
  },
  { _id: false },
);

const competitorSchema = new Schema(
  {
    competitorId: { type: String, required: true, unique: true, index: true },
    schemaVersion: { type: Number, default: 1 },
    name: { type: String, required: true },
    website: { type: String, required: true },
    websiteDomain: { type: String, required: true, unique: true, index: true },
    // v2: identidad extendida (dedupe del radar / senales / menciones)
    aliases: { type: [String], default: [] },
    extraDomains: { type: [String], default: [] },

    segment: { type: String, enum: COMPETITOR_SEGMENTS, required: true, index: true },
    priority: { type: String, enum: COMPETITOR_PRIORITIES, default: "C", index: true },
    status: { type: String, enum: COMPETITOR_STATUSES, default: "active", index: true },
    // v2.2: una sola lista. `stage` dice en que punto del embudo esta.
    stage: { type: String, enum: COMPETITOR_STAGES, default: "tracked", index: true },
    /** De donde salio cuando lo trajo el radar (vacio si se cargo a mano). */
    detection: { type: Schema.Types.Mixed, default: null },

    // v2: taxonomia + ICP
    productTypes: { type: [{ type: String, enum: PRODUCT_TYPES }], default: [] },
    targetSizes: { type: [{ type: String, enum: TARGET_SIZES }], default: [] },
    geoFocus: { type: [String], default: [] },
    overlapScore: { type: Number, default: null },
    prioritySuggested: { type: Schema.Types.Mixed, default: null },

    pricing: { type: pricingSchema, default: () => ({}) },
    keyFeatures: { type: [String], default: [] },
    featureMatrix: { type: [featureMatrixItemSchema], default: [] },
    statedPositioning: { type: String, default: "" },
    detectedWeakness: { type: String, default: "" },
    // v1 (derivado en v2 de weaknesses[].theme)
    weaknessThemes: { type: [{ type: String, enum: WEAKNESS_THEMES }], default: [] },
    // v2: debilidades con evidencia
    weaknesses: { type: [weaknessSchema], default: [] },
    ourAngle: { type: String, default: "" },

    evidence: { type: [evidenceSchema], default: [] },
    mentions: { type: [mentionSchema], default: [] },
    promotion: { type: promotionSchema, default: null },

    // v2: redes y paginas vigiladas
    socialProfiles: { type: [socialProfileSchema], default: [] },
    watchedPages: { type: [watchedPageSchema], default: [] },

    // v2.1: catalogo de productos y anuncios observados
    products: { type: [productSchema], default: [] },
    ads: { type: [adSchema], default: [] },

    // v2: procedencia por campo { [path]: FieldMeta } y calidad
    meta: { type: Schema.Types.Mixed, default: () => ({}) },
    quality: { type: Schema.Types.Mixed, default: null },

    lastReviewedAt: { type: Date, default: () => new Date(), index: true },

    // Un solo slot: el ultimo borrador. Mixed a proposito: la forma la define
    // el service y se escribe siempre entera (nunca se muta in-place).
    aiDraft: { type: Schema.Types.Mixed, default: null },
    notes: { type: String, default: "" },

    createdByUserId: { type: String, default: null },
    updatedByUserId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_competitors", minimize: false },
);

competitorSchema.index({ stage: 1, status: 1, priority: 1 });
competitorSchema.index({ status: 1, priority: 1, segment: 1 });
competitorSchema.index({ status: 1, lastReviewedAt: 1 });
competitorSchema.index({ extraDomains: 1 });
competitorSchema.index({ aliases: 1 });
competitorSchema.index({ "socialProfiles.network": 1 });
competitorSchema.index({ overlapScore: -1 });

export const Competitor = model("CiCompetitor", competitorSchema);

// ---------------------------------------------------------------------------
// ci_competitor_revisions — historial (diff simple)
// ---------------------------------------------------------------------------

const revisionSchema = new Schema(
  {
    revisionId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true, index: true },
    at: { type: Date, default: () => new Date() },
    byUserId: { type: String, default: null },
    source: { type: String, enum: REVISION_SOURCES, default: "manual" },
    changes: {
      type: [
        new Schema(
          {
            field: { type: String, required: true },
            before: { type: Schema.Types.Mixed, default: null },
            after: { type: Schema.Types.Mixed, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { collection: "ci_competitor_revisions", versionKey: false, minimize: false },
);
revisionSchema.index({ competitorId: 1, at: -1 });

export const CompetitorRevision = model("CiCompetitorRevision", revisionSchema);

// ---------------------------------------------------------------------------
// ci_radar_items — Tier 2 (cola de triage)
// ---------------------------------------------------------------------------

const radarItemSchema = new Schema(
  {
    radarId: { type: String, required: true, unique: true, index: true },
    kind: { type: String, enum: RADAR_KINDS, required: true, index: true },

    // new_entrant
    detectedName: { type: String, default: "" },
    url: { type: String, default: "" },
    // El indice va abajo (unico y parcial por kind); aca no, o mongoose crea dos.
    domain: { type: String, default: null },
    source: { type: String, enum: RADAR_SOURCES, default: "web_search" },
    sourceLabel: { type: String, default: "" },
    foundByQueryIds: { type: [String], default: [] },
    aiSummary: { type: String, default: "" },
    aiClassification: { type: String, enum: RADAR_CLASSIFICATIONS, default: "new_competitor" },
    aiConfidence: { type: String, enum: CONFIDENCES, default: "medium" },
    tractionSignals: { type: [String], default: [] },
    seenCount: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date(), index: true },

    // tracked_change (v1) · signal / mention (v2)
    competitorId: { type: String, default: null, index: true },
    changedPage: { type: String, enum: SNAPSHOT_PAGES, default: null },
    changeSummary: { type: String, default: "" },
    changeArea: { type: String, default: "" },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    eventId: { type: String, default: null, index: true },
    suggestionId: { type: String, default: null },
    severity: { type: String, enum: SEVERITIES, default: null },

    // triage
    status: { type: String, enum: RADAR_STATUSES, default: "pending", index: true },
    decidedAt: { type: Date, default: null },
    decidedByUserId: { type: String, default: null },
    decidedBy: { type: String, enum: ["user", "ai"], default: null },
    discardReason: { type: String, default: "" },
    promotedCompetitorId: { type: String, default: null },
    runId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_radar_items", minimize: false },
);
radarItemSchema.index({ status: 1, kind: 1, lastSeenAt: -1 });
radarItemSchema.index(
  { domain: 1 },
  { unique: true, partialFilterExpression: { kind: "new_entrant", domain: { $type: "string" } } },
);

export const RadarItem = model("CiRadarItem", radarItemSchema);

// ---------------------------------------------------------------------------
// ci_radar_runs — observabilidad (radar + senales + menciones)
// ---------------------------------------------------------------------------

const radarRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    mode: { type: String, enum: RADAR_RUN_MODES, required: true },
    trigger: { type: String, enum: ["cron", "manual"], required: true },
    triggeredByUserId: { type: String, default: null },
    scopeCompetitorIds: { type: [String], default: [] },
    startedAt: { type: Date, default: () => new Date(), index: true },
    finishedAt: { type: Date, default: null },
    status: { type: String, enum: RADAR_RUN_STATUSES, default: "running", index: true },
    queries: { type: [Schema.Types.Mixed], default: [] },
    changes: { type: Schema.Types.Mixed, default: null },
    // v2 (modo signals)
    connectors: { type: [Schema.Types.Mixed], default: [] },
    budget: { type: Schema.Types.Mixed, default: null },
    totals: { type: Schema.Types.Mixed, default: () => ({}) },
    errors: { type: [String], default: [] },
  },
  { collection: "ci_radar_runs", versionKey: false, minimize: false, suppressReservedKeysWarning: true },
);

export const RadarRun = model("CiRadarRun", radarRunSchema);

// ---------------------------------------------------------------------------
// ci_page_snapshots — ultima foto de texto por competidor y pagina
// ---------------------------------------------------------------------------

const snapshotSchema = new Schema(
  {
    snapshotId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true },
    page: { type: String, enum: SNAPSHOT_PAGES, required: true },
    // v2: id de la pagina vigilada (home/pricing de v1 no lo tienen hasta migrar)
    pageId: { type: String, default: null },
    url: { type: String, default: "" },
    textHash: { type: String, default: null },
    text: { type: String, default: "" },
    fetchedAt: { type: Date, default: () => new Date() },
    status: { type: String, enum: ["ok", "unavailable", "error"], default: "ok" },
    error: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_page_snapshots" },
);
snapshotSchema.index({ competitorId: 1, page: 1 }, { unique: true, partialFilterExpression: { pageId: null } });
snapshotSchema.index({ competitorId: 1, pageId: 1 }, { unique: true, partialFilterExpression: { pageId: { $type: "string" } } });

export const PageSnapshot = model("CiPageSnapshot", snapshotSchema);

// ---------------------------------------------------------------------------
// ci_signals — serie temporal por competidor / connector / metrica (v2)
// ---------------------------------------------------------------------------

const signalSchema = new Schema(
  {
    signalId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true, index: true },
    profileId: { type: String, default: null },
    pageId: { type: String, default: null },
    connector: { type: String, enum: SIGNAL_CONNECTORS, required: true },
    network: { type: String, enum: SOCIAL_NETWORKS, default: null },
    metric: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
    unit: { type: String, default: "count" },
    approx: { type: Boolean, default: false },
    sourceUrl: { type: String, default: "" },
    observedAt: { type: Date, default: () => new Date(), index: true },
    runId: { type: String, default: null },
  },
  { collection: "ci_signals", versionKey: false },
);
signalSchema.index({ competitorId: 1, metric: 1, observedAt: -1 });
signalSchema.index({ connector: 1, observedAt: -1 });

export const CiSignal = model("CiSignal", signalSchema);

// ---------------------------------------------------------------------------
// ci_signal_events — hechos materiales (v2)
// ---------------------------------------------------------------------------

const signalEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true, index: true },
    kind: { type: String, enum: SIGNAL_EVENT_KINDS, required: true, index: true },
    severity: { type: String, enum: SEVERITIES, default: "low" },
    title: { type: String, default: "" },
    summary: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    connector: { type: String, enum: SIGNAL_CONNECTORS, required: true },
    network: { type: String, default: null },
    evidence: { type: Schema.Types.Mixed, default: null },
    featureKeys: { type: [String], default: [] },
    dedupeKey: { type: String, required: true, unique: true },
    observedAt: { type: Date, default: () => new Date(), index: true },
    runId: { type: String, default: null },
    radarId: { type: String, default: null },
    suggestionIds: { type: [String], default: [] },
    status: { type: String, enum: SIGNAL_EVENT_STATUSES, default: "new", index: true },
  },
  { timestamps: true, collection: "ci_signal_events", minimize: false },
);
signalEventSchema.index({ competitorId: 1, observedAt: -1 });
signalEventSchema.index({ status: 1, severity: 1, observedAt: -1 });

export const CiSignalEvent = model("CiSignalEvent", signalEventSchema);

// ---------------------------------------------------------------------------
// ci_content — feed unificado de lo que publica cada competidor (v2.1)
// ---------------------------------------------------------------------------

/**
 * A diferencia de `ci_signal_events` (que guarda solo lo MATERIAL), acá entra
 * todo lo publicado: sirve para leer el pulso ("de qué habla", cada cuánto
 * postea") aunque nada amerite un evento. Fuentes con contenido real: YouTube,
 * blog/changelog (RSS), Reddit y Product Hunt. Instagram/LinkedIn/X/TikTok no
 * tienen API abierta: de ahí sólo hay conteos, no publicaciones.
 */
const contentSchema = new Schema(
  {
    contentId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true, index: true },
    network: { type: String, enum: SOCIAL_NETWORKS, required: true },
    profileId: { type: String, default: null },
    pageId: { type: String, default: null },
    externalId: { type: String, default: "" },
    title: { type: String, default: "" },
    excerpt: { type: String, default: "" },
    url: { type: String, default: "" },
    publishedAt: { type: Date, default: () => new Date(), index: true },
    kind: { type: String, enum: CONTENT_KINDS, default: "post" },
    featureKeys: { type: [String], default: [] },
    engagement: { type: Schema.Types.Mixed, default: null },
    connector: { type: String, enum: SIGNAL_CONNECTORS, required: true },
    /** sha1(competitorId + url|externalId): evita duplicar en cada corrida. */
    dedupeKey: { type: String, required: true, unique: true },
    eventId: { type: String, default: null },
    fetchedAt: { type: Date, default: () => new Date() },
    runId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_content", minimize: false },
);
contentSchema.index({ competitorId: 1, publishedAt: -1 });
contentSchema.index({ competitorId: 1, network: 1, publishedAt: -1 });

export const CiContent = model("CiContent", contentSchema);

// ---------------------------------------------------------------------------
// ci_suggestions — propuestas de cambio pendientes (v2)
// ---------------------------------------------------------------------------

const suggestionSchema = new Schema(
  {
    suggestionId: { type: String, required: true, unique: true, index: true },
    competitorId: { type: String, required: true, index: true },
    field: { type: String, required: true },
    proposedValue: { type: Schema.Types.Mixed, default: null },
    currentValue: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: "" },
    evidenceUrl: { type: String, default: "" },
    quote: { type: String, default: "" },
    source: { type: String, enum: SUGGESTION_SOURCES, required: true },
    confidence: { type: String, enum: CONFIDENCES, default: "medium" },
    eventId: { type: String, default: null },
    status: { type: String, enum: SUGGESTION_STATUSES, default: "pending", index: true },
    decidedAt: { type: Date, default: null },
    decidedByUserId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_suggestions", minimize: false },
);
suggestionSchema.index(
  { competitorId: 1, field: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

export const CiSuggestion = model("CiSuggestion", suggestionSchema);

// ---------------------------------------------------------------------------
// ci_settings — singleton
// ---------------------------------------------------------------------------

const settingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    radar: {
      enabled: { type: Boolean, default: true },
      queries: {
        type: [
          new Schema(
            {
              queryId: { type: String, required: true },
              text: { type: String, required: true },
              enabled: { type: Boolean, default: true },
              note: { type: String, default: "" },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
      excludedDomains: { type: [String], default: [] },
      ourDomains: { type: [String], default: [] },
      maxSearchesPerQuery: { type: Number, default: 3 },
    },
    ourPricing: {
      unit: { type: String, enum: PRICING_UNITS, default: "unknown" },
      minMonthlyUsd: { type: Number, default: null },
      maxMonthlyUsd: { type: Number, default: null },
      note: { type: String, default: "" },
    },
    // { [featureKey]: { coverage, ticketId, note } }
    ourFeatures: { type: Schema.Types.Mixed, default: () => ({}) },
    staleDays: { type: Number, default: 30 },
    // v2
    icp: { type: Schema.Types.Mixed, default: null },
    referenceHotel: { type: Schema.Types.Mixed, default: null },
    ourAliases: { type: [String], default: [] },
    signals: { type: Schema.Types.Mixed, default: null },
    mentionDetection: { type: Schema.Types.Mixed, default: null },
    fieldHelp: { type: Schema.Types.Mixed, default: () => ({}) },
    updatedByUserId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_settings", minimize: false },
);

export const CiSettings = model("CiSettings", settingsSchema);

// ---------------------------------------------------------------------------
// ci_decisions — log de decisiones tomadas (metrica de exito)
// ---------------------------------------------------------------------------

const decisionSchema = new Schema(
  {
    decisionId: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: DECISION_TYPES, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    competitorIds: { type: [String], default: [] },
    ticketId: { type: String, default: null },
    decidedAt: { type: Date, default: () => new Date(), index: true },
    byUserId: { type: String, default: null },
  },
  { timestamps: true, collection: "ci_decisions" },
);

export const CiDecision = model("CiDecision", decisionSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeDoc<T = any>(doc: any): T {
  if (!doc) return doc;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest as T;
}

/** Snapshot sin el texto (la lista/detalle no necesita 30k chars por pagina). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeSnapshot(doc: any) {
  const obj = sanitizeDoc(doc);
  if (!obj) return obj;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { text, ...rest } = obj;
  return rest;
}
