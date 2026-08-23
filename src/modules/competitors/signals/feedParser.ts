import { XMLParser } from "fast-xml-parser";
import { stripHtml } from "../../../shared/web/fetchPage";

/** Parser RSS 2.0 / Atom minimo (connector `rss`). */

export interface FeedItem {
  title: string;
  url: string;
  publishedAt: Date | null;
  summary: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true });

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return o["#text"] as string;
    if (typeof o["@_href"] === "string") return o["@_href"] as string;
  }
  return "";
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function date(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function atomLink(v: unknown): string {
  const links = asArray(v as unknown[]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alt = links.find((l: any) => l && typeof l === "object" && (!l["@_rel"] || l["@_rel"] === "alternate")) ?? links[0];
  return text(alt);
}

export function parseFeed(xml: string): { kind: "rss" | "atom" | null; items: FeedItem[]; title: string } {
  let obj: Record<string, unknown>;
  try {
    obj = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { kind: null, items: [], title: "" };
  }
  // RSS 2.0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rss: any = obj.rss ?? obj["rdf:RDF"];
  if (rss) {
    const channel = rss.channel ?? rss;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems: any[] = asArray(channel?.item ?? rss.item);
    const items = rawItems.map((it) => ({
      title: stripHtml(text(it.title)).slice(0, 300),
      url: text(it.link) || text(it.guid),
      publishedAt: date(it.pubDate ?? it["dc:date"] ?? it.published),
      summary: stripHtml(text(it["content:encoded"] ?? it.description ?? it.summary)).slice(0, 4_000),
    }));
    return { kind: "rss", items: items.filter((i) => i.title || i.url), title: stripHtml(text(channel?.title)).slice(0, 200) };
  }
  // Atom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed: any = obj.feed;
  if (feed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems: any[] = asArray(feed.entry);
    const items = rawItems.map((it) => ({
      title: stripHtml(text(it.title)).slice(0, 300),
      url: atomLink(it.link),
      publishedAt: date(it.published ?? it.updated),
      summary: stripHtml(text(it.summary ?? it.content)).slice(0, 4_000),
    }));
    return { kind: "atom", items: items.filter((i) => i.title || i.url), title: stripHtml(text(feed.title)).slice(0, 200) };
  }
  return { kind: null, items: [], title: "" };
}

const FEED_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/blog/feed", "/blog/rss.xml", "/blog/rss", "/changelog.xml", "/changelog/feed", "/index.xml"];

/** Descubre un feed a partir de una pagina (link rel=alternate) o de paths tipicos. */
export async function discoverFeedUrl(pageUrl: string, html: string | null): Promise<string | null> {
  if (html) {
    const re = /<link\b[^>]*rel=["']alternate["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
      const hm = /href=["']([^"']+)["']/i.exec(tag);
      if (!hm) continue;
      try {
        return new URL(hm[1], pageUrl).toString();
      } catch {
        // sigue
      }
    }
  }
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  for (const p of FEED_PATHS) {
    const candidate = `${origin}${p}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6_000);
      const res = await fetch(candidate, { signal: ctrl.signal, headers: { "user-agent": "bookfer-internal/1.0 (+https://bookfer.com)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } });
      clearTimeout(t);
      if (!res.ok) continue;
      const ctype = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (/xml|rss|atom/i.test(ctype) || /<rss\b|<feed\b/i.test(body.slice(0, 2_000))) {
        const parsed = parseFeed(body);
        if (parsed.kind && parsed.items.length) return candidate;
      }
    } catch {
      // siguiente path
    }
  }
  return null;
}

export async function fetchFeed(url: string): Promise<{ ok: boolean; items: FeedItem[]; title: string; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "bookfer-internal/1.0 (+https://bookfer.com)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" } });
    if (!res.ok) return { ok: false, items: [], title: "", error: `http_${res.status}` };
    const xml = await res.text();
    const parsed = parseFeed(xml);
    if (!parsed.kind) return { ok: false, items: [], title: "", error: "not_a_feed" };
    return { ok: true, items: parsed.items, title: parsed.title };
  } catch (err) {
    const e = err as Error & { name?: string };
    return { ok: false, items: [], title: "", error: e?.name === "AbortError" ? "timeout" : e?.message ?? "fetch_failed" };
  } finally {
    clearTimeout(t);
  }
}
