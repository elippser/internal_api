import { addUsage, emptyUsage } from "../../ciLlm";
import type { LlmUsageRecord } from "../../competitors.model";
import { classifyContent, shouldSuggestFeatures } from "../contentClassifier";
import {
  emptyResult,
  fetchJsonPublic,
  type ProfileUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type SuggestionDraft,
} from "./types";

/**
 * Connector `app_store` (spec v2 §5): iTunes Lookup API (oficial, sin key).
 * Perfiles network app_store con externalId (trackId) o url con /id<digits>.
 */

interface LookupResult {
  resultCount: number;
  results: Array<{
    trackId: number;
    trackName: string;
    trackViewUrl: string;
    averageUserRating?: number;
    userRatingCount?: number;
    version?: string;
    currentVersionReleaseDate?: string;
    releaseNotes?: string;
    sellerName?: string;
  }>;
}

function trackIdOf(p: { externalId?: string; url?: string }): string | null {
  if (p.externalId && /^\d{6,}$/.test(p.externalId)) return p.externalId;
  const m = /\/id(\d{6,})/.exec(p.url ?? "");
  return m ? m[1] : null;
}

/**
 * Storefront a consultar. Las calificaciones son POR PAIS: la tienda argentina
 * suele devolver 0 reseñas para un producto global. Se usa el país de la URL
 * del perfil y, si no lo trae, la tienda de EE.UU. (la de mayor volumen).
 */
function countryOf(p: { url?: string }): string {
  const m = /apps\.apple\.com\/([a-z]{2})\//i.exec(p.url ?? "");
  return (m?.[1] ?? "us").toLowerCase();
}

export const appStoreConnector: SignalConnector = {
  id: "app_store",
  label: "App Store (iTunes Lookup)",
  paid: false, // Haiku solo en release notes nuevas (se respeta allowPaid para eso)
  accepts: { networks: ["app_store"] },
  async healthCheck() {
    return { ok: true, detail: "API pública de Apple, sin key" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    let usage: LlmUsageRecord = emptyUsage();
    const profiles = ctx.profiles.filter((p) => p.network === "app_store" && p.status === "confirmed");
    if (!profiles.length) return emptyResult(usage, { skipped: "sin app de App Store confirmada" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const suggestions: SuggestionDraft[] = [];
    const profileUpdates: ProfileUpdate[] = [];
    const now = new Date();
    const thr = ctx.settings.signals.thresholds.ratingDropAbs;

    for (const p of profiles) {
      const id = trackIdOf(p);
      if (!id) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      const country = countryOf(p);
      let r = await fetchJsonPublic<LookupResult>(`https://itunes.apple.com/lookup?id=${id}&country=${country}`);
      let app = r.json?.results?.[0];
      // Sin reseñas en esa tienda: se reintenta en la de EE.UU. antes de dar el dato por vacío.
      if (app && !app.userRatingCount && country !== "us") {
        const us = await fetchJsonPublic<LookupResult>(`https://itunes.apple.com/lookup?id=${id}&country=us`);
        if (us.json?.results?.[0]?.userRatingCount) {
          r = us;
          app = us.json.results[0];
        }
      }
      if (!r.ok || !app) {
        profileUpdates.push({ profileId: p.profileId, status: r.status === 200 ? "unavailable" : p.status });
        continue;
      }
      const url = app.trackViewUrl || p.url;
      const rating = typeof app.averageUserRating === "number" ? Math.round(app.averageUserRating * 100) / 100 : null;
      const reviews = typeof app.userRatingCount === "number" ? app.userRatingCount : null;
      if (rating !== null) signals.push({ profileId: p.profileId, network: "app_store", metric: "rating", value: rating, unit: "score_0_5", sourceUrl: url });
      if (reviews !== null) signals.push({ profileId: p.profileId, network: "app_store", metric: "reviewCount", value: reviews, unit: "count", sourceUrl: url });
      if (app.version) signals.push({ profileId: p.profileId, network: "app_store", metric: "appVersion", value: app.version, unit: "version", sourceUrl: url });
      if (app.currentVersionReleaseDate) signals.push({ profileId: p.profileId, network: "app_store", metric: "releaseDate", value: app.currentVersionReleaseDate, unit: "iso_date", sourceUrl: url });

      const prevVersion = await ctx.previous("appVersion", { profileId: p.profileId });
      if (app.version && prevVersion && String(prevVersion.value) !== app.version) {
        let summary = `Nueva versión ${app.version} (antes ${String(prevVersion.value)}).`;
        let featureKeys: string[] = [];
        let severity: "low" | "medium" | "high" = "low";
        if (app.releaseNotes && ctx.allowPaid) {
          const c = await classifyContent({ competitorName: ctx.competitor.name, kindHint: "release_notes", title: `Versión ${app.version}`, body: app.releaseNotes, sourceUrl: url });
          usage = addUsage(usage, c.usage);
          if (c.result) {
            summary = c.result.summary || summary;
            featureKeys = c.result.featureKeys;
            severity = c.result.severity;
            if (c.result.suggestFeatureHas && shouldSuggestFeatures("app_release", featureKeys)) {
              for (const key of featureKeys) {
                suggestions.push({ field: `featureMatrix.${key}`, proposedValue: c.result.suggestFeatureHas, reason: `Notas de la versión ${app.version} de la app iOS`, evidenceUrl: url, quote: (app.releaseNotes ?? "").slice(0, 200), confidence: "medium" });
              }
            }
          }
        }
        events.push({
          kind: "app_release",
          severity,
          title: `App iOS ${app.version}`,
          summary,
          sourceUrl: url,
          network: "app_store",
          evidence: { version: app.version, previous: prevVersion.value, releaseNotes: (app.releaseNotes ?? "").slice(0, 1_000), releaseDate: app.currentVersionReleaseDate },
          featureKeys,
          dedupeKey: `${ctx.competitor.competitorId}|app_release|app_store|${app.version}`,
        });
      }
      const prevRating = await ctx.previous("rating", { profileId: p.profileId });
      if (rating !== null && prevRating && typeof prevRating.value === "number" && (reviews ?? 0) >= 20 && prevRating.value - rating >= thr) {
        events.push({
          kind: "rating_drop",
          severity: "medium",
          title: `Rating App Store ${prevRating.value} → ${rating}`,
          summary: `La calificación bajó ${Math.round((prevRating.value - rating) * 100) / 100} puntos con ${reviews} reseñas.`,
          sourceUrl: url,
          network: "app_store",
          evidence: { before: prevRating.value, after: rating, reviews },
          dedupeKey: `${ctx.competitor.competitorId}|rating_drop|app_store|${rating}`,
        });
      }
      profileUpdates.push({
        profileId: p.profileId,
        status: "confirmed",
        externalId: id,
        url,
        lastOkAt: now,
        latest: { rating, reviewCount: reviews, version: app.version ?? null, releaseDate: app.currentVersionReleaseDate ?? null, name: app.trackName, asOf: now },
      });
    }
    return emptyResult(usage, { signals, events, suggestions, profileUpdates });
  },
};
