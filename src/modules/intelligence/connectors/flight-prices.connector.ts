// Connector Flight Prices (RADAR-DEMAND-DATA-SPEC.md #15): la tarifa más
// barata HOY para volar cada corredor piloto en +14/+30/+60 días, vía
// Amadeus Self-Service. AeroDataBox mide CAPACIDAD (cuántos asientos
// vuelan); esto mide DEMANDA DIRIGIDA: si el mismo vuelo se encarece, el
// avión se está llenando — y esa gente va a dormir en algún lado.
//
// magnitude = posición del precio actual contra el rolling de 90 días del
// propio corredor (HistoryReader, mismo patrón que FX): 0.5 neutro, >0.5
// encareciendo (demanda ↑), <0.5 abaratando. Las primeras corridas, sin
// histórico, quedan en 0.5 y el baseline se construye solo.
//
// Gated por AMADEUS_API_KEY/SECRET (gratis en developers.amadeus.com; el
// entorno test devuelve data cacheada — suficiente para validar pipeline).

import { v4 as uuid } from "uuid";
import { FLIGHTS_CONFIG, FLIGHT_PRICES_CONFIG } from "../core/intelligence.config";
import { airportByIata } from "../core/intelligence.config";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type HistoryReader,
  type Signal,
} from "../core/signal.types";

interface AmadeusToken {
  access_token: string;
  expires_in: number;
}

interface FlightOffer {
  price?: { grandTotal?: string; currency?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(): Promise<string> {
  const res = await fetch(`${FLIGHT_PRICES_CONFIG.baseUrl}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: FLIGHT_PRICES_CONFIG.apiKey ?? "",
      client_secret: FLIGHT_PRICES_CONFIG.apiSecret ?? "",
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`amadeus oauth HTTP ${res.status}`);
  const token = (await res.json()) as AmadeusToken;
  if (!token.access_token) throw new Error("amadeus oauth sin access_token");
  return token.access_token;
}

async function cheapestOffer(
  token: string,
  origin: string,
  destination: string,
  departureDate: string,
): Promise<{ price: number; currency: string } | null> {
  const params = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    adults: "1",
    max: "5",
    currencyCode: FLIGHT_PRICES_CONFIG.currency,
  });
  const res = await fetch(
    `${FLIGHT_PRICES_CONFIG.baseUrl}/v2/shopping/flight-offers?${params}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25_000),
    },
  );
  // 400 en test suele ser corredor sin data cacheada: no es un error duro.
  if (res.status === 400 || res.status === 404) return null;
  if (res.status === 429) throw new Error("amadeus rate limit (429)");
  if (!res.ok) throw new Error(`amadeus offers HTTP ${res.status}`);
  const body = (await res.json()) as { data?: FlightOffer[] };
  const prices = (body.data ?? [])
    .map((o) => Number(o.price?.grandTotal))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length === 0) return null;
  return {
    price: Math.min(...prices),
    currency: body.data?.[0]?.price?.currency ?? FLIGHT_PRICES_CONFIG.currency,
  };
}

export function createFlightPricesConnector(history: HistoryReader): Connector {
  const configured = Boolean(FLIGHT_PRICES_CONFIG.apiKey && FLIGHT_PRICES_CONFIG.apiSecret);

  return {
    name: "flight-prices",

    async healthCheck() {
      if (!configured) {
        return {
          ok: false,
          detail: "Sin AMADEUS_API_KEY/AMADEUS_API_SECRET (gratis en developers.amadeus.com)",
        };
      }
      try {
        await getToken();
        return { ok: true, detail: `amadeus OK (${FLIGHT_PRICES_CONFIG.baseUrl.includes("test") ? "test" : "production"})` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      if (!configured) {
        return { signals: [], meta: { skipped: "Sin credenciales Amadeus" } };
      }

      const token = await getToken();
      const signals: Signal[] = [];
      const errors: string[] = [];
      let noData = 0;

      for (const corridor of FLIGHTS_CONFIG.corridors) {
        const destAirport = airportByIata(corridor.destination);
        if (!destAirport) continue;

        for (const horizon of FLIGHT_PRICES_CONFIG.horizonsDays) {
          const departureDate = new Date(Date.now() + horizon * 86_400_000)
            .toISOString()
            .slice(0, 10);
          try {
            await sleep(250);
            const offer = await cheapestOffer(
              token,
              corridor.origin,
              corridor.destination,
              departureDate,
            );
            if (!offer) {
              noData++;
              continue;
            }

            const avg90d = await history.rollingAvgFlightPrice(
              corridor.origin,
              corridor.destination,
              90,
            );
            const ratio = avg90d && avg90d > 0 ? offer.price / avg90d : null;
            // ±0.8 por unidad de ratio: +25 % de precio ≈ magnitude 0.7.
            const magnitude =
              ratio === null
                ? 0.5
                : Math.min(0.95, Math.max(0.05, 0.5 + (ratio - 1) * 0.8));

            signals.push({
              id: uuid(),
              type: "flight_price",
              source: "amadeus",
              scope: {
                // Anclado al aeropuerto receptor, como flight_volume: la
                // señal es demanda entrando al destino.
                geo: {
                  lat: destAirport.lat,
                  lng: destAirport.lng,
                  airportCode: destAirport.iata,
                  countryCode: destAirport.countryCode,
                  city: destAirport.city,
                },
              },
              timeWindow: {
                start: `${departureDate}T00:00:00Z`,
                end: `${departureDate}T23:59:59Z`,
              },
              magnitude,
              confidence: SOURCE_CONFIDENCE.amadeus,
              rawPayload: {
                origin: corridor.origin,
                destination: corridor.destination,
                departureDate,
                horizonDays: horizon,
                priceUsd: offer.price,
                currency: offer.currency,
                avg90d,
                ratio,
              },
              ingestedAt: "",
              // Un precio por corredor+fecha de salida; la corrida siguiente
              // sobre la misma fecha lo actualiza (foto más fresca).
              dedupeKey: `flightprice:${corridor.origin}-${corridor.destination}:${departureDate}`,
            });
          } catch (err) {
            errors.push(`${corridor.origin}-${corridor.destination}+${horizon}d: ${(err as Error).message}`);
          }
        }
      }

      return {
        signals,
        meta: {
          corridors: FLIGHTS_CONFIG.corridors.length,
          horizons: FLIGHT_PRICES_CONFIG.horizonsDays,
          noData,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
