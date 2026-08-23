// Plugin IFEMA Madrid (mercado emisor ES): calendario de ferias del predio
// ferial de Madrid. Fuente verificada (ago-2026): https://www.ifema.es/calendario
// es server-rendered y embebe ~43 bloques JSON-LD schema.org/Event con
// fechas ISO. robots.txt permite /calendario.

import { fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

const CALENDAR_URL = "https://www.ifema.es/calendario";

const CTX = {
  sourceLabel: "es-ifema-madrid",
  countryCode: "ES",
  city: "Madrid",
  lat: 40.4676,
  lng: -3.6169,
  defaultCategory: "fair",
};

interface JsonLdEvent {
  "@type"?: string;
  name?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  location?: { name?: string };
}

export const ifemaMadridPlugin: ScraperPlugin = {
  marketCode: "ES",
  sourceLabel: CTX.sourceLabel,
  kind: "html",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    try {
      const html = await fetchText(CALENDAR_URL);
      const events = extractJsonLdEvents(html);
      const today = new Date().toISOString().slice(0, 10);

      const signals: Signal[] = [];
      for (const ev of events) {
        if (!ev.name || !ev.startDate) continue;
        const startDate = ev.startDate.slice(0, 10);
        if (startDate < today) continue;
        const scraped: ScrapedEvent = {
          name: ev.name,
          startDate,
          endDate: ev.endDate?.slice(0, 10),
          venue: ev.location?.name ?? "IFEMA Madrid",
          url: ev.url,
        };
        const signal = scrapedToSignal(scraped, CTX);
        if (signal) signals.push(signal);
      }
      return signals;
    } catch (err) {
      // Cambio de estructura o sitio caído: loggear y devolver [] para no
      // tumbar el pipeline (spec §3.3).
      console.error(`[intelligence] scraper ${CTX.sourceLabel} falló:`, (err as Error).message);
      return [];
    }
  },
};

function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const events: JsonLdEvent[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items: JsonLdEvent[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item?.["@type"] === "Event") events.push(item);
      }
    } catch {
      // Bloque JSON-LD malformado: ignorar y seguir con el resto.
    }
  }
  return events;
}
