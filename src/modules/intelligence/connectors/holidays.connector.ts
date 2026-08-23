// Connector Holidays (spec §5): feriados nacionales de países emisores +
// receptor vía Nager.Date (gratis, sin key, dato oficial → confidence 1.0).
// Cadencia anual con refresh mensual para feriados trasladados por decreto.

import { v4 as uuid } from "uuid";
import { HOLIDAYS_CONFIG } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const NAGER_BASE = "https://date.nager.at/api/v3";

interface NagerHoliday {
  date: string; // YYYY-MM-DD
  localName: string;
  name: string;
  countryCode: string;
  global: boolean;
  counties: string[] | null;
  types?: string[];
}

export function createHolidaysConnector(): Connector {
  return {
    name: "holidays",

    async healthCheck() {
      try {
        const year = new Date().getUTCFullYear();
        const res = await fetchJson<NagerHoliday[]>(
          `${NAGER_BASE}/PublicHolidays/${year}/AR`,
          { retries: 0 },
        );
        return { ok: Array.isArray(res) && res.length > 0, detail: "date.nager.at OK (sin key)" };
      } catch (err) {
        return { ok: false, detail: `date.nager.at inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const currentYear = new Date().getUTCFullYear();
      const years = Array.from(
        { length: HOLIDAYS_CONFIG.yearsAhead + 1 },
        (_, i) => currentYear + i,
      );

      const signals: Signal[] = [];
      const errors: string[] = [];

      const jobs: Array<{ year: number; countryCode: string }> = [];
      for (const countryCode of HOLIDAYS_CONFIG.countryCodes)
        for (const year of years) jobs.push({ year, countryCode });

      await Promise.allSettled(
        jobs.map(async ({ year, countryCode }) => {
          try {
            const holidays = await fetchJson<NagerHoliday[]>(
              `${NAGER_BASE}/PublicHolidays/${year}/${countryCode}`,
            );
            for (const h of holidays) {
              signals.push({
                id: uuid(),
                type: "holiday",
                source: "nager-date",
                scope: { geo: { countryCode } },
                timeWindow: {
                  start: `${h.date}T00:00:00Z`,
                  end: `${h.date}T23:59:59Z`,
                },
                // Feriados nacionales completos pesan más que regionales.
                magnitude: h.global ? 1.0 : 0.6,
                confidence: SOURCE_CONFIDENCE["nager-date"],
                rawPayload: h as unknown as Record<string, unknown>,
                ingestedAt: "",
                dedupeKey: `holiday:${countryCode}:${h.date}:${h.localName}`,
              });
            }
          } catch (err) {
            errors.push(`${countryCode}/${year}: ${(err as Error).message}`);
          }
        }),
      );

      return {
        signals,
        meta: {
          countries: HOLIDAYS_CONFIG.countryCodes,
          years,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
