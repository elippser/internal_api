import { addUsage, emptyUsage } from "../../ciLlm";
import type { LlmUsageRecord } from "../../competitors.model";
import { classifyContent } from "../contentClassifier";
import {
  emptyResult,
  fetchJsonPublic,
  type ProfileUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type ContentDraft,
} from "./types";

/**
 * Connector `youtube` (spec v2 §5): YouTube Data API v3 con key gratis.
 * channels.list (1 u) + playlistItems.list del playlist uploads (1 u); nunca
 * search.list (100 u). Sin key → health ok:false y la corrida lo saltea.
 */

const key = () => process.env.YOUTUBE_API_KEY?.trim() || null;
const DAY_MS = 86_400_000;

interface ChannelsResp {
  items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}
interface PlaylistResp {
  items?: Array<{ snippet?: { title?: string; description?: string; publishedAt?: string; resourceId?: { videoId?: string } } }>;
}

function channelQuery(p: { handle?: string; externalId?: string; url?: string }): { param: string; value: string } | null {
  if (p.externalId && /^UC[\w-]{20,}$/.test(p.externalId)) return { param: "id", value: p.externalId };
  const m = /youtube\.com\/(?:@([^/?#]+)|channel\/(UC[\w-]+)|c\/([^/?#]+)|user\/([^/?#]+))/i.exec(p.url ?? "");
  if (m?.[2]) return { param: "id", value: m[2] };
  if (m?.[1]) return { param: "forHandle", value: m[1] };
  if (m?.[4]) return { param: "forUsername", value: m[4] };
  if (p.handle) return /^UC[\w-]{20,}$/.test(p.handle) ? { param: "id", value: p.handle } : { param: "forHandle", value: p.handle.replace(/^@/, "") };
  return null;
}

export const youtubeConnector: SignalConnector = {
  id: "youtube",
  label: "YouTube (Data API v3)",
  paid: false, // Haiku solo sobre videos nuevos (respeta allowPaid)
  accepts: { networks: ["youtube"] },
  async healthCheck() {
    return key()
      ? { ok: true, detail: "YOUTUBE_API_KEY configurada (10k unidades/día)" }
      : { ok: false, detail: "falta YOUTUBE_API_KEY — crear una key gratis en console.cloud.google.com (YouTube Data API v3)" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    let usage: LlmUsageRecord = emptyUsage();
    const k = key();
    if (!k) return emptyResult(usage, { skipped: "sin YOUTUBE_API_KEY" });
    const profiles = ctx.profiles.filter((p) => p.network === "youtube" && p.status === "confirmed");
    if (!profiles.length) return emptyResult(usage, { skipped: "sin canal de YouTube confirmado" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const profileUpdates: ProfileUpdate[] = [];
    const content: ContentDraft[] = [];
    const now = new Date();

    for (const p of profiles) {
      const q = channelQuery(p);
      if (!q) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      const ch = await fetchJsonPublic<ChannelsResp>(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet,contentDetails&${q.param}=${encodeURIComponent(q.value)}&key=${k}`);
      const item = ch.json?.items?.[0];
      if (!ch.ok || !item) {
        profileUpdates.push({ profileId: p.profileId, status: ch.status === 200 ? "unavailable" : p.status });
        continue;
      }
      const url = `https://www.youtube.com/channel/${item.id}`;
      const subs = item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null;
      const videos = item.statistics?.videoCount ? Number(item.statistics.videoCount) : null;
      const views = item.statistics?.viewCount ? Number(item.statistics.viewCount) : null;
      if (subs !== null) signals.push({ profileId: p.profileId, network: "youtube", metric: "subscribers", value: subs, unit: "count", sourceUrl: url });
      if (videos !== null) signals.push({ profileId: p.profileId, network: "youtube", metric: "videos", value: videos, unit: "count", sourceUrl: url });
      if (views !== null) signals.push({ profileId: p.profileId, network: "youtube", metric: "views", value: views, unit: "count", sourceUrl: url });

      let lastPostAt: Date | null = null;
      const uploads = item.contentDetails?.relatedPlaylists?.uploads;
      if (uploads) {
        const pl = await fetchJsonPublic<PlaylistResp>(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=10&playlistId=${uploads}&key=${k}`);
        const vids = (pl.json?.items ?? []).map((v) => v.snippet).filter(Boolean);
        const dated = vids.filter((v) => v?.publishedAt).map((v) => ({ title: v!.title ?? "", description: v!.description ?? "", publishedAt: new Date(v!.publishedAt as string), id: v!.resourceId?.videoId ?? "" }));
        if (dated.length) lastPostAt = dated.reduce<Date | null>((acc, v) => (!acc || v.publishedAt > acc ? v.publishedAt : acc), null);
        for (const v of dated.slice(0, 20)) {
          content.push({ network: "youtube", profileId: p.profileId, externalId: v.id, title: v.title, excerpt: v.description, url: v.id ? `https://www.youtube.com/watch?v=${v.id}` : url, publishedAt: v.publishedAt, kind: "video" });
        }
        const prevLast = await ctx.previous("lastPostAt", { profileId: p.profileId });
        const cutoff = prevLast?.value ? new Date(String(prevLast.value)).getTime() : now.getTime() - 30 * DAY_MS;
        const fresh = dated.filter((v) => v.publishedAt.getTime() > cutoff).slice(0, 5);
        for (const v of fresh) {
          if (!ctx.allowPaid) break;
          const vurl = v.id ? `https://www.youtube.com/watch?v=${v.id}` : url;
          const c = await classifyContent({ competitorName: ctx.competitor.name, kindHint: "video", title: v.title, body: v.description, sourceUrl: vurl });
          usage = addUsage(usage, c.usage);
          if (!c.result?.material || c.result.kind === "other" || c.result.kind === "page_change") continue;
          events.push({
            kind: c.result.kind,
            severity: c.result.severity,
            title: `Video: ${v.title.slice(0, 120)}`,
            summary: c.result.summary,
            sourceUrl: vurl,
            network: "youtube",
            featureKeys: c.result.featureKeys,
            dedupeKey: `${ctx.competitor.competitorId}|${c.result.kind}|${vurl}`,
            observedAt: v.publishedAt,
          });
        }
        const since30 = now.getTime() - 30 * DAY_MS;
        signals.push({ profileId: p.profileId, network: "youtube", metric: "postsLast30d", value: dated.filter((v) => v.publishedAt.getTime() >= since30).length, unit: "count", sourceUrl: url });
      }
      if (lastPostAt) signals.push({ profileId: p.profileId, network: "youtube", metric: "lastPostAt", value: lastPostAt.toISOString(), unit: "iso_date", sourceUrl: url });
      profileUpdates.push({ profileId: p.profileId, status: "confirmed", externalId: item.id, url, lastOkAt: now, latest: { subscribers: subs, videos, views, lastPostAt, title: item.snippet?.title ?? null, asOf: now } });
    }
    return emptyResult(usage, { signals, events, content, profileUpdates });
  },
};
