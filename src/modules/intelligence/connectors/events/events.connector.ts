// Connector Events (spec §3): la señal de mayor impacto directo en
// ocupación. Tres sub-fuentes combinadas en un connector lógico:
// Ticketmaster (0.85), Eventbrite (0.6, limitado a eventos propios del
// token) y scrapers propios por mercado (0.4). Cada sub-fuente cae de forma
// independiente sin frenar a las demás.

import { EVENTS_CONFIG } from "../../core/intelligence.config";
import type { Connector, ConnectorFetchResult, Signal } from "../../core/signal.types";
import { fetchTicketmasterSignals, isTicketmasterConfigured } from "./ticketmaster";
import { fetchEventbriteSignals, isEventbriteConfigured } from "./eventbrite";
import { activePlugins, runScrapers } from "./scrapers/registry";
import { isPointsOnlySweep } from "../../core/cities.catalog";

export function createEventsConnector(): Connector {
  return {
    name: "events",

    async healthCheck() {
      const parts: string[] = [];
      parts.push(
        isTicketmasterConfigured() ? "ticketmaster: OK" : "ticketmaster: sin TICKETMASTER_API_KEY",
      );
      parts.push(
        isEventbriteConfigured()
          ? "eventbrite: OK (solo eventos de organizaciones del token)"
          : "eventbrite: sin EVENTBRITE_TOKEN",
      );
      parts.push(`scrapers activos: ${activePlugins().map((p) => p.sourceLabel).join(", ") || "ninguno"}`);
      const ok = isTicketmasterConfigured() || activePlugins().length > 0;
      return { ok, detail: parts.join(" | ") };
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const signals: Signal[] = [];
      const errors: string[] = [];
      const meta: Record<string, unknown> = { sources: EVENTS_CONFIG.sources };

      const tasks: Array<Promise<void>> = [];

      if (EVENTS_CONFIG.sources.includes("ticketmaster")) {
        tasks.push(
          fetchTicketmasterSignals().then((r) => {
            signals.push(...r.signals);
            errors.push(...r.errors.map((e) => `ticketmaster ${e}`));
            meta.ticketmaster = { count: r.signals.length, ...r.meta };
          }),
        );
      }
      if (EVENTS_CONFIG.sources.includes("eventbrite")) {
        tasks.push(
          fetchEventbriteSignals().then((r) => {
            signals.push(...r.signals);
            errors.push(...r.errors.map((e) => `eventbrite ${e}`));
            meta.eventbrite = r.signals.length;
          }),
        );
      }
      if (EVENTS_CONFIG.sources.includes("scraper")) {
        tasks.push(
          // Barrido dirigido a puntos (alta de una property): solo el plugin
          // geolocalizado (meetup); las agendas por mercado corren en el cron.
          runScrapers(isPointsOnlySweep() ? ["meetup"] : undefined).then((r) => {
            signals.push(...r.signals);
            errors.push(...r.errors.map((e) => `scraper ${e}`));
            meta.scrapers = r.perPlugin;
          }),
        );
      }

      // allSettled: una sub-fuente caída nunca frena a las demás (spec §3.3).
      const settled = await Promise.allSettled(tasks);
      for (const s of settled) {
        if (s.status === "rejected") {
          errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
        }
      }

      return {
        signals,
        meta: { ...meta, produced: signals.length, ...(errors.length ? { errors } : {}) },
      };
    },
  };
}
