import { emptyUsage } from "../../ciLlm";
import {
  emptyResult,
  fetchJsonPublic,
  sleep,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type ContentDraft,
} from "./types";

/**
 * Connector `reddit` (spec v2 §5): busqueda publica JSON (sin auth, UA
 * identificado, ≤ 10 req/min). Menciones en 30 dias por alias distintivo.
 */

interface RedditSearch {
  data?: { children?: Array<{ data: { title: string; permalink: string; score: number; created_utc: number; subreddit: string; num_comments: number } }> };
}

const GENERIC = new Set(["suite", "cloud", "pms", "hotel", "hoteles", "app", "software", "system", "sistema", "booking", "reservas"]);

function distinctiveAliases(c: { name: string; aliases: string[] }): string[] {
  const out = new Set<string>();
  for (const a of [c.name, ...c.aliases]) {
    const s = (a ?? "").trim();
    if (s.length < 4 || GENERIC.has(s.toLowerCase())) continue;
    out.add(s);
  }
  return Array.from(out).slice(0, 3);
}

export const redditConnector: SignalConnector = {
  id: "reddit",
  label: "Reddit (menciones)",
  paid: false,
  accepts: { perCompetitor: true },
  // Search publica sin auth: 10 requests por minuto.
  minDelayMs: 6_500,
  async healthCheck() {
    return { ok: true, detail: "search.json público, sin key (10 req/min)" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    const usage = emptyUsage();
    const aliases = distinctiveAliases(ctx.competitor);
    if (!aliases.length) return emptyResult(usage, { skipped: "sin alias distintivo (≥ 4 chars, no genérico)" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const content: ContentDraft[] = [];
    const seen = new Set<string>();
    let mentions = 0;
    for (const alias of aliases) {
      const q = encodeURIComponent(`"${alias}"`);
      const r = await fetchJsonPublic<RedditSearch>(`https://www.reddit.com/search.json?q=${q}&sort=new&t=month&limit=25`, {
        headers: { "user-agent": "bookfer-internal:competitive-intel:1.0 (by /u/bookfer)" },
      });
      if (!r.ok) {
        if (r.status === 429) await sleep(7_000);
        continue;
      }
      for (const ch of r.json?.data?.children ?? []) {
        const d = ch.data;
        if (!d || seen.has(d.permalink)) continue;
        seen.add(d.permalink);
        mentions++;
        content.push({ network: "reddit", externalId: d.permalink, title: d.title, excerpt: `r/${d.subreddit}`, url: `https://www.reddit.com${d.permalink}`, publishedAt: new Date(d.created_utc * 1000), kind: "post", engagement: { score: d.score, comments: d.num_comments } });
        if (d.score >= 20 && new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(d.title)) {
          const url = `https://www.reddit.com${d.permalink}`;
          events.push({
            kind: "press",
            severity: "low",
            title: `Reddit: ${d.title.slice(0, 120)}`,
            summary: `Hilo en r/${d.subreddit} con ${d.score} puntos y ${d.num_comments} comentarios.`,
            sourceUrl: url,
            network: "reddit",
            evidence: { score: d.score, comments: d.num_comments, subreddit: d.subreddit },
            dedupeKey: `${ctx.competitor.competitorId}|press|${url}`,
            observedAt: new Date(d.created_utc * 1000),
          });
        }
      }
      await sleep(6_500); // ≤ 10 req/min
    }
    signals.push({ network: "reddit", metric: "redditMentions", value: mentions, unit: "count", sourceUrl: `https://www.reddit.com/search/?q=${encodeURIComponent(`"${aliases[0]}"`)}` });
    return emptyResult(usage, { signals, events, content });
  },
};
