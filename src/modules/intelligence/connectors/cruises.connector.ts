// Connector Cruises (RADAR-DEMAND-DATA-SPEC.md #14): arribos de cruceros
// por puerto vía cruisetimetables.com (HTML estático, sin key). Un barco son
// 2-5k personas con fecha exacta; en homeports (embarque/desembarque) suman
// noches de hotel pre/post crucero — la señal fuerte para el radar.
//
// Flujo por puerto: 1 request al calendario (fechas de visita) y, con
// detail activo, 1 request por fecha dentro de la ventana para contar
// barcos y nombres. Emite un Signal por puerto-día, type "event" categoría
// "cruise" — reutiliza el pipeline y la capa ih_events completos.
//
// Regla scraper: ante cambio de HTML se loggea y el puerto devuelve 0
// señales; jamás rompe la corrida. Cadencia semanal (los itinerarios se
// publican con meses de antelación).

import { v4 as uuid } from "uuid";
import { CRUISES_CONFIG, type CruisePort } from "../core/intelligence.config";
import { fetchText } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const BASE = "https://www.cruisetimetables.com";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VisitDate {
  date: string; // YYYY-MM-DD
  detailPath: string; // visitingbuenosairesargentina-17nov2026.html
}

// El calendario enlaza cada visita como visiting<puerto>-17nov2026.html:
// la fecha se parsea del propio slug, sin depender del texto de la celda.
// Los links mensuales (…-nov2026.html, sin día) no matchean por diseño.
export function parseCalendarDates(html: string): VisitDate[] {
  const out: VisitDate[] = [];
  const seen = new Set<string>();
  const re = /href=["'](visiting[a-z-]+-(\d{1,2})([a-z]{3})(\d{4})\.html)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const month = MONTHS[m[3]];
    if (!month) continue;
    const date = `${m[4]}-${pad(month)}-${pad(Number(m[2]))}`;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, detailPath: m[1] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// "total N" cuenta itinerarios comerciales, no barcos: un mismo barco puede
// figurar en 4 cruceros distintos que hacen la misma escala. La demanda la
// dan los cascos físicos → barcos únicos; el total queda como respaldo si
// ningún link de barco parsea.
export function parseDetailShips(html: string): { count: number; ships: string[] } {
  const total = html.match(/Showing 1 to \d+ of total (\d+)/);
  const ships = [...html.matchAll(/href=["']\/cruise-ship-[a-z0-9-]+\.html["']>([^<]+)</g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const unique = [...new Set(ships)];
  const count = unique.length > 0 ? unique.length : total ? Number(total[1]) : 1;
  return { count, ships: unique };
}

// homeport pesa más que escala (pre/post estadías) y cada barco extra suma.
function magnitudeFor(port: CruisePort, shipCount: number | null): number {
  const base = port.role === "homeport" ? 0.7 : 0.55;
  if (!shipCount || shipCount <= 1) return base;
  return Math.min(1, base + 0.08 * (shipCount - 1));
}

export function createCruisesConnector(): Connector {
  return {
    name: "cruises",

    async healthCheck() {
      try {
        const html = await fetchText(`${BASE}/${CRUISES_CONFIG.ports[0]?.slug ?? "cruises-to-buenos-aires-argentina"}.html`, {
          retries: 0,
          timeoutMs: 15_000,
        });
        const dates = parseCalendarDates(html);
        return {
          ok: dates.length > 0,
          detail: dates.length > 0
            ? "cruisetimetables OK (sin key)"
            : "cruisetimetables responde pero el calendario no parsea (¿cambió el HTML?)",
        };
      } catch (err) {
        return { ok: false, detail: `cruisetimetables inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const signals: Signal[] = [];
      const errors: string[] = [];
      const perPort: Record<string, number> = {};

      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + CRUISES_CONFIG.windowDays * 86_400_000)
        .toISOString()
        .slice(0, 10);

      for (const port of CRUISES_CONFIG.ports) {
        try {
          await sleep(500);
          const calendarHtml = await fetchText(`${BASE}/${port.slug}.html`);
          const dates = parseCalendarDates(calendarHtml).filter(
            (d) => d.date >= today && d.date <= horizon,
          );

          const detailBudget = CRUISES_CONFIG.detail
            ? dates.slice(0, CRUISES_CONFIG.maxDetailPerPort)
            : [];
          const detailByDate = new Map<string, { count: number; ships: string[] }>();
          for (const d of detailBudget) {
            try {
              await sleep(400);
              const detailHtml = await fetchText(`${BASE}/${d.detailPath}`);
              detailByDate.set(d.date, parseDetailShips(detailHtml));
            } catch {
              // Sin detalle igual emitimos la señal del día con conteo nulo.
            }
          }

          for (const d of dates) {
            const detail = detailByDate.get(d.date) ?? null;
            const shipCount = detail?.count ?? null;
            const ships = detail?.ships ?? [];
            const name =
              ships.length > 0
                ? `${ships[0]}${shipCount && shipCount > 1 ? ` +${shipCount - 1}` : ""} · cruise ${port.role === "homeport" ? "turnaround" : "call"}`
                : `Cruise ${port.role === "homeport" ? "turnaround" : "call"} · ${port.label}`;

            signals.push({
              id: uuid(),
              type: "event",
              source: "cruisetimetables",
              scope: {
                geo: { lat: port.lat, lng: port.lng, countryCode: port.countryCode, city: port.label },
              },
              timeWindow: {
                start: `${d.date}T00:00:00Z`,
                end: `${d.date}T23:59:59Z`,
              },
              magnitude: magnitudeFor(port, shipCount),
              confidence: SOURCE_CONFIDENCE.cruisetimetables,
              rawPayload: {
                name,
                venue: `Puerto de ${port.label}`,
                segment: "cruise",
                category: "cruise",
                ships,
                shipCount,
                role: port.role,
                url: `${BASE}/${d.detailPath}`,
              },
              ingestedAt: "",
              dedupeKey: `event:cruise:${port.slug}:${d.date}`,
            });
          }
          perPort[port.label] = dates.length;
        } catch (err) {
          errors.push(`${port.label}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          ports: CRUISES_CONFIG.ports.length,
          windowDays: CRUISES_CONFIG.windowDays,
          detail: CRUISES_CONFIG.detail,
          perPort,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
