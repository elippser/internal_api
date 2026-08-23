import { makeId } from "../../../../shared/utils/ids";
import { fetchPage, textHash } from "../../../../shared/web/fetchPage";
import { addUsage, emptyUsage } from "../../ciLlm";
import { PageSnapshot, type LlmUsageRecord } from "../../competitors.model";
import { classifyContent, countOpenRoles, shouldSuggestFeatures } from "../contentClassifier";
import {
  emptyResult,
  sleep,
  type PageUpdate,
  type SignalConnector,
  type SignalConnectorResult,
  type SignalContext,
  type SignalDraft,
  type SignalEventDraft,
  type SuggestionDraft,
} from "./types";

/**
 * Connector `watched_pages` (spec v2 §5): generaliza el change watch de v1.
 * fetch + hash por pagina vigilada; Haiku SOLO si cambio el hash (o para
 * contar roles en careers). Este connector SI lee/escribe ci_page_snapshots
 * porque el snapshot es su estado propio (no es el "dato" del competidor).
 */

const MIN_TEXT_CHARS = 800;

/** Titulo del evento por pagina: el detalle va en el resumen, no en el titulo. */
const PAGE_TITLES: Record<string, string> = {
  home: "Cambió la home",
  pricing: "Cambió la página de precios",
  features: "Cambió la página de producto",
  changelog: "Nueva entrada en el changelog",
  careers: "Cambió la página de empleos",
  blog: "Cambió el blog",
  custom: "Cambió una página vigilada",
};
const SNAPSHOT_TEXT_CAP = 30_000;
const CHANGE_TEXT_CAP = 12_000;
const DAY_MS = 86_400_000;

function isDue(page: { cadence: string; lastCheckedAt: Date | null }, force: boolean): boolean {
  if (force || !page.lastCheckedAt) return true;
  const days = (Date.now() - new Date(page.lastCheckedAt).getTime()) / DAY_MS;
  return page.cadence === "monthly" ? days >= 27 : days >= 6;
}

export const watchedPagesConnector: SignalConnector = {
  id: "watched_pages",
  label: "Páginas vigiladas (pricing, features, changelog, careers)",
  paid: true, // Haiku solo cuando cambia el hash / careers
  accepts: { pageKinds: ["home", "pricing", "features", "blog", "changelog", "careers", "custom"] },
  async healthCheck() {
    return { ok: true, detail: "fetch público + hash, sin key" };
  },
  async run(ctx: SignalContext): Promise<SignalConnectorResult> {
    let usage: LlmUsageRecord = emptyUsage();
    const signals: SignalDraft[] = [];
    const events: SignalEventDraft[] = [];
    const suggestions: SuggestionDraft[] = [];
    const pageUpdates: PageUpdate[] = [];
    const now = new Date();
    const pages = ctx.pages.filter((p) => p.status !== "paused" && isDue(p, ctx.forced));
    if (!pages.length) return emptyResult(usage, { skipped: "ninguna página vencida" });

    for (const page of pages) {
      // Los blogs con feed los cubre rss; sin feed, entran aca por hash.
      if (page.kind === "blog" && page.feedUrl) continue;
      const res = await fetchPage(page.url);
      const prev = await PageSnapshot.findOne({ competitorId: ctx.competitor.competitorId, pageId: page.pageId });
      if (!res.ok || res.text.length < MIN_TEXT_CHARS) {
        pageUpdates.push({ pageId: page.pageId, lastCheckedAt: now, status: "unavailable" });
        await PageSnapshot.updateOne(
          { competitorId: ctx.competitor.competitorId, pageId: page.pageId },
          {
            $set: { url: page.url, page: page.kind, status: "unavailable", error: res.error ?? "short_text", fetchedAt: now },
            $setOnInsert: { snapshotId: makeId("snap"), competitorId: ctx.competitor.competitorId, pageId: page.pageId, text: "", textHash: null },
          },
          { upsert: true },
        );
        await sleep(500);
        continue;
      }
      const hash = textHash(res.text);
      const changed = Boolean(prev && prev.status === "ok" && prev.textHash && prev.textHash !== hash);
      signals.push({ pageId: page.pageId, metric: "pageChanged", value: changed, unit: "bool", sourceUrl: page.url });

      if (changed && prev && ctx.allowPaid) {
        const c = await classifyContent({
          competitorName: ctx.competitor.name,
          kindHint: "page_change",
          title: `Cambio en página ${page.kind}`,
          body: `=== ANTES ===\n${(prev.text ?? "").slice(0, CHANGE_TEXT_CAP)}\n\n=== DESPUÉS ===\n${res.text.slice(0, CHANGE_TEXT_CAP)}`,
          // El diff lleva las dos versiones: sin este tope las dos mitades no entran.
          maxChars: CHANGE_TEXT_CAP * 2 + 200,
          sourceUrl: page.url,
        });
        usage = addUsage(usage, c.usage);
        if (c.result?.material) {
          const kind = page.kind === "pricing" ? "pricing_change" : c.result.kind === "other" || c.result.kind === "page_change" ? (page.kind === "features" || page.kind === "changelog" ? "feature_announce" : "page_change") : c.result.kind;
          const severity = page.kind === "pricing" ? "high" : c.result.severity;
          events.push({
            kind,
            severity,
            title: PAGE_TITLES[page.kind] ?? `Cambio en la página ${page.kind}`,
            summary: c.result.summary,
            sourceUrl: page.url,
            network: page.kind,
            evidence: { before: { textHash: prev.textHash, fetchedAt: prev.fetchedAt }, after: { textHash: hash, fetchedAt: now } },
            featureKeys: c.result.featureKeys,
            dedupeKey: `${ctx.competitor.competitorId}|${kind}|${page.url}|${hash.slice(0, 12)}`,
          });
          if (c.result.suggestFeatureHas && shouldSuggestFeatures(kind, c.result.featureKeys)) {
            for (const key of c.result.featureKeys) {
              suggestions.push({
                field: `featureMatrix.${key}`,
                proposedValue: c.result.suggestFeatureHas,
                reason: `Cambió la página ${page.kind}: ${c.result.summary}`,
                evidenceUrl: page.url,
                quote: c.result.summary.slice(0, 200),
                confidence: "medium",
              });
            }
          }
        }
      }

      // Careers: conteo de roles (Haiku) solo si cambio o no hay lectura previa.
      if (page.kind === "careers" && ctx.allowPaid) {
        const prevRoles = await ctx.previous("openRoles", { pageId: page.pageId });
        if (changed || !prevRoles) {
          const roles = await countOpenRoles({ competitorName: ctx.competitor.name, text: res.text });
          usage = addUsage(usage, roles.usage);
          if (roles.openRoles !== null) {
            signals.push({ pageId: page.pageId, metric: "openRoles", value: roles.openRoles, unit: "count", sourceUrl: page.url });
            const prevN = typeof prevRoles?.value === "number" ? (prevRoles.value as number) : null;
            const thr = ctx.settings.signals.thresholds.hiringSpikeAbs;
            if (prevN !== null && roles.openRoles - prevN >= thr) {
              events.push({
                kind: "hiring_spike",
                severity: "medium",
                title: `Hiring: ${prevN} → ${roles.openRoles} posiciones abiertas`,
                summary: `Subieron las búsquedas abiertas (${Object.entries(roles.areas).filter(([, n]) => Number(n) > 0).map(([a, n]) => `${a}: ${n}`).join(", ") || "sin detalle por área"}).`,
                sourceUrl: page.url,
                network: "careers",
                evidence: { before: prevN, after: roles.openRoles, areas: roles.areas },
                dedupeKey: `${ctx.competitor.competitorId}|hiring_spike|${page.url}|${roles.openRoles}`,
              });
            }
          }
        }
      }

      await PageSnapshot.updateOne(
        { competitorId: ctx.competitor.competitorId, pageId: page.pageId },
        {
          $set: { url: page.url, page: page.kind, text: res.text.slice(0, SNAPSHOT_TEXT_CAP), textHash: hash, fetchedAt: now, status: "ok", error: null },
          $setOnInsert: { snapshotId: makeId("snap"), competitorId: ctx.competitor.competitorId, pageId: page.pageId },
        },
        { upsert: true },
      );
      pageUpdates.push({ pageId: page.pageId, lastCheckedAt: now, status: "active", lastHash: hash, ...(changed ? { lastChangedAt: now } : {}) });
      await sleep(1_000);
    }

    return emptyResult(usage, { signals, events, suggestions, pageUpdates });
  },
};
