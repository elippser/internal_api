import { emptyUsage, addUsage } from "../../ciLlm";
import type { LlmUsageRecord } from "../../competitors.model";
import { classifyContent, shouldSuggestFeatures } from "../contentClassifier";
import { discoverFeedUrl, fetchFeed } from "../feedParser";
import {
  daysBetween,
  emptyResult,
  type PageUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type SuggestionDraft,
  type ContentDraft,
} from "./types";

/**
 * Connector `rss` (spec v2 §5): blog / changelog / news por feed publico.
 * Usa las watchedPages kind blog|changelog con feedUrl (o lo descubre). Haiku
 * clasifica SOLO los posts nuevos desde la ultima corrida.
 */

const MAX_NEW_POSTS = 8;
const DAY_MS = 86_400_000;

export const rssConnector: SignalConnector = {
  id: "rss",
  label: "Blog / changelog (RSS)",
  paid: true, // Haiku sobre posts nuevos (centavos)
  accepts: { pageKinds: ["blog", "changelog"] },
  async healthCheck() {
    return { ok: true, detail: "feeds públicos, sin key" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    let usage: LlmUsageRecord = emptyUsage();
    const pages = ctx.pages.filter((p) => (p.kind === "blog" || p.kind === "changelog") && p.status !== "paused");
    if (!pages.length) return emptyResult(usage, { skipped: "sin páginas blog/changelog" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const suggestions: SuggestionDraft[] = [];
    const content: ContentDraft[] = [];
    const pageUpdates: PageUpdate[] = [];
    const now = new Date();

    for (const page of pages) {
      let feedUrl = page.feedUrl;
      if (!feedUrl) {
        feedUrl = await discoverFeedUrl(page.url, null);
        if (feedUrl) pageUpdates.push({ pageId: page.pageId, feedUrl });
        else {
          pageUpdates.push({ pageId: page.pageId, lastCheckedAt: now });
          continue; // sin feed: lo cubre watched_pages por hash
        }
      }
      const feed = await fetchFeed(feedUrl);
      if (!feed.ok) {
        pageUpdates.push({ pageId: page.pageId, lastCheckedAt: now, status: "unavailable" });
        continue;
      }
      const since30 = now.getTime() - 30 * DAY_MS;
      const dated = feed.items.filter((i) => i.publishedAt);
      const postsLast30d = dated.filter((i) => (i.publishedAt as Date).getTime() >= since30).length;
      const lastPostAt = dated.reduce<Date | null>((acc, i) => (!acc || (i.publishedAt as Date) > acc ? (i.publishedAt as Date) : acc), null);
      signals.push({ pageId: page.pageId, network: page.kind === "changelog" ? "changelog" : "blog", metric: "postsLast30d", value: postsLast30d, unit: "count", sourceUrl: feedUrl });
      if (lastPostAt) signals.push({ pageId: page.pageId, network: page.kind === "changelog" ? "changelog" : "blog", metric: "lastPostAt", value: lastPostAt.toISOString(), unit: "iso_date", sourceUrl: feedUrl });

      // Feed de contenido (v2.1): todo lo publicado en 90 dias, sea material o no.
      const since90 = now.getTime() - 90 * DAY_MS;
      for (const item of dated.filter((i) => (i.publishedAt as Date).getTime() >= since90).slice(0, 40)) {
        content.push({
          network: page.kind === "changelog" ? "changelog" : "blog",
          pageId: page.pageId,
          title: item.title,
          excerpt: item.summary,
          url: item.url || feedUrl,
          publishedAt: item.publishedAt as Date,
          kind: page.kind === "changelog" ? "release" : "post",
        });
      }

      // Posts nuevos desde la ultima lectura (o ultimos 30 d en la primera).
      const prevLast = await ctx.previous("lastPostAt", { pageId: page.pageId });
      const cutoff = prevLast?.value ? new Date(String(prevLast.value)).getTime() : since30;
      const fresh = dated
        .filter((i) => (i.publishedAt as Date).getTime() > cutoff)
        .sort((a, b) => (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime())
        .slice(0, MAX_NEW_POSTS);

      for (const post of fresh) {
        if (!ctx.allowPaid) break;
        const c = await classifyContent({
          competitorName: ctx.competitor.name,
          kindHint: page.kind === "changelog" ? "changelog" : "blog_post",
          title: post.title,
          body: post.summary,
          sourceUrl: post.url,
        });
        usage = addUsage(usage, c.usage);
        if (!c.result || !c.result.material) continue;
        const kind = c.result.kind === "other" || c.result.kind === "page_change" ? (page.kind === "changelog" ? "feature_announce" : "press") : c.result.kind;
        events.push({
          kind,
          severity: c.result.severity,
          title: post.title || "Publicación nueva",
          summary: c.result.summary,
          sourceUrl: post.url || feedUrl,
          network: page.kind,
          evidence: { postTitle: post.title, postUrl: post.url, publishedAt: post.publishedAt },
          featureKeys: c.result.featureKeys,
          dedupeKey: `${ctx.competitor.competitorId}|${kind}|${post.url || post.title}`,
          observedAt: post.publishedAt ?? now,
        });
        if (c.result.suggestFeatureHas && shouldSuggestFeatures(kind, c.result.featureKeys)) {
          for (const key of c.result.featureKeys) {
            suggestions.push({
              field: `featureMatrix.${key}`,
              proposedValue: c.result.suggestFeatureHas,
              reason: `Anunciado en ${page.kind === "changelog" ? "el changelog" : "el blog"}: ${post.title}`,
              evidenceUrl: post.url,
              quote: post.title,
              confidence: c.result.severity === "high" ? "high" : "medium",
            });
          }
        }
      }
      pageUpdates.push({ pageId: page.pageId, lastCheckedAt: now, status: "active", lastChangedAt: lastPostAt && daysBetween(lastPostAt, now) < 30 ? lastPostAt : undefined });
    }

    return emptyResult(usage, { signals, events, suggestions, content, pageUpdates });
  },
};
