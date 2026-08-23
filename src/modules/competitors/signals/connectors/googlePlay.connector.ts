import { fetchPage } from "../../../../shared/web/fetchPage";
import { emptyUsage } from "../../ciLlm";
import {
  emptyResult,
  type ProfileUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
} from "./types";

/**
 * Connector `google_play` (spec v2 §5, D3): ficha publica de la app, fetch
 * sin login, parse best-effort de los blobs JSON de la pagina. Si el parse
 * falla → perfil `unavailable`, nunca un cero.
 */

function packageOf(p: { externalId?: string; url?: string }): string | null {
  if (p.externalId && /^[A-Za-z0-9_.]+$/.test(p.externalId) && p.externalId.includes(".")) return p.externalId;
  const m = /[?&]id=([A-Za-z0-9_.]+)/.exec(p.url ?? "");
  return m ? m[1] : null;
}

/** Best-effort: rating y cantidad de reseñas en el HTML de la ficha. */
function parsePlay(html: string): { rating: number | null; reviewCount: number | null; updatedAt: string | null } {
  let rating: number | null = null;
  let reviewCount: number | null = null;
  let updatedAt: string | null = null;
  // Ej.: "4.6star" / aria-label="Rated 4.6 stars out of five stars"
  const r1 = /Rated\s+([0-9]\.[0-9])\s+stars/i.exec(html) ?? /([0-9]\.[0-9])\s*star/i.exec(html);
  if (r1) rating = Number(r1[1]);
  // Ej.: "1.23K reviews" / "12,345 reviews" / "1,2 mil reseñas"
  const r2 = /([\d.,]+)\s*([KMk]?)\s*(?:reviews|reseñas|opiniones)/i.exec(html);
  if (r2) {
    let n = Number(r2[1].replace(/\./g, "").replace(/,/g, "."));
    if (!Number.isFinite(n)) n = Number(r2[1].replace(/,/g, ""));
    const mult = r2[2].toUpperCase() === "K" ? 1_000 : r2[2].toUpperCase() === "M" ? 1_000_000 : 1;
    if (Number.isFinite(n)) reviewCount = Math.round(n * mult);
  }
  const r3 = /(?:Updated on|Actualizado el|Última actualización)[^<]{0,40}?([A-Za-záéíóú]{3,}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-záéíóú]{3,}\.?\s+\d{4})/i.exec(html);
  if (r3) updatedAt = r3[1];
  return { rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null, reviewCount, updatedAt };
}

export const googlePlayConnector: SignalConnector = {
  id: "google_play",
  label: "Google Play (ficha pública, best-effort)",
  paid: false,
  accepts: { networks: ["google_play"] },
  async healthCheck() {
    return { ok: true, detail: "parse best-effort de la ficha pública; sin key" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    const usage = emptyUsage();
    const profiles = ctx.profiles.filter((p) => p.network === "google_play" && p.status === "confirmed");
    if (!profiles.length) return emptyResult(usage, { skipped: "sin app de Google Play confirmada" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const profileUpdates: ProfileUpdate[] = [];
    const now = new Date();
    const thr = ctx.settings.signals.thresholds.ratingDropAbs;

    for (const p of profiles) {
      const pkg = packageOf(p);
      if (!pkg) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      const url = `https://play.google.com/store/apps/details?id=${pkg}&hl=es&gl=AR`;
      const res = await fetchPage(url, { timeoutMs: 12_000 });
      if (!res.ok) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      const parsed = parsePlay(res.html);
      if (parsed.rating === null && parsed.reviewCount === null) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable", latest: { ...p.latest, parseFailedAt: now } });
        continue;
      }
      if (parsed.rating !== null) signals.push({ profileId: p.profileId, network: "google_play", metric: "rating", value: parsed.rating, unit: "score_0_5", approx: true, sourceUrl: url });
      if (parsed.reviewCount !== null) signals.push({ profileId: p.profileId, network: "google_play", metric: "reviewCount", value: parsed.reviewCount, unit: "count", approx: true, sourceUrl: url });
      if (parsed.updatedAt) signals.push({ profileId: p.profileId, network: "google_play", metric: "releaseDate", value: parsed.updatedAt, unit: "text_date", approx: true, sourceUrl: url });
      const prevRating = await ctx.previous("rating", { profileId: p.profileId });
      if (parsed.rating !== null && prevRating && typeof prevRating.value === "number" && (parsed.reviewCount ?? 0) >= 20 && prevRating.value - parsed.rating >= thr) {
        events.push({
          kind: "rating_drop",
          severity: "medium",
          title: `Rating Google Play ${prevRating.value} → ${parsed.rating}`,
          summary: `La calificación bajó ${Math.round((prevRating.value - parsed.rating) * 100) / 100} puntos (≈, parse de la ficha pública).`,
          sourceUrl: url,
          network: "google_play",
          evidence: { before: prevRating.value, after: parsed.rating, reviews: parsed.reviewCount },
          dedupeKey: `${ctx.competitor.competitorId}|rating_drop|google_play|${parsed.rating}`,
        });
      }
      profileUpdates.push({ profileId: p.profileId, status: "confirmed", externalId: pkg, url, lastOkAt: now, latest: { rating: parsed.rating, reviewCount: parsed.reviewCount, releaseDate: parsed.updatedAt, approx: true, asOf: now } });
    }
    return emptyResult(usage, { signals, events, profileUpdates });
  },
};
