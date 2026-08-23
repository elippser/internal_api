import { makeId } from "../../shared/utils/ids";
import { discoverPricingUrl, fetchPage, normalizeUrl, type PageResult } from "../../shared/web/fetchPage";
import { domainOf } from "../crm/crm.model";
import {
  addUsage,
  aiAvailable,
  callJson,
  draftModel,
  emptyUsage,
  evidenceModel,
  withTimeout,
} from "./ciLlm";
import {
  AI_DRAFT_APPLY_FIELDS,
  COMPETITOR_SEGMENTS,
  CONFIDENCES,
  Competitor,
  EVIDENCE_KINDS,
  FEATURE_CATALOG,
  FEATURE_HAS,
  FEATURE_KEYS,
  PRICING_UNITS,
  PRICING_VISIBILITY,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  TARGET_SIZES,
  WEAKNESS_THEMES,
  type AiDraft,
  type AiDraftFields,
  type Confidence,
  type EvidenceKind,
  type FeatureHas,
  type LlmUsageRecord,
  type PricingPlan,
  type SocialNetwork,
  type WatchedPageKind,
  type WeaknessTheme,
} from "./competitors.model";
import {
  CiError,
  decorateCompetitor,
  dedupeStrings,
  loadDoc,
  mutateAndRecord,
} from "./competitors.service";
import { makeMeta, setMeta } from "./fieldMeta";
import { glossaryForPrompt } from "./glossary";
import { getStaleDays } from "./settings.service";

/**
 * Asistente de carga v2 (spec v1 §6 + v2 §7): baja home + pricing page,
 * extrae un borrador JSON CON CITAS por campo (Haiku), descubre perfiles
 * sociales / paginas a vigilar / feeds desde los links (sin LLM), y
 * opcionalmente busca evidencia externa con Sonnet + web_search.
 * El borrador NUNCA pisa datos solo: se aplica campo por campo desde la UI y
 * cada aplicacion deja procedencia (`meta`) con la cita.
 */

const PAGE_CHAR_CAP = 24_000;
const STEP_TIMEOUT_MS = 60_000;
const EVIDENCE_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 170_000;
const MIN_TEXT_CHARS = 800;

const featureCatalogText = FEATURE_CATALOG.map((f) => `${f.key} (${f.label})`).join(", ");
const weaknessThemesText = WEAKNESS_THEMES.join(", ");

const DRAFT_JSON_SHAPE =
  '{"pricing":{"visibility":"public"|"partial"|"quote_only"|"freemium"|"unknown","model":string|null,"range":string|null,' +
  '"unit":"per_room"|"per_property"|"flat"|"commission"|"freemium"|"unknown","minMonthlyUsd":number|null,"maxMonthlyUsd":number|null,"currency":string|null,' +
  '"plans":[{"name":string,"priceMonthly":number|null,"priceAnnualMonthly":number|null,"currency":string,"unit":<unidad>,"minRooms":number|null,"maxRooms":number|null,"includesRooms":number|null,"includes":string[],"notes":string,"quote":string}],' +
  '"quote":string (cita literal que respalda visibility/rango)},' +
  '"keyFeatures":string[] (máximo 8, cortas),' +
  '"featureMatrix":[{"key":<clave del catálogo>,"has":"native"|"addon"|"integration"|"no"|"unknown","quote":string}],' +
  '"statedPositioning":{"value":string|null (su propio copy de por qué elegirlos, 1-3 frases, LITERAL),"quote":string},' +
  '"taxonomy":{"productTypes":[<catálogo>],"targetSizes":["micro"|"small"|"mid"|"large"],"geoFocus":[ISO-2 o "latam"|"global"|"europe"|"north_america"],"quote":string},' +
  '"products":[{"name":string,"category":<clave del catálogo de tipos de producto>,"description":string (1 línea),"url":string|null,"pricingNote":string|null,"status":"live"|"beta"|"announced"|"discontinued","isCore":boolean}] (los productos/módulos que vende, tal como los nombra su web: menú, página de producto o solutions; máximo 12),' +
  '"segmentGuess":"global"|"latam"|"generic_lodging"|null,' +
  '"weaknessThemesGuess":string[] (claves del catálogo de temas, sólo si el texto lo sugiere),' +
  '"confidence":"high"|"medium"|"low","notes":string}';

function draftSystem(mode: "text" | "search"): string {
  const intro =
    mode === "text"
      ? "Te paso el texto de la home y de la página de precios de un software hotelero competidor."
      : "No tengo el texto del sitio del competidor (es una app sin render server-side). Usá la búsqueda web (por ejemplo `site:<dominio> pricing`, `<nombre> PMS hotel precios`) para reconstruir lo que puedas.";
  return (
    "Sos un analista de producto de bookfer (PMS + motor de reservas para alojamientos chicos en LATAM). " +
    `${intro} ` +
    `Devolvé SOLO un JSON con esta forma (sin texto extra): ${DRAFT_JSON_SHAPE}. ` +
    `Catálogo de features: ${featureCatalogText}. Catálogo de tipos de producto: ${PRODUCT_TYPES.join(", ")}. Catálogo de temas de debilidad: ${weaknessThemesText}. ` +
    "Cada `quote` es una cita LITERAL del texto (≤ 200 caracteres) que respalda el valor; si no hay cita, dejá el valor en null. " +
    "Reglas de carga de cada campo:\n" +
    glossaryForPrompt() +
    "\nSi un dato no está en el texto, usá null — no inventes precios ni planes. " +
    "Distinguí native (incluido), addon (pago extra propio) e integration (de un tercero). " +
    "Convertí precios a USD/mes sólo si la moneda es explícita (usá una tasa aproximada y anotalo en notes)."
  );
}

const EVIDENCE_SYSTEM =
  "Buscá reseñas y quejas reales sobre el producto indicado en G2, Capterra, GetApp, Software Advice, foros y redes. " +
  'Devolvé SOLO JSON: {"evidence":[{"kind":"review_g2"|"review_capterra"|"review_other"|"forum"|"web","url":string,"note":string (1 línea: qué dice)}],' +
  `"weaknessHints":[{"theme":<una de: ${weaknessThemesText}>,"text":string (qué sufre el usuario, 1 línea),"sourceUrl":string}],` +
  '"tractionSignals":string[] (funding, cantidad de reviews, presencia en directorios pagos, clientes nombrados)}. ' +
  "Máximo 6 evidencias y 8 debilidades. No inventes URLs: sólo las que visitaste.";

// ---------------------------------------------------------------------------
// Sanitizacion de lo que devuelve el modelo
// ---------------------------------------------------------------------------

function asStr(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function asNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function asInt(v: unknown): number | null {
  const n = asNum(v);
  return n == null ? null : Math.round(n);
}

function inEnum<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

const QUOTE_MAX = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeDraftFields(json: any, sourceUrl: string): AiDraftFields {
  const out: AiDraftFields = {};
  const quotes: NonNullable<AiDraftFields["quotes"]> = {};
  if (!json || typeof json !== "object") return out;

  if (json.pricing && typeof json.pricing === "object") {
    const p = json.pricing;
    const pricing: NonNullable<AiDraftFields["pricing"]> = {};
    const visibility = inEnum(p.visibility, PRICING_VISIBILITY);
    const model = asStr(p.model, 500);
    const range = asStr(p.range, 500);
    const unit = inEnum(p.unit, PRICING_UNITS);
    const min = asNum(p.minMonthlyUsd);
    const max = asNum(p.maxMonthlyUsd);
    const currency = asStr(p.currency, 10);
    if (visibility && visibility !== "unknown") pricing.visibility = visibility;
    if (model) pricing.model = model;
    if (range) pricing.range = range;
    if (unit && unit !== "unknown") pricing.unit = unit;
    if (min !== null) pricing.minMonthlyUsd = min;
    if (max !== null) pricing.maxMonthlyUsd = max;
    if (currency) pricing.currency = currency;
    if (Array.isArray(p.plans)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plans = p.plans.flatMap((pl: any): Partial<PricingPlan>[] => {
        const name = asStr(pl?.name, 120);
        const priceMonthly = asNum(pl?.priceMonthly);
        const priceAnnualMonthly = asNum(pl?.priceAnnualMonthly);
        if (!name && priceMonthly == null && priceAnnualMonthly == null) return [];
        const planUnit = inEnum(pl?.unit, PRICING_UNITS) ?? "unknown";
        const plan: Partial<PricingPlan> & { quote?: string } = {
          name: name ?? "Plan",
          priceMonthly,
          priceAnnualMonthly,
          currency: (asStr(pl?.currency, 5) ?? currency ?? "USD").toUpperCase(),
          unit: planUnit,
          minRooms: asInt(pl?.minRooms),
          maxRooms: asInt(pl?.maxRooms),
          includesRooms: asInt(pl?.includesRooms),
          includes: Array.isArray(pl?.includes) ? dedupeStrings(pl.includes.map((s: unknown) => asStr(s, 160) ?? "")).slice(0, 20) : [],
          notes: asStr(pl?.notes, 500) ?? "",
          sourceUrl,
        };
        const q = asStr(pl?.quote, QUOTE_MAX);
        if (q) plan.notes = plan.notes ? `${plan.notes} · cita: "${q}"` : `cita: "${q}"`;
        return [plan];
      });
      if (plans.length) pricing.plans = plans.slice(0, 12);
    }
    const q = asStr(p.quote, QUOTE_MAX);
    if (q) {
      quotes["pricing.visibility"] = { quote: q, sourceUrl };
      quotes["pricing.plans"] = { quote: q, sourceUrl };
      quotes["pricing.range"] = { quote: q, sourceUrl };
    }
    if (Object.keys(pricing).length) out.pricing = pricing;
  }

  if (Array.isArray(json.keyFeatures)) {
    out.keyFeatures = dedupeStrings(json.keyFeatures.map((s: unknown) => asStr(s, 120) ?? "")).slice(0, 8);
  }

  if (Array.isArray(json.featureMatrix)) {
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = json.featureMatrix.flatMap((it: any) => {
      const key = typeof it?.key === "string" && FEATURE_KEYS.includes(it.key) ? it.key : null;
      const rawHas = it?.has === "yes" ? "native" : it?.has;
      const has = inEnum(rawHas, FEATURE_HAS);
      if (!key || !has || seen.has(key)) return [];
      seen.add(key);
      const q = asStr(it?.quote, QUOTE_MAX);
      if (q) quotes[`featureMatrix.${key}`] = { quote: q, sourceUrl };
      return [{ key, has: has as FeatureHas, source: "ai_draft" as const }];
    });
    if (items.length) out.featureMatrix = items;
  }

  const sp = json.statedPositioning;
  const positioning = asStr(sp && typeof sp === "object" ? sp.value : sp, 2_000);
  if (positioning) {
    out.statedPositioning = positioning;
    const q = asStr(sp && typeof sp === "object" ? sp.quote : null, QUOTE_MAX);
    quotes.statedPositioning = { quote: q ?? positioning.slice(0, QUOTE_MAX), sourceUrl };
  }

  if (json.taxonomy && typeof json.taxonomy === "object") {
    const t = json.taxonomy;
    const productTypes = Array.isArray(t.productTypes) ? t.productTypes.map((x: unknown) => inEnum(x, PRODUCT_TYPES)).filter(Boolean) : [];
    const targetSizes = Array.isArray(t.targetSizes) ? t.targetSizes.map((x: unknown) => inEnum(x, TARGET_SIZES)).filter(Boolean) : [];
    const geoFocus = Array.isArray(t.geoFocus)
      ? dedupeStrings(t.geoFocus.map((x: unknown) => (asStr(x, 20) ?? "").toLowerCase())).filter((g) => /^[a-z]{2}$|^(latam|global|europe|north_america|asia|africa)$/.test(g))
      : [];
    if (productTypes.length || targetSizes.length || geoFocus.length) {
      out.taxonomy = {
        productTypes: Array.from(new Set(productTypes)) as AiDraftFields["taxonomy"] extends infer T ? T extends { productTypes?: infer P } ? P : never : never,
        targetSizes: Array.from(new Set(targetSizes)) as AiDraftFields["taxonomy"] extends infer T ? T extends { targetSizes?: infer S } ? S : never : never,
        geoFocus,
      };
      const q = asStr(t.quote, QUOTE_MAX);
      if (q) {
        quotes.productTypes = { quote: q, sourceUrl };
        quotes.targetSizes = { quote: q, sourceUrl };
        quotes.geoFocus = { quote: q, sourceUrl };
      }
    }
  }

  if (Array.isArray(json.products)) {
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = json.products.flatMap((p: any) => {
      const name = asStr(p?.name, 120);
      if (!name || seen.has(name.toLowerCase())) return [];
      seen.add(name.toLowerCase());
      return [{
        name,
        category: inEnum(p?.category, PRODUCT_TYPES) ?? "other",
        description: asStr(p?.description, 400) ?? "",
        url: asStr(p?.url, 2_000) ?? "",
        pricingNote: asStr(p?.pricingNote, 200) ?? "",
        status: inEnum(p?.status, PRODUCT_STATUSES) ?? "live",
        isCore: p?.isCore === true,
      }];
    });
    if (items.length) out.products = items.slice(0, 12);
  }
  const seg = inEnum(json.segmentGuess, COMPETITOR_SEGMENTS);
  if (seg) out.segmentGuess = seg;
  if (Array.isArray(json.weaknessThemesGuess)) {
    const themes = json.weaknessThemesGuess
      .map((t: unknown) => inEnum(t, WEAKNESS_THEMES))
      .filter((t: unknown): t is WeaknessTheme => Boolean(t));
    if (themes.length) out.weaknessThemesGuess = Array.from(new Set(themes));
  }
  const notes = asStr(json.notes, 2_000);
  if (notes) out.notes = notes;
  if (Object.keys(quotes).length) out.quotes = quotes;
  return out;
}

const EVIDENCE_KIND_MAP: Record<string, EvidenceKind> = {
  g2: "review_g2",
  capterra: "review_capterra",
  getapp: "review_other",
  software_advice: "review_other",
  softwareadvice: "review_other",
  review: "review_other",
  reviews: "review_other",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeEvidenceFields(json: any): AiDraftFields {
  const out: AiDraftFields = {};
  if (!json || typeof json !== "object") return out;
  if (Array.isArray(json.evidence)) {
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.evidence = json.evidence.flatMap((e: any) => {
      const url = asStr(e?.url, 2_000);
      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return [];
      seen.add(url);
      const rawKind = typeof e?.kind === "string" ? e.kind.toLowerCase() : "";
      const kind: EvidenceKind = inEnum(rawKind, EVIDENCE_KINDS) ?? EVIDENCE_KIND_MAP[rawKind] ?? "web";
      return [{ kind, url, note: asStr(e?.note, 300) ?? "" }];
    }).slice(0, 6);
  }
  if (Array.isArray(json.weaknessHints)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hints = json.weaknessHints.flatMap((h: any) => {
      const text = asStr(h?.text, 500);
      if (!text) return [];
      const theme = inEnum(h?.theme, WEAKNESS_THEMES) ?? "other";
      return [{ theme, text, sourceUrl: asStr(h?.sourceUrl, 2_000) ?? "" }];
    }).slice(0, 8);
    if (hints.length) {
      out.weaknessHints = hints.map((h: { text: string; sourceUrl: string }) => ({ text: h.text, sourceUrl: h.sourceUrl }));
      out.weaknesses = hints.map((h: { theme: WeaknessTheme; text: string; sourceUrl: string }) => ({ theme: h.theme, note: h.text, evidenceUrl: h.sourceUrl }));
    }
  }
  if (Array.isArray(json.tractionSignals)) {
    out.tractionSignals = dedupeStrings(json.tractionSignals.map((s: unknown) => asStr(s, 200) ?? "")).slice(0, 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Descubrimiento de perfiles sociales, paginas a vigilar y feeds (sin LLM)
// ---------------------------------------------------------------------------

const SOCIAL_PATTERNS: Array<{ network: SocialNetwork; re: RegExp; handleGroup: number; exclude?: RegExp; external?: boolean }> = [
  { network: "instagram", re: /instagram\.com\/([A-Za-z0-9_.]{2,})/i, handleGroup: 1, exclude: /^(p|reel|reels|explore|accounts|stories|share)$/i },
  { network: "linkedin", re: /linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i, handleGroup: 1 },
  { network: "x", re: /(?:twitter|x)\.com\/([A-Za-z0-9_]{2,})/i, handleGroup: 1, exclude: /^(intent|share|home|i|search|hashtag|login|signup)$/i },
  { network: "facebook", re: /facebook\.com\/([^/?#]+)/i, handleGroup: 1, exclude: /^(sharer|sharer\.php|share\.php|dialog|login|plugins|tr|pages|profile\.php|photo\.php|events|groups|hashtag)$/i },
  { network: "tiktok", re: /tiktok\.com\/@([^/?#]+)/i, handleGroup: 1 },
  { network: "youtube", re: /youtube\.com\/(?:@([^/?#]+)|channel\/([^/?#]+)|c\/([^/?#]+)|user\/([^/?#]+))/i, handleGroup: 0 },
  { network: "producthunt", re: /producthunt\.com\/(?:products|posts)\/([^/?#]+)/i, handleGroup: 1 },
  { network: "app_store", re: /apps\.apple\.com\/[^\s"']*?\/id(\d{6,})/i, handleGroup: 1, external: true },
  { network: "google_play", re: /play\.google\.com\/store\/apps\/details\?(?:[^"'\s]*&)?id=([A-Za-z0-9_.]+)/i, handleGroup: 1, external: true },
  { network: "g2", re: /g2\.com\/products\/([^/?#]+)/i, handleGroup: 1 },
  { network: "capterra", re: /capterra\.[a-z.]+\/(?:p|software)\/([^/?#]+)/i, handleGroup: 1 },
  { network: "getapp", re: /getapp\.[a-z.]+\/[^/?#]+\/[^/?#]+\/([^/?#]+)/i, handleGroup: 1 },
];

const PAGE_PATTERNS: Array<{ kind: WatchedPageKind; re: RegExp }> = [
  { kind: "pricing", re: /pricing|precios?|planes|plans|tarifas|pre[cç]os/i },
  { kind: "changelog", re: /changelog|release[-_ ]?notes|releases|what'?s[-_ ]?new|novedades[-_ ]?(de[-_ ]?)?producto|product[-_ ]?updates|updates/i },
  { kind: "careers", re: /careers|jobs|empleos?|trabaja|talento|join[-_ ]?us|vacantes|hiring|sumate|trabalhe/i },
  { kind: "features", re: /features|funcionalidades|caracter[ií]sticas|producto|product|soluciones|solutions|modulos|m[óo]dulos/i },
  { kind: "blog", re: /blog|novedades|noticias|news|recursos|resources|articulos|art[íi]culos/i },
];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function discoverFromLinks(
  links: { href: string; text: string }[],
  homeUrl: string,
  html: string,
): { socialProfiles: AiDraftFields["socialProfiles"]; watchedPages: AiDraftFields["watchedPages"]; feeds: string[] } {
  const host = hostOf(homeUrl);
  const profiles: NonNullable<AiDraftFields["socialProfiles"]> = [];
  const seenProfiles = new Set<string>();
  const pages: NonNullable<AiDraftFields["watchedPages"]> = [];
  const seenKinds = new Set<string>();

  for (const l of links) {
    const href = l.href;
    for (const p of SOCIAL_PATTERNS) {
      const m = p.re.exec(href);
      if (!m) continue;
      let handle = "";
      if (p.network === "youtube") handle = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
      else handle = m[p.handleGroup] ?? "";
      handle = handle.replace(/\/+$/, "");
      if (!handle || (p.exclude && p.exclude.test(handle))) continue;
      const key = `${p.network}:${handle.toLowerCase()}`;
      if (seenProfiles.has(key)) continue;
      seenProfiles.add(key);
      let cleanUrl = href;
      try {
        const u = new URL(href);
        u.search = p.network === "google_play" ? `?id=${handle}` : "";
        u.hash = "";
        cleanUrl = u.toString();
      } catch {
        // se deja la original
      }
      profiles.push({
        network: p.network,
        handle: p.external ? "" : handle,
        externalId: p.external ? handle : "",
        url: cleanUrl,
        discoveredBy: "ai_draft",
        status: "candidate",
      });
      break;
    }
    if (hostOf(href) !== host) continue;
    let path = "";
    try {
      path = new URL(href).pathname;
    } catch {
      continue;
    }
    if (!path || path === "/") continue;
    // Una URL alimenta un solo kind: /product-updates/ es changelog, no tambien "features".
    if (pages.some((p) => p.url === href)) continue;
    for (const pp of PAGE_PATTERNS) {
      if (seenKinds.has(pp.kind)) continue;
      if (pp.re.test(path) || pp.re.test(l.text)) {
        seenKinds.add(pp.kind);
        pages.push({ kind: pp.kind, url: href, cadence: pp.kind === "pricing" || pp.kind === "changelog" ? "weekly" : "monthly" });
        break;
      }
    }
  }

  const feeds: string[] = [];
  const feedRe = /<link\b[^>]*rel=["']alternate["'][^>]*>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = feedRe.exec(html)) && feeds.length < 5) {
    const tag = fm[0];
    if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
    const hm = /href=["']([^"']+)["']/i.exec(tag);
    if (!hm) continue;
    try {
      feeds.push(new URL(hm[1], homeUrl).toString());
    } catch {
      // href invalido
    }
  }
  if (feeds.length) {
    const blog = pages.find((p) => p.kind === "blog" || p.kind === "changelog");
    if (blog) blog.feedUrl = feeds[0];
    else pages.push({ kind: "blog", url: feeds[0], feedUrl: feeds[0], cadence: "weekly" });
  }
  return { socialProfiles: profiles, watchedPages: pages, feeds };
}

// ---------------------------------------------------------------------------
// Ejecucion
// ---------------------------------------------------------------------------

function cap(text: string | undefined): string {
  const t = text ?? "";
  return t.length > PAGE_CHAR_CAP ? `${t.slice(0, PAGE_CHAR_CAP)} […recortado]` : t;
}

function buildDraftUser(name: string, website: string, home: PageResult, pricing: PageResult | null): string {
  return (
    `Competidor: ${name}\nSitio: ${website}\n\n` +
    `=== HOME (${home.finalUrl}) ===\n${cap(home.text)}\n\n` +
    (pricing
      ? `=== PRICING (${pricing.finalUrl}) ===\n${cap(pricing.text)}\n`
      : "=== PRICING ===\n(no se encontró página de precios)\n")
  );
}

async function persistDraft(competitorId: string, draft: AiDraft) {
  await Competitor.updateOne({ competitorId }, { $set: { aiDraft: draft } });
}

export async function startDraft(
  competitorId: string,
  opts: { includeEvidence: boolean; userId: string | null },
) {
  if (!aiAvailable()) {
    throw new CiError(503, "IA no disponible: falta ANTHROPIC_API_KEY", "ai_unavailable");
  }
  const doc = await Competitor.findOne({ competitorId });
  if (!doc) throw new CiError(404, "Competidor no encontrado", "not_found");
  const current = doc.aiDraft as AiDraft | null;
  if (current?.status === "running" && Date.now() - new Date(current.requestedAt).getTime() < 5 * 60_000) {
    throw new CiError(409, "Ya hay un borrador en curso para este competidor", "draft_in_progress");
  }
  const draft: AiDraft = {
    status: "running",
    requestedAt: new Date(),
    finishedAt: null,
    requestedByUserId: opts.userId,
    errorMessage: null,
    includeEvidence: opts.includeEvidence,
    model: draftModel(),
    evidenceModel: opts.includeEvidence ? evidenceModel() : null,
    sources: [],
    warnings: [],
    confidence: "low",
    fields: {},
    usage: emptyUsage(),
    appliedFields: [],
    appliedAt: null,
  };
  await persistDraft(competitorId, draft);

  void withTimeout(executeDraft(competitorId, draft), TOTAL_TIMEOUT_MS, "ai-draft").catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[competitors] borrador ${competitorId} falló:`, msg);
    await persistDraft(competitorId, { ...draft, status: "error", finishedAt: new Date(), errorMessage: msg }).catch(() => undefined);
  });

  return { status: "running" as const };
}

async function executeDraft(competitorId: string, draft: AiDraft): Promise<void> {
  const doc = await Competitor.findOne({ competitorId }).lean();
  if (!doc) return;
  const name: string = doc.name;
  const website: string = doc.website;
  const domain: string = doc.websiteDomain;

  const sources: AiDraft["sources"] = [];
  const warnings: string[] = [];
  const fields: AiDraftFields = {};
  let usage: LlmUsageRecord = emptyUsage();
  let confidence: Confidence = "medium";

  try {
    const home = await fetchPage(website);
    sources.push({ kind: "home", url: home.finalUrl, chars: home.text.length, ok: home.ok });
    if (!home.ok && home.error) warnings.push(`home_${home.error}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pricingUrl: string | null = (doc.pricing as any)?.pricingUrl || null;
    let pricing: PageResult | null = null;
    if (!pricingUrl && home.ok) pricingUrl = await discoverPricingUrl(home);
    if (pricingUrl) {
      pricing = await fetchPage(pricingUrl);
      sources.push({ kind: "pricing", url: pricing.finalUrl, chars: pricing.text.length, ok: pricing.ok });
      if (!pricing.ok) warnings.push("pricing_page_unavailable");
    } else {
      warnings.push("pricing_page_not_found");
    }

    // Descubrimiento sin LLM: perfiles sociales, paginas a vigilar, feeds.
    if (home.ok) {
      const links = [...home.links, ...(pricing?.ok ? pricing.links : [])];
      const found = discoverFromLinks(links, home.finalUrl, home.html);
      if (found.socialProfiles?.length) fields.socialProfiles = found.socialProfiles;
      const pages = found.watchedPages ?? [];
      if (pricingUrl && !pages.some((p) => p.kind === "pricing")) pages.unshift({ kind: "pricing", url: pricingUrl, cadence: "weekly" });
      if (pages.length) fields.watchedPages = pages;
    }

    const totalChars = home.text.length + (pricing?.text.length ?? 0);
    const srcUrl = pricing?.ok ? pricing.finalUrl : home.finalUrl;
    if (totalChars < MIN_TEXT_CHARS) {
      warnings.push("site_js_rendered");
      const r = await callJson({
        model: evidenceModel(),
        system: draftSystem("search"),
        user: `Producto: ${name}\nDominio: ${domain}\nSitio: ${website}\n\nDevolvé el JSON.`,
        webSearch: { maxUses: 2 },
        maxTokens: 3_500,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      usage = addUsage(usage, r.usage);
      if (r.stopReason === "max_tokens") warnings.push("draft_truncated");
      sources.push({ kind: "web_search", url: `site:${domain}`, chars: r.text.length, ok: Boolean(r.json) });
      if (r.json) mergeFields(fields, sanitizeDraftFields(r.json, `web_search:site:${domain}`));
      else warnings.push("draft_parse_failed");
      confidence = "low";
    } else {
      const r = await callJson({
        model: draftModel(),
        system: draftSystem("text"),
        user: buildDraftUser(name, website, home, pricing?.ok ? pricing : null),
        maxTokens: 4_000,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      usage = addUsage(usage, r.usage);
      if (r.stopReason === "max_tokens") warnings.push("draft_truncated");
      if (r.json) {
        mergeFields(fields, sanitizeDraftFields(r.json, srcUrl));
        confidence = inEnum(r.json.confidence, CONFIDENCES) ?? "medium";
      } else {
        warnings.push("draft_parse_failed");
        confidence = "low";
      }
    }

    if (pricingUrl) fields.pricing = { ...(fields.pricing ?? {}), pricingUrl };

    if (draft.includeEvidence) {
      try {
        const e = await callJson({
          model: evidenceModel(),
          system: EVIDENCE_SYSTEM,
          user: `Producto: ${name}\nDominio: ${domain}\nSitio: ${website}\n\nDevolvé el JSON.`,
          webSearch: { maxUses: 4 },
          maxTokens: 1_800,
          timeoutMs: EVIDENCE_TIMEOUT_MS,
        });
        usage = addUsage(usage, e.usage);
        if (e.json) mergeFields(fields, sanitizeEvidenceFields(e.json));
        else warnings.push("evidence_parse_failed");
      } catch (err) {
        warnings.push("evidence_failed");
        console.warn(`[competitors] evidencia ${competitorId} falló:`, (err as Error)?.message);
      }
    }

    await persistDraft(competitorId, { ...draft, status: "ready", finishedAt: new Date(), sources, warnings, confidence, fields, usage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await persistDraft(competitorId, { ...draft, status: "error", finishedAt: new Date(), errorMessage: msg, sources, warnings, fields, usage });
  }
}

function mergeFields(target: AiDraftFields, add: AiDraftFields) {
  for (const [k, v] of Object.entries(add)) {
    if (v === undefined || v === null) continue;
    if (k === "quotes") {
      target.quotes = { ...(target.quotes ?? {}), ...(v as NonNullable<AiDraftFields["quotes"]>) };
      continue;
    }
    if (k === "pricing") {
      target.pricing = { ...(target.pricing ?? {}), ...(v as object) };
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (target as any)[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Aplicar / descartar
// ---------------------------------------------------------------------------

export async function applyDraft(competitorId: string, fieldsToApply: string[], userId: string | null) {
  const doc = await loadDoc(competitorId);
  const draft = doc.aiDraft as AiDraft | null;
  if (!draft || draft.status !== "ready") {
    throw new CiError(409, "No hay un borrador listo para aplicar", "draft_not_ready");
  }
  const wanted = new Set(fieldsToApply.filter((f) => (AI_DRAFT_APPLY_FIELDS as readonly string[]).includes(f)));
  const f = draft.fields ?? {};
  const quotes = f.quotes ?? {};
  const applied: string[] = [];
  const aiMeta = (path: string, sourceUrl?: string) =>
    setMeta(doc, path, makeMeta("ai_draft", {
      confidence: draft.confidence,
      sourceUrl: sourceUrl ?? quotes[path]?.sourceUrl ?? draft.sources.find((s) => s.ok)?.url ?? "",
      quote: quotes[path]?.quote ?? "",
      userId,
    }));

  await mutateAndRecord(
    doc,
    () => {
      if (wanted.has("pricing") && f.pricing) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const current = (doc.pricing as any)?.toObject?.() ?? doc.pricing ?? {};
        const next = { ...current };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { plans, normalized: _n, ...scalars } = f.pricing;
        for (const [k, v] of Object.entries(scalars)) {
          if (v === null || v === undefined || v === "") continue;
          if (k === "unit" && v === "unknown") continue;
          if (k === "visibility" && v === "unknown") continue;
          next[k] = v;
        }
        if (Array.isArray(plans) && plans.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const existing: any[] = Array.isArray(current.plans) ? current.plans : [];
          const byName = new Map(existing.map((p) => [String(p.name ?? "").toLowerCase(), p]));
          for (const p of plans) {
            const key = String(p.name ?? "").toLowerCase();
            const row = {
              planId: makeId("plan"),
              name: p.name ?? "Plan",
              priceMonthly: p.priceMonthly ?? null,
              priceAnnualMonthly: p.priceAnnualMonthly ?? null,
              currency: p.currency ?? "USD",
              unit: p.unit ?? "unknown",
              minRooms: p.minRooms ?? null,
              maxRooms: p.maxRooms ?? null,
              includesRooms: p.includesRooms ?? null,
              includes: p.includes ?? [],
              notes: p.notes ?? "",
              sourceUrl: p.sourceUrl ?? "",
              observedAt: new Date(),
            };
            if (byName.has(key)) byName.set(key, { ...byName.get(key), ...row, planId: byName.get(key).planId });
            else byName.set(key, row);
          }
          next.plans = Array.from(byName.values());
          aiMeta("pricing.plans");
        }
        doc.set("pricing", next);
        if (scalars.visibility) aiMeta("pricing.visibility");
        if (scalars.range || scalars.minMonthlyUsd != null || scalars.maxMonthlyUsd != null) aiMeta("pricing.range");
        applied.push("pricing");
      }
      if (wanted.has("keyFeatures") && f.keyFeatures?.length) {
        doc.set("keyFeatures", dedupeStrings([...(doc.keyFeatures ?? []), ...f.keyFeatures]));
        aiMeta("keyFeatures");
        applied.push("keyFeatures");
      }
      if (wanted.has("featureMatrix") && f.featureMatrix?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const current: any[] = (doc.featureMatrix as any[]).map((x) => (typeof x.toObject === "function" ? x.toObject() : { ...x }));
        const byKey = new Map(current.map((x) => [x.key, x]));
        for (const it of f.featureMatrix) {
          const prev = byKey.get(it.key);
          const has = it.has === ("yes" as unknown as FeatureHas) ? "native" : it.has;
          // Solo completa huecos: no pisa un valor ya curado a mano.
          if (!prev) {
            byKey.set(it.key, { key: it.key, has, note: "", evidenceUrl: quotes[`featureMatrix.${it.key}`]?.sourceUrl ?? "", verifiedAt: null, source: "ai_draft" });
            aiMeta(`featureMatrix.${it.key}`);
          } else if (prev.has === "unknown") {
            prev.has = has;
            prev.source = "ai_draft";
            aiMeta(`featureMatrix.${it.key}`);
          }
        }
        doc.set("featureMatrix", Array.from(byKey.values()));
        applied.push("featureMatrix");
      }
      if (wanted.has("statedPositioning") && f.statedPositioning) {
        doc.statedPositioning = f.statedPositioning;
        aiMeta("statedPositioning");
        applied.push("statedPositioning");
      }
      if (wanted.has("segment") && f.segmentGuess) {
        doc.segment = f.segmentGuess;
        aiMeta("segment");
        applied.push("segment");
      }
      if (wanted.has("taxonomy") && f.taxonomy) {
        if (f.taxonomy.productTypes?.length) {
          doc.set("productTypes", dedupeStrings([...(doc.productTypes ?? []), ...f.taxonomy.productTypes]));
          aiMeta("productTypes");
        }
        if (f.taxonomy.targetSizes?.length) {
          doc.set("targetSizes", dedupeStrings([...(doc.targetSizes ?? []), ...f.taxonomy.targetSizes]));
          aiMeta("targetSizes");
        }
        if (f.taxonomy.geoFocus?.length) {
          doc.set("geoFocus", dedupeStrings([...(doc.geoFocus ?? []), ...f.taxonomy.geoFocus]).map((g) => g.toLowerCase()));
          aiMeta("geoFocus");
        }
        applied.push("taxonomy");
      }
      if (wanted.has("weaknessThemes") && f.weaknessThemesGuess?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const have = new Set((doc.weaknesses as any[]).map((w) => w.theme));
        for (const theme of f.weaknessThemesGuess) {
          if (have.has(theme)) continue;
          const weaknessId = makeId("weak");
          doc.weaknesses.push({ weaknessId, theme, note: "", evidenceUrl: "", source: "ai_draft", addedAt: new Date(), addedByUserId: userId });
          aiMeta(`weaknesses.${weaknessId}`);
        }
        applied.push("weaknessThemes");
      }
      if (wanted.has("weaknesses") && f.weaknesses?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const known = new Set((doc.weaknesses as any[]).map((w) => `${w.theme}|${(w.evidenceUrl || w.note || "").toLowerCase()}`));
        for (const w of f.weaknesses) {
          const key = `${w.theme}|${(w.evidenceUrl || w.note || "").toLowerCase()}`;
          if (known.has(key)) continue;
          known.add(key);
          const weaknessId = makeId("weak");
          doc.weaknesses.push({ weaknessId, theme: w.theme, note: w.note, evidenceUrl: w.evidenceUrl, source: "ai_draft", addedAt: new Date(), addedByUserId: userId });
          setMeta(doc, `weaknesses.${weaknessId}`, makeMeta("ai_draft", { confidence: draft.confidence, sourceUrl: w.evidenceUrl, quote: w.note, userId }));
        }
        applied.push("weaknesses");
      }
      if (wanted.has("evidence") && f.evidence?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const known = new Set((doc.evidence as any[]).map((e) => e.url).filter(Boolean));
        for (const e of f.evidence) {
          if (!e.url || known.has(e.url)) continue;
          known.add(e.url);
          doc.evidence.push({ evidenceId: makeId("ev"), kind: e.kind, url: e.url, note: e.note ?? "", addedAt: new Date(), addedByUserId: userId });
        }
        applied.push("evidence");
      }
      if (wanted.has("products") && f.products?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing: any[] = doc.products as any[];
        const known = new Set(existing.map((p) => String(p.name).trim().toLowerCase()));
        for (const p of f.products) {
          const key = String(p.name ?? "").trim().toLowerCase();
          if (!key || known.has(key)) continue;
          known.add(key);
          const productId = makeId("prod");
          existing.push({ productId, name: p.name, category: p.category ?? "other", description: p.description ?? "", url: p.url ?? "", pricingNote: p.pricingNote ?? "", status: p.status ?? "live", isCore: Boolean(p.isCore), source: "ai_draft", evidenceUrl: p.url ?? "", addedAt: new Date(), addedByUserId: userId });
          setMeta(doc, `products.${productId}`, makeMeta("ai_draft", { confidence: draft.confidence, sourceUrl: p.url ?? "", userId }));
        }
        doc.markModified("products");
        applied.push("products");
      }
      if (wanted.has("socialProfiles") && f.socialProfiles?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing: any[] = doc.socialProfiles as any[];
        const known = new Set(existing.map((p) => `${p.network}:${(p.handle || p.externalId || p.url || "").toLowerCase()}`));
        for (const p of f.socialProfiles) {
          const key = `${p.network}:${(p.handle || p.externalId || p.url || "").toLowerCase()}`;
          if (!p.network || known.has(key)) continue;
          known.add(key);
          const profileId = makeId("sp");
          existing.push({
            profileId,
            network: p.network,
            handle: p.handle ?? "",
            url: p.url ?? "",
            externalId: p.externalId ?? "",
            discoveredBy: "ai_draft",
            status: "candidate",
            lastCheckedAt: null,
            lastOkAt: null,
            latest: {},
          });
          setMeta(doc, `socialProfiles.${profileId}`, makeMeta("ai_draft", { confidence: "medium", sourceUrl: p.url ?? "", userId }));
        }
        doc.markModified("socialProfiles");
        applied.push("socialProfiles");
      }
      if (wanted.has("watchedPages") && f.watchedPages?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing: any[] = doc.watchedPages as any[];
        const knownUrls = new Set(existing.map((p) => String(p.url)));
        for (const p of f.watchedPages) {
          const url = normalizeUrl(p.url ?? "");
          if (!url || knownUrls.has(url)) continue;
          knownUrls.add(url);
          existing.push({
            pageId: makeId("wp"),
            kind: p.kind ?? "custom",
            url,
            feedUrl: p.feedUrl ?? null,
            cadence: p.cadence ?? "weekly",
            status: "active",
            lastHash: null,
            lastCheckedAt: null,
            lastChangedAt: null,
          });
          if (p.kind === "pricing" && !doc.pricing?.pricingUrl) doc.set("pricing.pricingUrl", url);
        }
        doc.markModified("watchedPages");
        applied.push("watchedPages");
      }
      doc.set("aiDraft", { ...draft, status: "applied", appliedFields: applied, appliedAt: new Date() });
      doc.markModified("aiDraft");
    },
    { source: "ai_draft", userId },
  );

  const staleDays = await getStaleDays();
  return decorateCompetitor(doc, staleDays);
}

export async function discardDraft(competitorId: string, userId: string | null) {
  const doc = await Competitor.findOne({ competitorId });
  if (!doc) throw new CiError(404, "Competidor no encontrado", "not_found");
  const draft = doc.aiDraft as AiDraft | null;
  if (draft && draft.status !== "running") {
    doc.set("aiDraft", { ...draft, status: "discarded" });
    doc.markModified("aiDraft");
    doc.updatedByUserId = userId;
    await doc.save();
  }
  const staleDays = await getStaleDays();
  return decorateCompetitor(doc, staleDays);
}

// Reexport util para el motor de senales (descubrimiento de feeds en paginas blog).
export { domainOf };
