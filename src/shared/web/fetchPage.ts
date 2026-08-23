import { createHash } from "crypto";

/**
 * Bajada de paginas publicas para el modulo de inteligencia competitiva (y
 * para el RAG por URL). Sin browser: fetch + strip de HTML. Las SPAs sin SSR
 * devuelven poco texto; el caller decide que hacer con eso (fallback por
 * busqueda web, o marcar la pagina como no disponible).
 */

export interface PageResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  title: string;
  text: string;
  html: string;
  links: { href: string; text: string }[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.CI_FETCH_TIMEOUT_MS ?? 10_000);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; bookfer-internal/1.0; +https://bookfer.com)";

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Acepta "dominio.com", "www.dominio.com/x" o una URL completa. */
export function normalizeUrl(input: string | null | undefined): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : "";
}

function extractLinks(html: string, baseUrl: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 500) {
    try {
      const href = new URL(m[1], baseUrl).toString();
      out.push({ href, text: stripHtml(m[2]).slice(0, 120) });
    } catch {
      // href invalido: se ignora
    }
  }
  return out;
}

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PageResult> {
  const target = normalizeUrl(url);
  const empty = (error: string, status = 0): PageResult => ({
    ok: false,
    status,
    finalUrl: target ?? url,
    title: "",
    text: "",
    html: "",
    links: [],
    error,
  });
  if (!target) return empty("invalid_url");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "accept-language": "es-AR,es;q=0.9,en;q=0.8,pt;q=0.7",
      },
    });
    if (!res.ok) return empty(`http_${res.status}`, res.status);
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype && !/text\/html|application\/xhtml/i.test(ctype)) {
      return empty("not_html", res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.subarray(0, maxBytes).toString("utf8");
    const finalUrl = res.url || target;
    return {
      ok: true,
      status: res.status,
      finalUrl,
      title: extractTitle(html),
      text: stripHtml(html),
      html,
      links: extractLinks(html, finalUrl),
    };
  } catch (err) {
    const e = err as Error & { name?: string };
    return empty(e?.name === "AbortError" ? "timeout" : e?.message ?? "fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

const PRICING_RE = /pricing|precios?|planes|plans|tarifas|pre[cç]os|price/i;
const PRICING_PATHS = ["/pricing", "/precios", "/planes", "/plans", "/tarifas", "/precio"];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Busca la pagina de precios: primero por los links de la home (href o texto
 * con pinta de pricing, mismo host), despues probando paths tipicos.
 */
export async function discoverPricingUrl(home: PageResult): Promise<string | null> {
  if (!home.ok) return null;
  const base = home.finalUrl;
  const host = hostOf(base);
  const fromLinks = home.links.find((l) => {
    if (hostOf(l.href) !== host) return false;
    let path = "";
    try {
      path = new URL(l.href).pathname;
    } catch {
      return false;
    }
    if (path === "/" || path === "") return false;
    return PRICING_RE.test(path) || PRICING_RE.test(l.text);
  });
  if (fromLinks) return fromLinks.href;

  for (const p of PRICING_PATHS) {
    let candidate: string;
    try {
      candidate = new URL(p, base).toString();
    } catch {
      continue;
    }
    const r = await fetchPage(candidate, { timeoutMs: 6_000 });
    if (r.ok && r.text.length > 500) return r.finalUrl;
  }
  return null;
}

/**
 * Hash del texto normalizado: minusculas, espacios colapsados y sin fechas ni
 * anios sueltos (ruido tipico de footers y blogs). Los precios quedan.
 */
export function textHash(text: string): string {
  const norm = (text ?? "")
    .toLowerCase()
    .replace(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/g, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex");
}
