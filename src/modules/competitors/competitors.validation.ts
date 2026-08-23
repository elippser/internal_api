import Joi from "joi";
import {
  AI_DRAFT_APPLY_FIELDS,
  CADENCES,
  COMPETITOR_PRIORITIES,
  COMPETITOR_SEGMENTS,
  COMPETITOR_STAGES,
  COMPETITOR_STATUSES,
  CONFIDENCES,
  DECISION_TYPES,
  EVIDENCE_KINDS,
  FEATURE_HAS_INPUT,
  FEATURE_KEYS,
  MENTION_CONTEXTS,
  OUR_COVERAGE,
  PRICING_UNITS,
  PRICING_VISIBILITY,
  AD_NETWORKS,
  AD_STATUSES,
  CONTENT_KINDS,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  PROFILE_STATUSES,
  PROMOTION_REASONS,
  RADAR_KINDS,
  RADAR_RUN_MODES,
  RADAR_STATUSES,
  SIGNAL_CONNECTORS,
  SIGNAL_EVENT_KINDS,
  SIGNAL_EVENT_STATUSES,
  SOCIAL_NETWORKS,
  TARGET_SIZES,
  WATCHED_PAGE_CADENCES,
  WATCHED_PAGE_KINDS,
  WATCHED_PAGE_STATUSES,
  WEAKNESS_THEMES,
} from "./competitors.model";

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

const optionalText = (max: number) => Joi.string().allow("", null).max(max);
const url = Joi.string().trim().max(2_000);
const shortList = (max: number, itemMax = 120) => Joi.array().items(Joi.string().trim().min(1).max(itemMax)).max(max);

export const listCompetitorsSchema = Joi.object({
  segment: Joi.string().valid(...COMPETITOR_SEGMENTS).optional(),
  priority: Joi.string().valid(...COMPETITOR_PRIORITIES).optional(),
  // "all" para ver activos + archivados juntos.
  status: Joi.string().valid(...COMPETITOR_STATUSES, "all").default("active"),
  /** open (default) = seguidos + detectados · all suma descartados. */
  stage: Joi.string().valid(...COMPETITOR_STAGES, "open", "all").optional(),
  stale: Joi.alternatives().try(Joi.boolean(), Joi.string().valid("1", "0", "true", "false")).optional(),
  search: Joi.string().trim().allow("").max(120).optional(),
  // v2
  qualityMax: Joi.number().integer().min(0).max(100).optional(),
  withSuggestions: Joi.alternatives().try(Joi.boolean(), Joi.string().valid("1", "0", "true", "false")).optional(),
  ...pagination,
});

export const createCompetitorSchema = Joi.object({
  name: Joi.string().trim().min(1).max(160).required(),
  website: url.required(),
  segment: Joi.string().valid(...COMPETITOR_SEGMENTS).required(),
  priority: Joi.string().valid(...COMPETITOR_PRIORITIES).optional(),
  notes: optionalText(20_000).optional(),
  aliases: shortList(20, 80).optional(),
});

const planSchema = Joi.object({
  planId: Joi.string().trim().max(64).optional(),
  name: Joi.string().trim().allow("").max(120).default(""),
  priceMonthly: Joi.number().min(0).allow(null).default(null),
  priceAnnualMonthly: Joi.number().min(0).allow(null).default(null),
  currency: Joi.string().trim().uppercase().max(5).default("USD"),
  unit: Joi.string().valid(...PRICING_UNITS).default("unknown"),
  minRooms: Joi.number().integer().min(0).allow(null).default(null),
  maxRooms: Joi.number().integer().min(0).allow(null).default(null),
  includesRooms: Joi.number().integer().min(0).allow(null).default(null),
  includes: shortList(30, 160).default([]),
  notes: optionalText(500).default(""),
  sourceUrl: url.allow("", null).default(""),
  observedAt: Joi.date().iso().allow(null).optional(),
});

const pricingSchema = Joi.object({
  model: optionalText(500),
  range: optionalText(500),
  unit: Joi.string().valid(...PRICING_UNITS),
  minMonthlyUsd: Joi.number().min(0).allow(null),
  maxMonthlyUsd: Joi.number().min(0).allow(null),
  currency: optionalText(10),
  pricingUrl: url.allow("", null),
  screenshotUrl: url.allow("", null),
  // v2
  visibility: Joi.string().valid(...PRICING_VISIBILITY),
  plans: Joi.array().items(planSchema).max(20),
}).min(1);

const featureMatrixItemSchema = Joi.object({
  key: Joi.string().valid(...FEATURE_KEYS).required(),
  has: Joi.string().valid(...FEATURE_HAS_INPUT).required(),
  note: optionalText(300),
  evidenceUrl: url.allow("", null).optional(),
});

export const updateCompetitorSchema = Joi.object({
  name: Joi.string().trim().min(1).max(160),
  website: url,
  segment: Joi.string().valid(...COMPETITOR_SEGMENTS),
  priority: Joi.string().valid(...COMPETITOR_PRIORITIES),
  status: Joi.string().valid(...COMPETITOR_STATUSES),
  pricing: pricingSchema,
  keyFeatures: shortList(30, 160),
  featureMatrix: Joi.array().items(featureMatrixItemSchema).max(FEATURE_KEYS.length),
  statedPositioning: optionalText(5_000),
  detectedWeakness: optionalText(5_000),
  weaknessThemes: Joi.array().items(Joi.string().valid(...WEAKNESS_THEMES)).max(WEAKNESS_THEMES.length),
  ourAngle: optionalText(5_000),
  notes: optionalText(20_000),
  // v2
  aliases: shortList(20, 80),
  extraDomains: shortList(20, 200),
  productTypes: Joi.array().items(Joi.string().valid(...PRODUCT_TYPES)).max(PRODUCT_TYPES.length),
  targetSizes: Joi.array().items(Joi.string().valid(...TARGET_SIZES)).max(TARGET_SIZES.length),
  geoFocus: shortList(40, 20),
  /** Procedencia opcional por campo editado: { "pricing.plans": "https://…" } */
  fieldSources: Joi.object().pattern(Joi.string().max(120), url.allow("", null)),
}).min(1);

export const mentionSchema = Joi.object({
  note: Joi.string().trim().allow("").max(2_000).default(""),
  at: Joi.date().iso().optional(),
  context: Joi.string().valid(...MENTION_CONTEXTS).default("other"),
  accountId: Joi.string().trim().allow("", null).optional(),
  conversationId: Joi.string().trim().allow("", null).optional(),
});

export const evidenceSchema = Joi.object({
  kind: Joi.string().valid(...EVIDENCE_KINDS).required(),
  url: url.allow("", null).optional(),
  note: Joi.string().trim().allow("").max(2_000).default(""),
});

export const weaknessSchema = Joi.object({
  theme: Joi.string().valid(...WEAKNESS_THEMES).required(),
  note: Joi.string().trim().allow("").max(2_000).default(""),
  evidenceUrl: url.allow("", null).default(""),
});

export const weaknessPatchSchema = Joi.object({
  theme: Joi.string().valid(...WEAKNESS_THEMES),
  note: Joi.string().trim().allow("").max(2_000),
  evidenceUrl: url.allow("", null),
}).min(1);

export const socialProfileSchema = Joi.object({
  network: Joi.string().valid(...SOCIAL_NETWORKS).required(),
  handle: Joi.string().trim().allow("").max(120).default(""),
  url: url.allow("", null).default(""),
  externalId: Joi.string().trim().allow("").max(200).default(""),
  status: Joi.string().valid(...PROFILE_STATUSES).default("confirmed"),
});

export const socialProfilePatchSchema = Joi.object({
  handle: Joi.string().trim().allow("").max(120),
  url: url.allow("", null),
  externalId: Joi.string().trim().allow("").max(200),
  status: Joi.string().valid(...PROFILE_STATUSES),
}).min(1);

export const watchedPageSchema = Joi.object({
  kind: Joi.string().valid(...WATCHED_PAGE_KINDS).required(),
  url: url.required(),
  feedUrl: url.allow("", null).optional(),
  cadence: Joi.string().valid(...WATCHED_PAGE_CADENCES).default("weekly"),
});

export const watchedPagePatchSchema = Joi.object({
  kind: Joi.string().valid(...WATCHED_PAGE_KINDS),
  url,
  feedUrl: url.allow("", null),
  cadence: Joi.string().valid(...WATCHED_PAGE_CADENCES),
  status: Joi.string().valid(...WATCHED_PAGE_STATUSES),
}).min(1);

export const productSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  category: Joi.string().valid(...PRODUCT_TYPES).default("other"),
  description: optionalText(1_000).default(""),
  url: url.allow("", null).default(""),
  pricingNote: optionalText(300).default(""),
  status: Joi.string().valid(...PRODUCT_STATUSES).default("live"),
  isCore: Joi.boolean().default(false),
  evidenceUrl: url.allow("", null).default(""),
});

export const productPatchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  category: Joi.string().valid(...PRODUCT_TYPES),
  description: optionalText(1_000),
  url: url.allow("", null),
  pricingNote: optionalText(300),
  status: Joi.string().valid(...PRODUCT_STATUSES),
  isCore: Joi.boolean(),
  evidenceUrl: url.allow("", null),
}).min(1);

export const adSchema = Joi.object({
  network: Joi.string().valid(...AD_NETWORKS).default("meta"),
  headline: optionalText(300).default(""),
  copy: optionalText(2_000).default(""),
  landingUrl: url.allow("", null).default(""),
  screenshotUrl: url.allow("", null).default(""),
  note: optionalText(1_000).default(""),
  status: Joi.string().valid(...AD_STATUSES).default("active"),
  firstSeenAt: Joi.date().iso().optional(),
});

export const adPatchSchema = Joi.object({
  network: Joi.string().valid(...AD_NETWORKS),
  headline: optionalText(300),
  copy: optionalText(2_000),
  landingUrl: url.allow("", null),
  screenshotUrl: url.allow("", null),
  note: optionalText(1_000),
  status: Joi.string().valid(...AD_STATUSES),
  lastSeenAt: Joi.date().iso(),
}).min(1);

export const listContentSchema = Joi.object({
  network: Joi.string().valid(...SOCIAL_NETWORKS).optional(),
  kind: Joi.string().valid(...CONTENT_KINDS).optional(),
  limit: Joi.number().integer().min(1).max(200).default(50),
});

export const compareSchema = Joi.object({
  ids: Joi.alternatives()
    .try(Joi.array().items(Joi.string()).min(2).max(4), Joi.string())
    .required()
    .custom((v) => (typeof v === "string" ? v.split(",").map((x: string) => x.trim()).filter(Boolean) : v)),
  historyDays: Joi.number().integer().min(30).max(730).default(365),
});

export const stageSchema = Joi.object({
  stage: Joi.string().valid(...COMPETITOR_STAGES).required(),
  segment: Joi.string().valid(...COMPETITOR_SEGMENTS).optional(),
  priority: Joi.string().valid(...COMPETITOR_PRIORITIES).optional(),
  reasons: Joi.array().items(Joi.string().valid(...PROMOTION_REASONS)).optional(),
  note: Joi.string().trim().allow("").max(2_000).optional(),
  reason: Joi.string().trim().allow("").max(500).optional(),
});

export const verifySchema = Joi.object({
  paths: Joi.array().items(Joi.string().trim().min(1).max(160)).min(1).max(200).required(),
});

export const aiDraftRunSchema = Joi.object({
  includeEvidence: Joi.boolean().default(false),
});

export const aiDraftApplySchema = Joi.object({
  fields: Joi.array().items(Joi.string().valid(...AI_DRAFT_APPLY_FIELDS)).min(1).required(),
});

export const listRadarSchema = Joi.object({
  status: Joi.string().valid(...RADAR_STATUSES, "all").default("pending"),
  kind: Joi.string().valid(...RADAR_KINDS).optional(),
  ...pagination,
});

export const radarRunSchema = Joi.object({
  mode: Joi.string().valid(...RADAR_RUN_MODES).default("both"),
});

export const radarActionSchema = Joi.object({
  action: Joi.string().valid("discard", "restore", "acknowledge", "promote", "link", "accept").required(),
  reason: Joi.string().trim().allow("").max(500).optional(),
  segment: Joi.string().valid(...COMPETITOR_SEGMENTS).when("action", {
    is: "promote",
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  promotionReasons: Joi.array()
    .items(Joi.string().valid(...PROMOTION_REASONS))
    .when("action", { is: "promote", then: Joi.array().min(1).required(), otherwise: Joi.optional() })
    .messages({ "array.min": "Elegí al menos un motivo de promoción" }),
  promotionNote: Joi.string().trim().allow("").max(2_000).optional(),
});

export const signalsRunSchema = Joi.object({
  competitorIds: Joi.array().items(Joi.string()).max(100).optional(),
  connectors: Joi.array().items(Joi.string().valid(...SIGNAL_CONNECTORS)).optional(),
});

export const listSignalsSchema = Joi.object({
  competitorId: Joi.string().required(),
  metric: Joi.string().max(60).optional(),
  network: Joi.string().valid(...SOCIAL_NETWORKS).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(2_000).default(500),
});

export const listEventsSchema = Joi.object({
  competitorId: Joi.string().optional(),
  kind: Joi.string().valid(...SIGNAL_EVENT_KINDS).optional(),
  status: Joi.string().valid(...SIGNAL_EVENT_STATUSES, "all").default("all"),
  ...pagination,
});

export const eventPatchSchema = Joi.object({
  status: Joi.string().valid(...SIGNAL_EVENT_STATUSES).required(),
});

export const listSuggestionsSchema = Joi.object({
  competitorId: Joi.string().optional(),
  status: Joi.string().valid("pending", "applied", "rejected", "superseded", "all").default("pending"),
  ...pagination,
});

export const suggestionActionSchema = Joi.object({
  action: Joi.string().valid("apply", "reject").required(),
  value: Joi.any().optional(),
});

export const settingsPatchSchema = Joi.object({
  radar: Joi.object({
    enabled: Joi.boolean(),
    queries: Joi.array()
      .items(
        Joi.object({
          queryId: Joi.string().trim().max(64).optional(),
          text: Joi.string().trim().min(3).max(200).required(),
          enabled: Joi.boolean().default(true),
          note: Joi.string().trim().allow("").max(300).default(""),
        }),
      )
      .max(10),
    excludedDomains: Joi.array().items(Joi.string().trim().max(200)).max(200),
    ourDomains: Joi.array().items(Joi.string().trim().max(200)).max(20),
    maxSearchesPerQuery: Joi.number().integer().min(1).max(5),
  }).min(1),
  ourPricing: Joi.object({
    unit: Joi.string().valid(...PRICING_UNITS),
    minMonthlyUsd: Joi.number().min(0).allow(null),
    maxMonthlyUsd: Joi.number().min(0).allow(null),
    note: optionalText(1_000),
  }).min(1),
  ourFeatures: Joi.object().pattern(
    Joi.string().valid(...FEATURE_KEYS),
    Joi.alternatives().try(
      // null = quitar la cobertura cargada ("sin dato").
      Joi.valid(null),
      Joi.object({
        coverage: Joi.string().valid(...OUR_COVERAGE).required(),
        ticketId: Joi.string().trim().allow("", null).optional(),
        note: optionalText(500).optional(),
      }),
    ),
  ),
  staleDays: Joi.number().integer().min(1).max(365),
  // v2
  icp: Joi.object({
    productTypes: Joi.array().items(Joi.string().valid(...PRODUCT_TYPES)),
    targetSizes: Joi.array().items(Joi.string().valid(...TARGET_SIZES)),
    geoFocus: shortList(40, 20),
  }).min(1),
  referenceHotel: Joi.object({
    rooms: Joi.number().integer().min(1).max(1_000),
    currency: Joi.string().trim().uppercase().max(5),
  }).min(1),
  ourAliases: shortList(30, 80),
  signals: Joi.object({
    enabled: Joi.boolean(),
    cadenceByPriority: Joi.object({
      A: Joi.string().valid(...CADENCES),
      B: Joi.string().valid(...CADENCES),
      C: Joi.string().valid(...CADENCES),
    }),
    connectors: Joi.object().pattern(
      Joi.string().valid(...SIGNAL_CONNECTORS),
      Joi.object({ enabled: Joi.boolean().required(), note: optionalText(300).optional() }),
    ),
    thresholds: Joi.object({
      followerJumpPct: Joi.number().min(1).max(500),
      activitySpikeX: Joi.number().min(1).max(20),
      ratingDropAbs: Joi.number().min(0.05).max(5),
      hiringSpikeAbs: Joi.number().integer().min(1).max(100),
      newsMin: Joi.number().integer().min(0).max(100),
    }),
    monthlyBudgetUsd: Joi.number().min(0).max(10_000),
    webhookUrl: url.allow(""),
    webhookEvents: Joi.array().items(Joi.string().valid(...SIGNAL_EVENT_KINDS)),
    trendsGeos: Joi.array().items(Joi.string().trim().length(2)).max(15),
  }).min(1),
  mentionDetection: Joi.object({
    enabled: Joi.boolean(),
    lookbackDays: Joi.number().integer().min(1).max(90),
    minConfidence: Joi.string().valid(...CONFIDENCES),
  }).min(1),
  fieldHelp: Joi.object().pattern(Joi.string().max(80), Joi.string().allow("").max(1_000)),
}).min(1);

export const createDecisionSchema = Joi.object({
  type: Joi.string().valid(...DECISION_TYPES).required(),
  title: Joi.string().trim().min(3).max(200).required(),
  description: optionalText(10_000).optional(),
  competitorIds: Joi.array().items(Joi.string()).max(50).optional(),
  ticketId: Joi.string().trim().allow("", null).optional(),
  decidedAt: Joi.date().iso().optional(),
});
