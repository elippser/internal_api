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
 * Connector `producthunt` (spec v2 §5): GraphQL API con developer token
 * gratis. Perfiles network producthunt con handle = slug del producto/post.
 */

const token = () => process.env.PRODUCTHUNT_TOKEN?.trim() || null;

interface PhResp {
  data?: {
    post?: { id: string; name: string; url: string; votesCount: number; commentsCount: number; reviewsCount?: number; createdAt: string; tagline?: string } | null;
  };
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<{ ok: boolean; json: T | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, "user-agent": "bookfer-internal/1.0" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return { ok: false, json: null, error: `http_${res.status}` };
    return { ok: true, json: (await res.json()) as T };
  } catch (err) {
    return { ok: false, json: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export const productHuntConnector: SignalConnector = {
  id: "producthunt",
  label: "Product Hunt (GraphQL)",
  paid: false,
  accepts: { networks: ["producthunt"] },
  async healthCheck() {
    return token()
      ? { ok: true, detail: "PRODUCTHUNT_TOKEN configurado" }
      : { ok: false, detail: "falta PRODUCTHUNT_TOKEN — developer token gratis en producthunt.com/v2/oauth/applications" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    const usage = emptyUsage();
    if (!token()) return emptyResult(usage, { skipped: "sin PRODUCTHUNT_TOKEN" });
    const profiles = ctx.profiles.filter((p) => p.network === "producthunt" && p.status === "confirmed");
    if (!profiles.length) return emptyResult(usage, { skipped: "sin producto de Product Hunt confirmado" });
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const profileUpdates: ProfileUpdate[] = [];
    const now = new Date();
    for (const p of profiles) {
      const slug = p.handle || /producthunt\.com\/(?:products|posts)\/([^/?#]+)/i.exec(p.url ?? "")?.[1];
      if (!slug) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      const r = await gql<PhResp>(
        `query($slug: String!) { post(slug: $slug) { id name url votesCount commentsCount reviewsCount createdAt tagline } }`,
        { slug },
      );
      const post = r.json?.data?.post;
      if (!r.ok || !post) {
        profileUpdates.push({ profileId: p.profileId, status: "unavailable" });
        continue;
      }
      signals.push({ profileId: p.profileId, network: "producthunt", metric: "phVotes", value: post.votesCount, unit: "count", sourceUrl: post.url });
      if (typeof post.reviewsCount === "number") signals.push({ profileId: p.profileId, network: "producthunt", metric: "reviewCount", value: post.reviewsCount, unit: "count", sourceUrl: post.url });
      const prev = await ctx.previous("phVotes", { profileId: p.profileId });
      if (!prev && new Date(post.createdAt).getTime() > now.getTime() - 90 * 86_400_000) {
        events.push({
          kind: "ph_launch",
          severity: "medium",
          title: `Product Hunt: ${post.name}`,
          summary: `${post.tagline ?? ""} · ${post.votesCount} votos, ${post.commentsCount} comentarios.`,
          sourceUrl: post.url,
          network: "producthunt",
          dedupeKey: `${ctx.competitor.competitorId}|ph_launch|${post.url}`,
          observedAt: new Date(post.createdAt),
        });
      }
      profileUpdates.push({ profileId: p.profileId, status: "confirmed", externalId: post.id, url: post.url, lastOkAt: now, latest: { votes: post.votesCount, comments: post.commentsCount, reviewCount: post.reviewsCount ?? null, launchedAt: post.createdAt, asOf: now } });
    }
    return emptyResult(usage, { signals, events, profileUpdates });
  },
};
