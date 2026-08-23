// Plugin agenda oficial de Mendoza (mercado receptor AR): la agenda de
// turismo.ciudaddemendoza.gob.ar es un Google Calendar público (verificado
// ago-2026). En vez de scrapear HTML se consume el feed iCal público del
// calendario — estable y sin API key. Fallback: la API pública de Google
// Calendar con la key embebida en el propio sitio oficial.
//
// Nota de alcance: es agenda cultural/turística (teatro, música, ciclos),
// no de congresos B2B — complementa a los predios feriales.

import { fetchJson, fetchText } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

const CALENDAR_ID =
  "e1ace5d3ed6b1c20d1431217bb294e54f46d5271299246987a36199330a774f3@group.calendar.google.com";
// Key pública client-side embebida en turismo.ciudaddemendoza.gob.ar.
const PUBLIC_API_KEY = "AIzaSyAgJIwqQuNnJFTA8QR7N4Y-O6vH4MgLt9U";

const ICAL_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;

const CTX = {
  sourceLabel: "ar-mendoza-turismo",
  countryCode: "AR",
  city: "Mendoza",
  lat: -32.8895,
  lng: -68.8458,
  defaultCategory: "miscellaneous",
};

export const mendozaTurismoPlugin: ScraperPlugin = {
  marketCode: "AR",
  sourceLabel: CTX.sourceLabel,
  kind: "ical",
  enabled: true,

  async scrape(): Promise<Signal[]> {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);

    let events: ScrapedEvent[] = [];
    try {
      events = parseIcs(await fetchText(ICAL_URL));
    } catch (icalErr) {
      try {
        events = await fetchViaApi();
      } catch (apiErr) {
        console.error(
          `[intelligence] scraper ${CTX.sourceLabel} falló (ical y api):`,
          (icalErr as Error).message,
          (apiErr as Error).message,
        );
        return [];
      }
    }

    const signals: Signal[] = [];
    for (const ev of events) {
      if (ev.startDate < today || ev.startDate > horizon) continue;
      const signal = scrapedToSignal(ev, CTX);
      if (signal) signals.push(signal);
    }
    return signals;
  },
};

// Parser mínimo de VEVENT: alcanza con SUMMARY/DTSTART/DTEND/DESCRIPTION.
function parseIcs(ics: string): ScrapedEvent[] {
  // Unfolding RFC 5545: las líneas continuadas empiezan con espacio/tab.
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const events: ScrapedEvent[] = [];
  const blocks = unfolded.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const get = (prop: string): string | undefined =>
      body.match(new RegExp(`^${prop}[^:\\r\\n]*:(.*)$`, "m"))?.[1]?.trim();

    const summary = get("SUMMARY");
    const dtstart = get("DTSTART");
    if (!summary || !dtstart) continue;
    const startDate = icsDateToIso(dtstart);
    if (!startDate) continue;
    const dtend = get("DTEND");
    const description = get("DESCRIPTION") ?? "";
    const venue = description.match(/Ubicaci[oó]n:\s*([^\\\n]+)/i)?.[1]?.trim() ?? get("LOCATION");

    events.push({
      name: summary.replace(/\\,/g, ",").replace(/\\;/g, ";"),
      startDate,
      endDate: dtend ? icsDateToIso(dtend) ?? undefined : undefined,
      venue,
    });
  }
  return events;
}

function icsDateToIso(value: string): string | null {
  const m = value.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface GCalItem {
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

async function fetchViaApi(): Promise<ScrapedEvent[]> {
  const params = new URLSearchParams({
    key: PUBLIC_API_KEY,
    timeMin: new Date().toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetchJson<{ items?: GCalItem[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
  );
  const events: ScrapedEvent[] = [];
  for (const item of res.items ?? []) {
    const start = item.start?.dateTime ?? item.start?.date;
    if (!item.summary || !start) continue;
    events.push({
      name: item.summary,
      startDate: start.slice(0, 10),
      endDate: (item.end?.dateTime ?? item.end?.date)?.slice(0, 10),
      venue: item.description?.match(/Ubicaci[oó]n:\s*([^\n/]+)/i)?.[1]?.trim(),
    });
  }
  return events;
}
