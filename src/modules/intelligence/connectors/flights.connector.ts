// Connector Flights (spec §2): volumen de llegadas por aeropuerto monitoreado
// por día vía AeroDataBox. Un Signal por aeropuerto+día (no por vuelo), con
// desglose por país de origen en rawPayload para cortar el estudio por
// corredor emisor→receptor.
//
// La API limita cada consulta FIDS a una ventana máxima de 12 horas, así que
// un día completo son 2 llamadas por aeropuerto. Costo: windowDays ×
// watchedAirports × 2 llamadas por corrida diaria — con el tier free
// (~600/mes) mantener IH_FLIGHTS_WINDOW_DAYS=2 y 4 aeropuertos (≈480/mes).
//
// Sin AERODATABOX_API_KEY el connector reporta estado degradado en el
// health check y devuelve 0 señales sin romper el resto del pipeline.

import { v4 as uuid } from "uuid";
import { FLIGHTS_CONFIG, airportByIata } from "../core/intelligence.config";
import { fetchJson, HttpError } from "../core/http";
import { normalizeVsRollingAvg, addDays, toDayISO } from "../core/normalize";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type HistoryReader,
  type Signal,
} from "../core/signal.types";

interface AdbFlight {
  number?: string;
  airline?: { name?: string; iata?: string };
  movement?: {
    airport?: { iata?: string; icao?: string; name?: string };
    scheduledTime?: { utc?: string; local?: string };
  };
  status?: string;
  codeshareStatus?: string;
  aircraft?: { model?: string };
}

interface AdbFidsResponse {
  departures?: AdbFlight[];
  arrivals?: AdbFlight[];
}

type AdbProvider = "rapidapi" | "apimarket";

function providerConfig(): { baseUrl: string; headers: Record<string, string> } | null {
  const key = process.env.AERODATABOX_API_KEY;
  if (!key) return null;
  const provider = (process.env.AERODATABOX_PROVIDER ?? "rapidapi") as AdbProvider;
  if (provider === "apimarket") {
    return {
      baseUrl: "https://prod.api.market/api/v1/aedbx/aerodatabox",
      headers: { "x-api-market-key": key },
    };
  }
  return {
    baseUrl: "https://aerodatabox.p.rapidapi.com",
    headers: {
      "X-RapidAPI-Key": key,
      "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
    },
  };
}

export function createFlightsConnector(history: HistoryReader): Connector {
  return {
    name: "flights",

    async healthCheck() {
      const cfg = providerConfig();
      if (!cfg) {
        return {
          ok: false,
          detail:
            "AERODATABOX_API_KEY no configurada — conseguir key en rapidapi.com " +
            "(AeroDataBox, header X-RapidAPI-Key) o api.market y setearla en .env",
        };
      }
      try {
        await fetchJson(`${cfg.baseUrl}/airports/iata/EZE`, {
          headers: cfg.headers,
          retries: 0,
        });
        return { ok: true, detail: "AeroDataBox OK" };
      } catch (err) {
        return { ok: false, detail: `AeroDataBox inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const cfg = providerConfig();
      if (!cfg) {
        return {
          signals: [],
          meta: { degraded: true, reason: "AERODATABOX_API_KEY no configurada" },
        };
      }

      const signals: Signal[] = [];
      const errors: string[] = [];
      const today = new Date();

      // Secuencial por aeropuerto para no gatillar el rate limit del
      // provider; 429 hace backoff en fetchJson y, si persiste, se registra
      // y se sigue con el resto (spec §2: nunca bloquear a los demás).
      for (const airportCode of FLIGHTS_CONFIG.watchedAirports) {
        for (let d = 0; d < FLIGHTS_CONFIG.windowDays; d++) {
          const day = toDayISO(addDays(today, d));
          try {
            const flights = await fetchDayArrivals(cfg, airportCode, day);
            signals.push(buildSignal(airportCode, day, flights, await rolling(airportCode)));
          } catch (err) {
            if (err instanceof HttpError && err.status === 404) {
              // Sin datos ese día: la ausencia también es información,
              // pero de baja confianza (spec §2).
              signals.push({
                ...emptySignal(airportCode, day),
                magnitude: 0,
                confidence: 0.3,
              });
            } else {
              errors.push(`${airportCode}/${day}: ${(err as Error).message}`);
            }
          }
        }
      }

      return {
        signals,
        meta: {
          watchedAirports: FLIGHTS_CONFIG.watchedAirports,
          windowDays: FLIGHTS_CONFIG.windowDays,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };

      async function rolling(airportCode: string): Promise<number | null> {
        return history.rollingAvgFlightCount(airportCode, 90);
      }
    },
  };
}

async function fetchDayArrivals(
  cfg: { baseUrl: string; headers: Record<string, string> },
  airportCode: string,
  day: string,
): Promise<AdbFlight[]> {
  // Ventana máxima 12h ⇒ el día se cubre en dos mitades (hora local).
  const halves: Array<[string, string]> = [
    [`${day}T00:00`, `${day}T11:59`],
    [`${day}T12:00`, `${day}T23:59`],
  ];
  const arrivals: AdbFlight[] = [];
  for (const [from, to] of halves) {
    const url =
      `${cfg.baseUrl}/flights/airports/iata/${airportCode}/${from}/${to}` +
      `?direction=Arrival&withLeg=false&withCancelled=false&withCodeshared=false` +
      `&withCargo=false&withPrivate=false`;
    const res = await fetchJson<AdbFidsResponse>(url, { headers: cfg.headers });
    arrivals.push(...(res.arrivals ?? []));
  }
  return arrivals;
}

function buildSignal(
  airportCode: string,
  day: string,
  arrivals: AdbFlight[],
  rollingAvg: number | null,
): Signal {
  // En arrivals[], movement.airport es el aeropuerto de ORIGEN.
  const byOriginCountry: Record<string, number> = {};
  const byOriginAirport: Record<string, number> = {};
  for (const f of arrivals) {
    const originIata = f.movement?.airport?.iata;
    if (!originIata) continue;
    byOriginAirport[originIata] = (byOriginAirport[originIata] ?? 0) + 1;
    const country = airportByIata(originIata)?.countryCode ?? "??";
    byOriginCountry[country] = (byOriginCountry[country] ?? 0) + 1;
  }

  const corridorCounts = FLIGHTS_CONFIG.corridors
    .filter((c) => c.destination === airportCode)
    .map((c) => ({ ...c, flights: byOriginAirport[c.origin] ?? 0 }));

  const base = emptySignal(airportCode, day);
  return {
    ...base,
    magnitude: normalizeVsRollingAvg(arrivals.length, rollingAvg),
    confidence: SOURCE_CONFIDENCE.aerodatabox,
    rawPayload: {
      flightCount: arrivals.length,
      byOriginCountry,
      corridors: corridorCounts,
      rolling90dAvg: rollingAvg,
      sample: arrivals.slice(0, 5),
    },
  };
}

function emptySignal(airportCode: string, day: string): Signal {
  const airport = airportByIata(airportCode);
  return {
    id: uuid(),
    type: "flight_volume",
    source: "aerodatabox",
    scope: {
      geo: {
        airportCode,
        countryCode: airport?.countryCode,
        city: airport?.city,
        lat: airport?.lat,
        lng: airport?.lng,
      },
    },
    timeWindow: { start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z` },
    magnitude: 0,
    confidence: 0.3,
    rawPayload: { flightCount: 0 },
    ingestedAt: "",
    dedupeKey: `flights:${airportCode}:${day}`,
  };
}
