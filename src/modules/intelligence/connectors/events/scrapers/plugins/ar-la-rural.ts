// Plugin La Rural, Buenos Aires (mercado receptor AR): archivo del custom
// post type `evento` (WordPress + Elementor), server-rendered. Verificado
// (ago-2026): cards con <h3 class="elementor-heading-title"><a href=".../evento/slug">
// y la fecha en español ("11 al 13 de agosto de 2026") en un widget de texto
// contiguo. robots.txt solo bloquea /wp-admin/.

import { fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { parseSpanishDateRange, scrapedToSignal } from "../normalize";

const LIST_URL = "https://larural.com.ar/evento";

const CTX = {
  sourceLabel: "ar-la-rural",
  countryCode: "AR",
  city: "Buenos Aires",
  lat: -34.58,
  lng: -58.421,
  defaultCategory: "fair",
};

export const laRuralPlugin: ScraperPlugin = {
  marketCode: "AR",
  sourceLabel: CTX.sourceLabel,
  kind: "html",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    try {
      const html = await fetchText(LIST_URL);
      const today = new Date().toISOString().slice(0, 10);
      const currentYear = new Date().getUTCFullYear();
      const signals: Signal[] = [];

      // Cada card: título en <h3 class="elementor-heading-title"><a href=".../evento/...">
      // y la fecha en el HTML que sigue hasta el próximo título.
      const titleRe =
        /<h3[^>]*class="[^"]*elementor-heading-title[^"]*"[^>]*>\s*<a[^>]*href="(https?:\/\/larural\.com\.ar\/evento\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

      const matches: Array<{ url: string; name: string; index: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = titleRe.exec(html)) !== null) {
        matches.push({ url: m[1], name: stripTags(m[2]), index: m.index });
      }

      for (let i = 0; i < matches.length; i++) {
        const { url, name, index } = matches[i];
        if (!name) continue;
        const segmentEnd = i + 1 < matches.length ? matches[i + 1].index : Math.min(html.length, index + 4000);
        const segment = stripTags(html.slice(index, segmentEnd));
        const dates = parseSpanishDateRange(segment, currentYear);
        if (!dates) continue;
        if ((dates.endDate ?? dates.startDate) < today) continue;

        const category = /profesional/i.test(segment) ? "conference" : "fair";
        const scraped: ScrapedEvent = { name, url, venue: "La Rural", category, ...dates };
        const signal = scrapedToSignal(scraped, CTX);
        if (signal) signals.push(signal);
      }
      return signals;
    } catch (err) {
      console.error(`[intelligence] scraper ${CTX.sourceLabel} falló:`, (err as Error).message);
      return [];
    }
  },
};

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
