// Plugin ICS genérico (RADAR-DEMAND-DATA-SPEC.md #11): cualquier portal
// regional que publique agenda iCal entra por config — una entrada en
// ICS_FEEDS (intelligence.config.ts) o en IH_ICS_FEEDS (JSON por env) — sin
// escribir código nuevo. Parser mínimo de VEVENT sin dependencias: DTSTART/
// DTEND/SUMMARY/LOCATION/URL/GEO, con unfolding RFC 5545.

import { activeIcsFeeds, type IcsFeed } from "../../../../core/intelligence.config";
import { fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import { scrapedToSignal, type ScraperContext } from "../normalize";
import type { ScrapedEvent, ScraperPlugin } from "../types";

// RFC 5545 §3.1: las líneas largas se pliegan con CRLF + espacio/tab.
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
}

// "20260312", "20260312T203000Z", "20260312T203000" → YYYY-MM-DD
function icsDate(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

interface ParsedVevent {
  summary?: string;
  dtstart?: string;
  dtend?: string;
  location?: string;
  url?: string;
  lat?: number;
  lng?: number;
}

export function parseIcs(ics: string): ParsedVevent[] {
  const events: ParsedVevent[] = [];
  let current: ParsedVevent | null = null;

  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    const key = rawKey.split(";")[0].toUpperCase();

    switch (key) {
      case "SUMMARY":
        current.summary = value.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " ");
        break;
      case "DTSTART":
        current.dtstart = icsDate(value) ?? undefined;
        break;
      case "DTEND":
        current.dtend = icsDate(value) ?? undefined;
        break;
      case "LOCATION":
        current.location = value.replace(/\\,/g, ",").replace(/\\;/g, ";");
        break;
      case "URL":
        current.url = value;
        break;
      case "GEO": {
        // GEO:lat;lng
        const [latS, lngS] = value.split(";");
        const lat = Number(latS);
        const lng = Number(lngS);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          current.lat = lat;
          current.lng = lng;
        }
        break;
      }
    }
  }
  return events;
}

function makePlugin(feed: IcsFeed): ScraperPlugin {
  return {
    marketCode: feed.countryCode,
    sourceLabel: `ics-${feed.label}`,
    kind: "ical",
    enabled: true,
    async scrape(): Promise<Signal[]> {
      try {
        const ics = await fetchText(feed.url, { timeoutMs: 25_000 });
        const today = new Date().toISOString().slice(0, 10);
        const ctx: ScraperContext = {
          sourceLabel: `ics-${feed.label}`,
          countryCode: feed.countryCode,
          city: feed.city,
          lat: feed.lat,
          lng: feed.lng,
          fallbackSpreadKm: feed.spreadKm ?? 3,
          kind: "ical",
        };
        const signals: Signal[] = [];
        for (const ev of parseIcs(ics)) {
          if (!ev.summary || !ev.dtstart) continue;
          if ((ev.dtend ?? ev.dtstart) < today) continue; // solo futuro/vigente
          const scraped: ScrapedEvent = {
            name: ev.summary,
            startDate: ev.dtstart,
            endDate: ev.dtend,
            venue: ev.location,
            url: ev.url,
            lat: ev.lat,
            lng: ev.lng,
          };
          const signal = scrapedToSignal(scraped, ctx);
          if (signal) signals.push(signal);
        }
        return signals;
      } catch (err) {
        console.error(`[ih-scraper-ics-${feed.label}]`, (err as Error).message);
        return [];
      }
    },
  };
}

// Se evalúa al armar el registry; los feeds por env entran en el próximo boot.
export function icsPlugins(): ScraperPlugin[] {
  return activeIcsFeeds().map(makePlugin);
}
