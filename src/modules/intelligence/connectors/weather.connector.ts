// Connector Weather (spec §6): pronóstico 16 días por destino monitoreado
// vía Open-Meteo (gratis, sin key). magnitude = favorabilidad según el
// perfil del destino (beach/ski/trekking/urban); confidence decrece con el
// horizonte (0.9 día 1 → 0.4 día 16).
//
// Open-Meteo acepta múltiples coordenadas por llamada (latitude=a,b&longitude=
// x,y → responde un array en el mismo orden), así que el catálogo completo
// (~120 ciudades) se cubre en 3 llamadas batch en vez de una por destino.

import { v4 as uuid } from "uuid";
import { WEATHER_DESTINATIONS } from "../core/intelligence.config";
import type { WeatherDestination } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import { confidenceByHorizon, weatherFavorability } from "../core/normalize";
import type { Connector, ConnectorFetchResult, Signal } from "../core/signal.types";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const BATCH_SIZE = 50;

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: Array<number | null>;
  temperature_2m_min: Array<number | null>;
  precipitation_sum: Array<number | null>;
  weather_code?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  daily: OpenMeteoDaily;
}

function forecastUrl(dests: WeatherDestination[]): string {
  const params = new URLSearchParams({
    latitude: dests.map((d) => d.lat).join(","),
    longitude: dests.map((d) => d.lng).join(","),
    daily: "precipitation_sum,temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max",
    forecast_days: "16",
    timezone: "auto",
  });
  return `${OPEN_METEO_BASE}?${params}`;
}

// Con 1 coordenada Open-Meteo responde un objeto; con varias, un array.
async function fetchBatch(dests: WeatherDestination[]): Promise<OpenMeteoResponse[]> {
  const res = await fetchJson<OpenMeteoResponse | OpenMeteoResponse[]>(forecastUrl(dests));
  return Array.isArray(res) ? res : [res];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createWeatherConnector(): Connector {
  return {
    name: "weather",

    async healthCheck() {
      try {
        const res = await fetchBatch(WEATHER_DESTINATIONS.slice(0, 1));
        return { ok: Array.isArray(res[0]?.daily?.time), detail: "api.open-meteo.com OK (sin key)" };
      } catch (err) {
        return { ok: false, detail: `open-meteo inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const signals: Signal[] = [];
      const errors: string[] = [];
      const today = new Date().toISOString().slice(0, 10);

      await Promise.allSettled(
        chunk(WEATHER_DESTINATIONS, BATCH_SIZE).map(async (batch) => {
          try {
            const responses = await fetchBatch(batch);
            responses.forEach((res, destIdx) => {
              const dest = batch[destIdx];
              const daily = res?.daily;
              if (!dest || !daily?.time) return;
              daily.time.forEach((day, i) => {
                const daysAhead = Math.max(
                  1,
                  Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000) + 1,
                );
                const sample = {
                  tMax: daily.temperature_2m_max[i] ?? null,
                  tMin: daily.temperature_2m_min[i] ?? null,
                  precipitationMm: daily.precipitation_sum[i] ?? null,
                };
                signals.push({
                  id: uuid(),
                  type: "weather",
                  source: "open-meteo",
                  scope: {
                    geo: {
                      lat: dest.lat,
                      lng: dest.lng,
                      countryCode: dest.countryCode,
                      city: dest.label,
                    },
                  },
                  timeWindow: { start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z` },
                  magnitude: weatherFavorability(sample, dest.profile),
                  confidence: confidenceByHorizon(daysAhead),
                  rawPayload: {
                    destination: dest.label,
                    profile: dest.profile,
                    day,
                    daysAhead,
                    ...sample,
                    weatherCode: daily.weather_code?.[i] ?? null,
                    windMaxKmh: daily.wind_speed_10m_max?.[i] ?? null,
                  },
                  ingestedAt: "",
                  // El refresh diario actualiza el pronóstico del mismo día
                  // destino en vez de duplicarlo.
                  dedupeKey: `weather:${dest.label}:${day}`,
                });
              });
            });
          } catch (err) {
            errors.push(`batch ${batch[0]?.label}…${batch[batch.length - 1]?.label}: ${(err as Error).message}`);
          }
        }),
      );

      return {
        signals,
        meta: {
          destinations: WEATHER_DESTINATIONS.map((d) => d.label),
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
