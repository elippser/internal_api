import { makeId } from "../../shared/utils/ids";
import { domainOf } from "../crm/crm.model";
import {
  CiSettings,
  FEATURE_KEYS,
  SIGNAL_CONNECTORS,
  sanitizeDoc,
  type Cadence,
  type OurCoverage,
  type PricingUnit,
} from "./competitors.model";

export interface RadarQueryConfig {
  queryId: string;
  text: string;
  enabled: boolean;
  note: string;
}

export interface SignalSettings {
  enabled: boolean;
  cadenceByPriority: Record<"A" | "B" | "C", Cadence>;
  connectors: Record<string, { enabled: boolean; note: string }>;
  thresholds: {
    followerJumpPct: number;
    activitySpikeX: number;
    ratingDropAbs: number;
    hiringSpikeAbs: number;
    newsMin: number;
  };
  monthlyBudgetUsd: number;
  webhookUrl: string;
  webhookEvents: string[];
  trendsGeos: string[];
}

export interface CiSettingsRecord {
  key: string;
  radar: {
    enabled: boolean;
    queries: RadarQueryConfig[];
    excludedDomains: string[];
    ourDomains: string[];
    maxSearchesPerQuery: number;
  };
  ourPricing: {
    unit: PricingUnit;
    minMonthlyUsd: number | null;
    maxMonthlyUsd: number | null;
    note: string;
  };
  ourFeatures: Record<string, { coverage: OurCoverage; ticketId?: string | null; note?: string }>;
  staleDays: number;
  // v2
  icp: { productTypes: string[]; targetSizes: string[]; geoFocus: string[] };
  referenceHotel: { rooms: number; currency: string };
  ourAliases: string[];
  signals: SignalSettings;
  mentionDetection: { enabled: boolean; lookbackDays: number; minConfidence: "high" | "medium" | "low" };
  fieldHelp: Record<string, string>;
  updatedByUserId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// Seed del radar (spec §7.1). Editable desde la UI sin deploy.
export const DEFAULT_QUERIES: string[] = [
  '"PMS hotelero" lanzamiento OR nuevo OR startup',
  '"software hotelero" lanzamiento OR launch Argentina OR LATAM OR Latinoamérica',
  'hotel management software launch "Latin America" OR LATAM small hotels',
  '"motor de reservas" hoteles pequeños nuevo software OR app',
  '"sistema de gestión hotelera" OR "gestión de hospedajes" nuevo OR lanzamiento',
];

export const DEFAULT_EXCLUDED_DOMAINS: string[] = [
  "capterra.com",
  "getapp.com",
  "g2.com",
  "softwareadvice.com",
  "producthunt.com",
  "crunchbase.com",
  "linkedin.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
  "medium.com",
  "hosteltur.com",
  "tecnohotelnews.com",
];

// Dominios propios: nunca son candidatos del radar. pxsol.com aparecio como
// "entrante" en la primera corrida real (es el dominio del equipo).
export const DEFAULT_OUR_DOMAINS: string[] = ["bookfer.com", "elippser.com", "pxsol.com"];
export const DEFAULT_OUR_ALIASES: string[] = ["bookfer", "elippser", "laupser", "pxsol"];

export const DEFAULT_ICP = {
  productTypes: ["pms", "booking_engine", "website_builder"],
  targetSizes: ["micro", "small"],
  geoFocus: ["latam"],
};
export const DEFAULT_REFERENCE_HOTEL = { rooms: 15, currency: "USD" };

export function defaultSignalSettings(): SignalSettings {
  const connectors: SignalSettings["connectors"] = {};
  for (const id of SIGNAL_CONNECTORS) connectors[id] = { enabled: true, note: "" };
  return {
    enabled: true,
    cadenceByPriority: { A: "weekly", B: "biweekly", C: "monthly" },
    connectors,
    thresholds: { followerJumpPct: 15, activitySpikeX: 2, ratingDropAbs: 0.3, hiringSpikeAbs: 3, newsMin: 1 },
    monthlyBudgetUsd: 20,
    webhookUrl: "",
    webhookEvents: ["launch", "pricing_change", "funding", "rating_drop"],
    trendsGeos: ["AR", "MX", "CO", "BR", "CL", "PE", "ES"],
  };
}
export const DEFAULT_MENTION_DETECTION = { enabled: true, lookbackDays: 7, minConfidence: "medium" as const };

function defaultStaleDays(): number {
  const n = Number(process.env.CI_STALE_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function normalizeDomainList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    const d = domainOf(raw);
    if (d) out.add(d);
  }
  return Array.from(out);
}

function normalizeAliasList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s.length >= 3) out.add(s);
  }
  return Array.from(out);
}

/** Completa en memoria los campos v2 que falten (docs creados en v1). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDefaults(raw: any): CiSettingsRecord {
  const defaultsSignals = defaultSignalSettings();
  const signals: SignalSettings = raw.signals
    ? {
        ...defaultsSignals,
        ...raw.signals,
        cadenceByPriority: { ...defaultsSignals.cadenceByPriority, ...(raw.signals.cadenceByPriority ?? {}) },
        connectors: { ...defaultsSignals.connectors, ...(raw.signals.connectors ?? {}) },
        thresholds: { ...defaultsSignals.thresholds, ...(raw.signals.thresholds ?? {}) },
      }
    : defaultsSignals;
  return {
    ...raw,
    icp: raw.icp ?? DEFAULT_ICP,
    referenceHotel: raw.referenceHotel ?? DEFAULT_REFERENCE_HOTEL,
    ourAliases: Array.isArray(raw.ourAliases) && raw.ourAliases.length ? raw.ourAliases : DEFAULT_OUR_ALIASES,
    signals,
    mentionDetection: raw.mentionDetection ?? DEFAULT_MENTION_DETECTION,
    fieldHelp: raw.fieldHelp ?? {},
    staleDays: raw.staleDays || defaultStaleDays(),
  } as CiSettingsRecord;
}

export async function getSettings(): Promise<CiSettingsRecord> {
  const existing = await CiSettings.findOne({ key: "default" });
  if (existing) return withDefaults(sanitizeDoc(existing));
  const created = await CiSettings.create({
    key: "default",
    radar: {
      enabled: true,
      queries: DEFAULT_QUERIES.map((text) => ({ queryId: makeId("q"), text, enabled: true, note: "" })),
      excludedDomains: DEFAULT_EXCLUDED_DOMAINS,
      ourDomains: DEFAULT_OUR_DOMAINS,
      maxSearchesPerQuery: 3,
    },
    ourPricing: { unit: "unknown", minMonthlyUsd: null, maxMonthlyUsd: null, note: "" },
    ourFeatures: {},
    staleDays: defaultStaleDays(),
    icp: DEFAULT_ICP,
    referenceHotel: DEFAULT_REFERENCE_HOTEL,
    ourAliases: DEFAULT_OUR_ALIASES,
    signals: defaultSignalSettings(),
    mentionDetection: DEFAULT_MENTION_DETECTION,
    fieldHelp: {},
  });
  return withDefaults(sanitizeDoc(created));
}

export async function getStaleDays(): Promise<number> {
  const s = await getSettings();
  return s.staleDays || defaultStaleDays();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateSettings(patch: any, userId: string | null): Promise<CiSettingsRecord> {
  const current = await getSettings(); // asegura el singleton
  const $set: Record<string, unknown> = { updatedByUserId: userId };
  const $unset: Record<string, 1> = {};

  if (patch.radar) {
    const r = patch.radar;
    if (typeof r.enabled === "boolean") $set["radar.enabled"] = r.enabled;
    if (Array.isArray(r.queries)) {
      $set["radar.queries"] = r.queries.map((q: Partial<RadarQueryConfig>) => ({
        queryId: q.queryId && q.queryId.trim() ? q.queryId.trim() : makeId("q"),
        text: String(q.text ?? "").trim(),
        enabled: q.enabled !== false,
        note: q.note ?? "",
      }));
    }
    if (Array.isArray(r.excludedDomains)) $set["radar.excludedDomains"] = normalizeDomainList(r.excludedDomains);
    if (Array.isArray(r.ourDomains)) $set["radar.ourDomains"] = normalizeDomainList(r.ourDomains);
    if (typeof r.maxSearchesPerQuery === "number") $set["radar.maxSearchesPerQuery"] = r.maxSearchesPerQuery;
  }
  if (patch.ourPricing) {
    for (const k of ["unit", "minMonthlyUsd", "maxMonthlyUsd", "note"] as const) {
      if (patch.ourPricing[k] !== undefined) $set[`ourPricing.${k}`] = patch.ourPricing[k];
    }
  }
  if (patch.ourFeatures && typeof patch.ourFeatures === "object") {
    for (const key of Object.keys(patch.ourFeatures)) {
      if (!FEATURE_KEYS.includes(key)) continue;
      const v = patch.ourFeatures[key];
      // null = "sin dato": se quita la clave (la UI lo usa para limpiar una cobertura).
      if (v === null) {
        $unset[`ourFeatures.${key}`] = 1;
        continue;
      }
      $set[`ourFeatures.${key}`] = {
        coverage: v.coverage,
        ticketId: v.ticketId ? String(v.ticketId) : null,
        note: v.note ?? "",
      };
    }
  }
  if (typeof patch.staleDays === "number") $set.staleDays = patch.staleDays;

  // --- v2 -------------------------------------------------------------------
  if (patch.icp) {
    $set.icp = {
      productTypes: Array.isArray(patch.icp.productTypes) ? patch.icp.productTypes : current.icp.productTypes,
      targetSizes: Array.isArray(patch.icp.targetSizes) ? patch.icp.targetSizes : current.icp.targetSizes,
      geoFocus: Array.isArray(patch.icp.geoFocus) ? patch.icp.geoFocus.map((g: string) => String(g).toLowerCase()) : current.icp.geoFocus,
    };
  }
  if (patch.referenceHotel) {
    $set.referenceHotel = {
      rooms: typeof patch.referenceHotel.rooms === "number" ? patch.referenceHotel.rooms : current.referenceHotel.rooms,
      currency: patch.referenceHotel.currency ?? current.referenceHotel.currency ?? "USD",
    };
  }
  if (Array.isArray(patch.ourAliases)) $set.ourAliases = normalizeAliasList(patch.ourAliases);
  if (patch.signals && typeof patch.signals === "object") {
    const s = patch.signals;
    const next: SignalSettings = {
      ...current.signals,
      ...(typeof s.enabled === "boolean" ? { enabled: s.enabled } : {}),
      ...(typeof s.monthlyBudgetUsd === "number" ? { monthlyBudgetUsd: s.monthlyBudgetUsd } : {}),
      ...(typeof s.webhookUrl === "string" ? { webhookUrl: s.webhookUrl.trim() } : {}),
      ...(Array.isArray(s.webhookEvents) ? { webhookEvents: s.webhookEvents } : {}),
      ...(Array.isArray(s.trendsGeos) ? { trendsGeos: s.trendsGeos.map((g: string) => String(g).toUpperCase()) } : {}),
      cadenceByPriority: { ...current.signals.cadenceByPriority, ...(s.cadenceByPriority ?? {}) },
      thresholds: { ...current.signals.thresholds, ...(s.thresholds ?? {}) },
      connectors: { ...current.signals.connectors },
    };
    if (s.connectors && typeof s.connectors === "object") {
      for (const id of Object.keys(s.connectors)) {
        if (!(SIGNAL_CONNECTORS as readonly string[]).includes(id)) continue;
        next.connectors[id] = {
          enabled: s.connectors[id]?.enabled !== false,
          note: s.connectors[id]?.note ?? "",
        };
      }
    }
    $set.signals = next;
  }
  if (patch.mentionDetection) {
    $set.mentionDetection = { ...current.mentionDetection, ...patch.mentionDetection };
  }
  if (patch.fieldHelp && typeof patch.fieldHelp === "object") {
    $set.fieldHelp = { ...current.fieldHelp, ...patch.fieldHelp };
  }

  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  const doc = await CiSettings.findOneAndUpdate({ key: "default" }, update, { new: true });
  return withDefaults(sanitizeDoc(doc));
}
