import { callJson, emptyUsage, evidenceModel } from "../../ciLlm";
import { SOCIAL_NETWORKS, type SocialNetwork } from "../../competitors.model";
import {
  daysBetween,
  emptyResult,
  pctChange,
  type NewProfileDraft,
  type ProfileUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type ContentDraft,
} from "./types";

/**
 * Connector `search_snippets` (spec v2 §5): Sonnet + web_search (variante
 * estable, ver ciLlm) para las redes SIN API (Instagram, LinkedIn, X,
 * Facebook, TikTok): followers/posts aproximados desde los snippets de Google
 * ("12.3K Followers · 480 Posts"), y noticias/funding de los ultimos 30 dias.
 * Todo lo numerico sale `approx: true` con `asOf`.
 */

const SNIPPET_NETWORKS: SocialNetwork[] = ["instagram", "linkedin", "x", "facebook", "tiktok"];

const SYSTEM =
  "Sos el rastreador de presencia social y prensa de un competidor de bookfer (software hotelero). " +
  "Con la búsqueda web, buscá los perfiles OFICIALES del producto/empresa en Instagram, LinkedIn, X/Twitter, Facebook y TikTok " +
  "(por ejemplo `\"<nombre>\" instagram`, `\"<nombre>\" linkedin`) y leé los números que aparecen en los snippets de los resultados " +
  '("12.3K Followers, 480 Posts", "1,234 followers on LinkedIn"). También buscá noticias de los últimos 30 días ' +
  "(funding, inversión, ronda, adquisición, lanzamiento, alianza). " +
  "Buscá además si tienen alguna CAMPAÑA comercial en curso: promos, descuentos, cupones, " +
  '"prueba gratis", webinars o landings de campaña (por ejemplo `"<nombre>" promo OR descuento OR cupón OR "prueba gratis"`). ' +
  'Devolvé SOLO JSON: {"profiles":[{"network":"instagram"|"linkedin"|"x"|"facebook"|"tiktok","url":string,"handle":string,' +
  '"followersApprox":number|null,"postsApprox":number|null,"asOf":string (fecha del snippet si se ve, si no null)}],' +
  '"news":[{"title":string,"url":string,"date":string|null,"kind":"funding"|"launch"|"press"}],' +
  '"campaigns":[{"title":string (la oferta en una línea),"url":string,"offer":string (ej. "30% off primer año", "3 meses gratis")}]}. ' +
  "Sólo perfiles que con seguridad son de ESTE producto/empresa (el dominio o el nombre deben coincidir). " +
  "Si un número no aparece en el snippet, dejá null: no estimes. No inventes URLs.";

function asNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export const searchSnippetsConnector: SignalConnector = {
  id: "search_snippets",
  label: "Redes sin API + prensa (snippets de buscador ≈)",
  paid: true,
  accepts: { networks: SNIPPET_NETWORKS, perCompetitor: true },
  async healthCheck() {
    return process.env.ANTHROPIC_API_KEY ? { ok: true, detail: "Sonnet + web_search (≈ USD 0,10-0,15 por competidor)" } : { ok: false, detail: "falta ANTHROPIC_API_KEY" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    if (!ctx.allowPaid) return emptyResult(emptyUsage(), { skipped: "presupuesto mensual agotado" });
    const known = ctx.profiles.filter((p) => SNIPPET_NETWORKS.includes(p.network) && p.status !== "ignored");
    const knownText = known.length ? known.map((p) => `${p.network}: ${p.url || "@" + p.handle}`).join("; ") : "(ninguno cargado)";
    const user =
      `Producto/empresa: ${ctx.competitor.name}\nAliases: ${ctx.competitor.aliases.join(", ") || "—"}\nDominio: ${ctx.competitor.websiteDomain}\n` +
      `Perfiles ya conocidos: ${knownText}\n\nDevolvé el JSON.`;
    let r;
    try {
      r = await callJson({ model: evidenceModel(), system: SYSTEM, user, webSearch: { maxUses: 3 }, maxTokens: 1_500, timeoutMs: 120_000 });
    } catch (err) {
      return emptyResult(emptyUsage(), { error: err instanceof Error ? err.message : String(err) });
    }
    if (!r.json) return emptyResult(r.usage, { error: "parse_failed" });

    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const profileUpdates: ProfileUpdate[] = [];
    const newProfiles: NewProfileDraft[] = [];
    const now = new Date();
    const thr = ctx.settings.signals.thresholds.followerJumpPct;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (Array.isArray(r.json.profiles) ? r.json.profiles : []) as any[]) {
      const network = typeof p?.network === "string" && (SOCIAL_NETWORKS as readonly string[]).includes(p.network) ? (p.network as SocialNetwork) : null;
      const url = typeof p?.url === "string" && /^https?:\/\//i.test(p.url) ? p.url : "";
      if (!network || !url) continue;
      const handle = typeof p?.handle === "string" ? p.handle.replace(/^@/, "").trim() : "";
      const followers = asNum(p?.followersApprox);
      const posts = asNum(p?.postsApprox);
      const asOf = typeof p?.asOf === "string" && p.asOf ? p.asOf : null;
      const match = known.find((k) => k.network === network && ((handle && k.handle && k.handle.toLowerCase() === handle.toLowerCase()) || (k.url && url.toLowerCase().startsWith(k.url.toLowerCase().replace(/\/+$/, "")))));
      if (match) {
        if (match.status !== "confirmed") continue; // candidato: no medir hasta confirmar
        if (followers !== null) {
          signals.push({ profileId: match.profileId, network, metric: "followers", value: followers, unit: "count", approx: true, sourceUrl: url });
          const prev = await ctx.previous("followers", { profileId: match.profileId });
          if (prev && typeof prev.value === "number" && daysBetween(prev.observedAt, now) >= 7) {
            const pct = pctChange(prev.value, followers);
            if (pct !== null && Math.abs(pct) >= Math.max(thr, 15)) {
              events.push({
                kind: pct > 0 ? "follower_jump" : "activity_spike",
                severity: "low",
                title: `${network}: ${prev.value} → ${followers} seguidores (≈${pct > 0 ? "+" : ""}${pct} %)`,
                summary: `Lectura aproximada desde snippets de buscador (asOf ${asOf ?? "desconocido"}).`,
                sourceUrl: url,
                network,
                evidence: { before: prev.value, after: followers, pct, approx: true },
                dedupeKey: `${ctx.competitor.competitorId}|follower_jump|${network}|${followers}`,
              });
            }
          }
        }
        if (posts !== null) signals.push({ profileId: match.profileId, network, metric: "posts", value: posts, unit: "count", approx: true, sourceUrl: url });
        profileUpdates.push({ profileId: match.profileId, lastOkAt: now, latest: { ...(match.latest ?? {}), followers, followersApprox: true, posts, asOf: asOf ?? now } });
      } else {
        newProfiles.push({ network, handle, url, latest: { followers, followersApprox: true, posts, asOf: asOf ?? now } });
        events.push({
          kind: "social_profile_found",
          severity: "low",
          title: `Perfil de ${network} encontrado: ${handle || url}`,
          summary: "Candidato propuesto por búsqueda web; confirmalo en la ficha para empezar a medirlo.",
          sourceUrl: url,
          network,
          dedupeKey: `${ctx.competitor.competitorId}|social_profile_found|${network}|${(handle || url).toLowerCase()}`,
        });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const news = (Array.isArray(r.json.news) ? r.json.news : []) as any[];
    let newsCount = 0;
    for (const n of news.slice(0, 8)) {
      const url = typeof n?.url === "string" && /^https?:\/\//i.test(n.url) ? n.url : "";
      const title = typeof n?.title === "string" ? n.title.slice(0, 200) : "";
      if (!url || !title) continue;
      newsCount++;
      const kind = n?.kind === "funding" ? "funding" : n?.kind === "launch" ? "launch" : "press";
      events.push({
        kind,
        severity: kind === "funding" ? "high" : kind === "launch" ? "medium" : "low",
        title,
        summary: `Noticia detectada por búsqueda web${n?.date ? ` (${n.date})` : ""}.`,
        sourceUrl: url,
        network: "web",
        dedupeKey: `${ctx.competitor.competitorId}|${kind}|${url}`,
      });
    }
    signals.push({ metric: "newsCount", value: newsCount, unit: "count", approx: true, sourceUrl: "" });

    // Campañas comerciales visibles (v2.1). Es lo más cerca que se llega de
    // "qué están pauteando" sin las bibliotecas de anuncios, que bloquean.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaigns = (Array.isArray(r.json.campaigns) ? r.json.campaigns : []) as any[];
    const content: ContentDraft[] = [];
    for (const c of campaigns.slice(0, 5)) {
      const url = typeof c?.url === "string" && /^https?:\/\//i.test(c.url) ? c.url : "";
      const title = typeof c?.title === "string" ? c.title.slice(0, 200) : "";
      if (!url || !title) continue;
      const offer = typeof c?.offer === "string" ? c.offer.slice(0, 200) : "";
      events.push({
        kind: "campaign",
        severity: "medium",
        title: `Campaña: ${title}`,
        summary: offer ? `Oferta detectada: ${offer}.` : "Campaña comercial detectada por búsqueda web.",
        sourceUrl: url,
        network: "web",
        evidence: { offer },
        dedupeKey: `${ctx.competitor.competitorId}|campaign|${url}`,
      });
      content.push({ network: "other", title, excerpt: offer, url, publishedAt: now, kind: "campaign" });
    }
    signals.push({ metric: "activeCampaigns", value: content.length, unit: "count", approx: true, sourceUrl: "" });

    return emptyResult(r.usage, { signals, events, content, profileUpdates, newProfiles });
  },
};
