// Plugin BA Ferial, Buenos Aires (mercado receptor AR): el centro de
// convenciones que reemplazó a Costa Salguero en el mismo predio de
// Costanera Norte (el sitio de Costa Salguero está suspendido desde 2026).
// Verificado (ago-2026): https://baferial.com/eventos/ es server-rendered
// con <div class="evento-card" data-mes="YYYY-MM">, <h3 class="evento-titulo">
// y <p class="evento-fecha"> con la fecha en español. robots.txt permite todo.

import { fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { parseSpanishDateRange, scrapedToSignal } from "../normalize";

const LIST_URL = "https://baferial.com/eventos/";

const CTX = {
  sourceLabel: "ar-ba-ferial",
  countryCode: "AR",
  city: "Buenos Aires",
  lat: -34.5614,
  lng: -58.401,
  defaultCategory: "fair",
};

export const baFerialPlugin: ScraperPlugin = {
  marketCode: "AR",
  sourceLabel: CTX.sourceLabel,
  kind: "html",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    try {
      const html = await fetchText(LIST_URL);
      const today = new Date().toISOString().slice(0, 10);
      const signals: Signal[] = [];

      const cardRe =
        /<div[^>]*class="[^"]*evento-card[^"]*"[^>]*data-mes="(\d{4})-(\d{2})"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*evento-card[^"]*"|$)/gi;
      let m: RegExpExecArray | null;
      while ((m = cardRe.exec(html)) !== null) {
        const [, year, , card] = m;
        const title = card.match(
          /<h3[^>]*class="[^"]*evento-titulo[^"]*"[^>]*>\s*(?:<a[^>]*href="([^"]*)"[^>]*>)?([\s\S]*?)(?:<\/a>)?\s*<\/h3>/i,
        );
        const fecha = card.match(/<p[^>]*class="[^"]*evento-fecha[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        if (!title) continue;

        const name = stripTags(title[2]);
        if (!name) continue;
        const dates = fecha ? parseSpanishDateRange(stripTags(fecha[1]), Number(year)) : null;
        if (!dates) continue;
        if ((dates.endDate ?? dates.startDate) < today) continue;

        const pabellon = stripTags(card).match(/pabell[oó]n[a-z0-9\s-]*/i)?.[0]?.trim();
        const scraped: ScrapedEvent = {
          name,
          url: title[1] || undefined,
          venue: pabellon ? `BA Ferial — ${pabellon}` : "BA Ferial",
          ...dates,
        };
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/📅/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
