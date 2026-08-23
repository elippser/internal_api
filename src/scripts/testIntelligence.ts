// Prueba en vivo de los connectors del intelligence-hub SIN base de datos:
// inyecta un HistoryReader nulo (arranque en frío) y ejecuta healthCheck +
// fetch de cada connector, imprimiendo cuántas señales produce cada fuente.
//
//   npm run test:intelligence            # todos
//   npm run test:intelligence -- fx      # uno solo
//
// No persiste nada — solo valida providers, parsing y normalización.

import "dotenv/config";
import type { Connector, HistoryReader } from "../modules/intelligence/core/signal.types";
import { createFxConnector } from "../modules/intelligence/connectors/fx.connector";
import { createHolidaysConnector } from "../modules/intelligence/connectors/holidays.connector";
import { createWeatherConnector } from "../modules/intelligence/connectors/weather.connector";
import { createFlightsConnector } from "../modules/intelligence/connectors/flights.connector";
import { createEventsConnector } from "../modules/intelligence/connectors/events/events.connector";
import { createTrendsConnector } from "../modules/intelligence/connectors/trends.connector";
import { createSchoolHolidaysConnector } from "../modules/intelligence/connectors/school-holidays.connector";
import { createSportsConnector } from "../modules/intelligence/connectors/sports.connector";
import { createVenuesConnector } from "../modules/intelligence/connectors/venues.connector";
import { createLodgingConnector } from "../modules/intelligence/connectors/lodging.connector";
import { createCruisesConnector } from "../modules/intelligence/connectors/cruises.connector";
import { createBandsintownConnector } from "../modules/intelligence/connectors/bandsintown.connector";
import { createFlightPricesConnector } from "../modules/intelligence/connectors/flight-prices.connector";
import { createStrSupplyConnector } from "../modules/intelligence/connectors/str-supply.connector";
import { createHealthAlertsConnector } from "../modules/intelligence/connectors/health-alerts.connector";

const coldStart: HistoryReader = {
  rollingAvgFlightCount: async () => null,
  rollingAvgFxRate: async () => null,
  rollingAvgFlightPrice: async () => null,
};

const connectors: Connector[] = [
  createFxConnector(coldStart),
  createHolidaysConnector(),
  createWeatherConnector(),
  createFlightsConnector(coldStart),
  createEventsConnector(),
  createTrendsConnector(),
  createSchoolHolidaysConnector(),
  createSportsConnector(),
  createVenuesConnector(),
  createLodgingConnector(),
  createCruisesConnector(),
  createBandsintownConnector(),
  createFlightPricesConnector(coldStart),
  createStrSupplyConnector(),
  createHealthAlertsConnector(),
];

async function main() {
  const only = process.argv[2];
  for (const c of connectors) {
    if (only && c.name !== only) continue;
    console.log(`\n━━━ ${c.name} ━━━`);
    const health = await c.healthCheck();
    console.log(`health: ${health.ok ? "OK" : "DEGRADED"} — ${health.detail}`);
    const t0 = Date.now();
    try {
      const result = await c.fetch();
      console.log(`fetch: ${result.signals.length} señales en ${Date.now() - t0}ms`);
      if (result.meta) console.log("meta:", JSON.stringify(result.meta, null, 2));
      const sample = result.signals[0];
      if (sample) {
        console.log("sample:", JSON.stringify({
          type: sample.type,
          source: sample.source,
          scope: sample.scope,
          timeWindow: sample.timeWindow,
          magnitude: sample.magnitude,
          confidence: sample.confidence,
          dedupeKey: sample.dedupeKey,
        }, null, 2));
      }
    } catch (err) {
      console.error(`fetch FALLÓ: ${(err as Error).message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
