import { callJson, emptyUsage } from "../ciLlm";
import {
  FEATURE_CATALOG,
  FEATURE_HAS,
  FEATURE_KEYS,
  SEVERITIES,
  SIGNAL_EVENT_KINDS,
  type FeatureHas,
  type LlmUsageRecord,
  type Severity,
  type SignalEventKind,
} from "../competitors.model";

/**
 * Clasificador Haiku de contenido (spec v2 §6): un post / release note /
 * cambio de pagina → kind, severidad, resumen en espanol, features del
 * catalogo que menciona y, si anuncia una feature, con que grado.
 */

export const signalsModel = () => process.env.CI_SIGNALS_MODEL ?? process.env.CI_DRAFT_MODEL ?? "claude-haiku-4-5-20251001";

const featureCatalogText = FEATURE_CATALOG.map((f) => `${f.key} (${f.label})`).join(", ");

const CONTENT_EVENT_SYSTEM =
  "Sos un analista de competencia de bookfer (PMS + motor de reservas para alojamientos chicos en LATAM). " +
  "Te paso un contenido publicado por un competidor (post de blog, nota de changelog, notas de una versión de app, cambio en una página). " +
  'Devolvé SOLO JSON: {"kind":"launch"|"feature_announce"|"pricing_change"|"page_change"|"funding"|"press"|"hiring_spike"|"other",' +
  '"severity":"low"|"medium"|"high","summary":string (1-2 líneas, español, qué cambió y por qué importa),' +
  `"featureKeys":[claves del catálogo que el contenido anuncia o mejora],"suggestFeatureHas":"native"|"addon"|"integration"|null,"material":boolean}. ` +
  `Catálogo de features: ${featureCatalogText}. ` +
  "material=false si es ruido (fechas, cookies, textos legales, testimonios rotativos, posts genéricos de marketing sin anuncio). " +
  "severity high = lanzamiento de producto/feature núcleo, cambio de precios o funding; medium = feature secundaria o integración; low = contenido editorial.";

/** Tope de features que un solo contenido puede proponer para la matriz. */
export const MAX_FEATURE_SUGGESTIONS = 3;

/**
 * ¿Este contenido justifica tocar la matriz de features?
 *
 * Sólo un ANUNCIO puntual la mueve. Un cambio de precios enumera todo lo que
 * incluye cada plan: si eso propusiera una feature por ítem, una sola corrida
 * dejaría doce sugerencias que nadie va a triagear (visto en la prueba real).
 */
export function shouldSuggestFeatures(kind: SignalEventKind, featureKeys: string[]): boolean {
  if (!featureKeys.length || featureKeys.length > MAX_FEATURE_SUGGESTIONS) return false;
  return kind === "feature_announce" || kind === "launch" || kind === "app_release";
}

export interface ContentClassification {
  kind: SignalEventKind;
  severity: Severity;
  summary: string;
  featureKeys: string[];
  suggestFeatureHas: FeatureHas | null;
  material: boolean;
}

function inEnum<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

export async function classifyContent(input: {
  competitorName: string;
  kindHint: "blog_post" | "changelog" | "release_notes" | "page_change" | "video" | "news";
  title: string;
  body: string;
  sourceUrl?: string;
  /**
   * Tope de caracteres del cuerpo. 4k alcanza para un post; un diff de página
   * lleva "antes" + "después" y necesita bastante más, o el modelo juzga sobre
   * la mitad del texto (y todo cambio parece inmaterial).
   */
  maxChars?: number;
}): Promise<{ result: ContentClassification | null; usage: LlmUsageRecord }> {
  const body = (input.body ?? "").slice(0, input.maxChars ?? 4_000);
  try {
    const r = await callJson({
      model: signalsModel(),
      system: CONTENT_EVENT_SYSTEM,
      user:
        `Competidor: ${input.competitorName}\nTipo: ${input.kindHint}\nTítulo: ${input.title}\n` +
        (input.sourceUrl ? `URL: ${input.sourceUrl}\n` : "") +
        `\n=== CONTENIDO ===\n${body}\n\nDevolvé el JSON.`,
      maxTokens: 500,
      timeoutMs: 45_000,
    });
    if (!r.json) return { result: null, usage: r.usage };
    const kind = inEnum(r.json.kind, SIGNAL_EVENT_KINDS) ?? "other";
    const severity = inEnum(r.json.severity, SEVERITIES) ?? "low";
    const featureKeys = Array.isArray(r.json.featureKeys)
      ? r.json.featureKeys.filter((k: unknown) => typeof k === "string" && FEATURE_KEYS.includes(k))
      : [];
    return {
      result: {
        kind,
        severity,
        summary: typeof r.json.summary === "string" ? r.json.summary.slice(0, 600) : "",
        featureKeys: Array.from(new Set(featureKeys)),
        suggestFeatureHas: inEnum(r.json.suggestFeatureHas, FEATURE_HAS),
        material: r.json.material !== false,
      },
      usage: r.usage,
    };
  } catch (err) {
    console.warn("[competitors] clasificador de contenido falló:", (err as Error)?.message);
    return { result: null, usage: emptyUsage() };
  }
}

const CAREERS_SYSTEM =
  "Te paso el texto de la página de empleos/carreras de una empresa de software hotelero. " +
  'Devolvé SOLO JSON: {"openRoles":number (cantidad de posiciones abiertas que se listan; 0 si ninguna; null si el texto no es una página de empleos),' +
  '"areas":{"engineering":number,"sales":number,"support":number,"marketing":number,"product":number,"other":number},"notes":string}';

export async function countOpenRoles(input: { competitorName: string; text: string }): Promise<{ openRoles: number | null; areas: Record<string, number>; usage: LlmUsageRecord }> {
  try {
    const r = await callJson({
      model: signalsModel(),
      system: CAREERS_SYSTEM,
      user: `Competidor: ${input.competitorName}\n\n=== CAREERS ===\n${(input.text ?? "").slice(0, 12_000)}\n\nDevolvé el JSON.`,
      maxTokens: 300,
      timeoutMs: 45_000,
    });
    const n = r.json?.openRoles;
    return {
      openRoles: typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null,
      areas: r.json?.areas && typeof r.json.areas === "object" ? r.json.areas : {},
      usage: r.usage,
    };
  } catch (err) {
    return { openRoles: null, areas: {}, usage: emptyUsage() };
  }
}
