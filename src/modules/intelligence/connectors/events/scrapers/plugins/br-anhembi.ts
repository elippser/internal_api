// Plugin Distrito Anhembi, São Paulo (mercado emisor BR): agenda del
// principal complejo ferial de São Paulo. Verificado (ago-2026):
// https://distritoanhembi.com.br/agenda/ es server-rendered (WordPress +
// Modern Events Calendar) con un bloque JSON-LD schema.org/Event por
// evento; robots.txt lo permite.
//
// Se eligió Anhembi en lugar de São Paulo Expo porque saopauloexpo.com.br
// bloquea explícitamente bots de IA en su robots.txt — se respeta.
// Limitación conocida: la página muestra el mes corriente (la navegación a
// meses futuros es AJAX de MEC); la corrida semanal del cron va cubriendo
// los meses a medida que avanzan.

import { fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

const AGENDA_URL = "https://distritoanhembi.com.br/agenda/";

const CTX = {
  sourceLabel: "br-anhembi",
  countryCode: "BR",
  city: "São Paulo",
  lat: -23.5151,
  lng: -46.6367,
  defaultCategory: "fair",
};

interface JsonLdEvent {
  "@type"?: string;
  name?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  location?: { name?: string };
}

export const anhembiPlugin: ScraperPlugin = {
  marketCode: "BR",
  sourceLabel: CTX.sourceLabel,
  kind: "html",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    try {
      const html = await fetchText(AGENDA_URL);
      const today = new Date().toISOString().slice(0, 10);
      const signals: Signal[] = [];

      const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(m[1].trim());
        } catch {
          continue;
        }
        const items: JsonLdEvent[] = Array.isArray(parsed) ? parsed : [parsed as JsonLdEvent];
        for (const ev of items) {
          if (ev?.["@type"] !== "Event" || !ev.startDate) continue;
          const startDate = ev.startDate.slice(0, 10);
          if (startDate < today) continue;
          // Algunos bloques MEC vienen sin name: se intenta recuperar del
          // título de la card más cercana; si no, se descarta.
          const name = ev.name ?? nearestTitle(html, m.index);
          if (!name) continue;
          const scraped: ScrapedEvent = {
            name,
            startDate,
            endDate: ev.endDate?.slice(0, 10),
            venue: ev.location?.name ?? "Distrito Anhembi",
            url: ev.url,
          };
          const signal = scrapedToSignal(scraped, CTX);
          if (signal) signals.push(signal);
        }
      }
      return signals;
    } catch (err) {
      console.error(`[intelligence] scraper ${CTX.sourceLabel} falló:`, (err as Error).message);
      return [];
    }
  },
};

// Busca hacia atrás el último <h3 class="mec-event-title"><a ...>Título</a>
// antes de la posición del bloque JSON-LD.
function nearestTitle(html: string, before: number): string | undefined {
  const slice = html.slice(Math.max(0, before - 6000), before);
  const titles = [...slice.matchAll(/<h3[^>]*class="[^"]*mec-event-title[^"]*"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)];
  const last = titles[titles.length - 1]?.[1];
  return last ? last.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : undefined;
}
