// Scheduler del intelligence-hub (spec §8): cada connector con su cadencia.
// Todos los horarios en America/Argentina/Buenos_Aires (ART), corridas en
// horas de baja carga de los providers.
//
//   flights   diaria 03:00       (spec §2)
//   weather   diaria 03:30       (spec §6)
//   fx        cada 6 horas       (spec §4)
//   events    diaria 05:00       (spec §3 pide semanal + refresh diario de
//                                 cancelaciones; con el upsert por dedupeKey
//                                 la corrida diaria completa cumple ambos a
//                                 costo despreciable: ~30 calls/día)
//   holidays  mensual día 1 04:00 (spec §5: anual + refresh por decretos)
//   trends    semanal lunes 06:00 (spec §7)
//   school-holidays  mensual día 2 04:15 (calendarios casi estáticos intra-año)
//   sports    diaria 05:45        (fixtures se reprograman semana a semana)
//   venues    mensual día 3 02:30 (el stock de estadios/predios no cambia
//                                  más rápido; corrida larga contra Overpass)
//   lodging   mensual día 5 01:00 (inventario de oferta; la corrida más larga
//                                  del hub — Overpass sobre 2 tiers de ciudades)
//   cruises   semanal domingo 02:00 (itinerarios publicados con meses de lead;
//                                  corrida larga: calendario + detalle por fecha)
//   bandsintown  diaria 06:15     (fechas nuevas se anuncian a diario; gated
//                                  por IH_BANDSINTOWN_APP_ID, sin key no hace nada)
//   flight-prices  lunes y jueves 03:45 (2 fotos/semana construyen baseline sin
//                                  quemar cuota Amadeus; gated por key)
//   str-supply  mensual día 4 01:30 (dumps InsideAirbnb trimestrales; CSV pesados)
//   health-alerts  diaria 06:30   (WHO publica DONs a cualquier hora; barato)

import cron from "node-cron";
import { ingestAll, ingestConnector } from "./intelligence.service";

const TZ = "America/Argentina/Buenos_Aires";

let started = false;

export function startIntelligenceCron() {
  if (started) return;
  started = true;

  if (process.env.IH_CRON_DISABLED === "1") {
    console.log("[intelligence] cron deshabilitado (IH_CRON_DISABLED=1)");
    return;
  }

  const schedule = (expr: string, connector: string) => {
    cron.schedule(
      expr,
      () => {
        ingestConnector(connector, "cron").catch((err) =>
          console.error(`[intelligence] cron ${connector} falló:`, err),
        );
      },
      { timezone: TZ },
    );
  };

  schedule("0 3 * * *", "flights");
  schedule("30 3 * * *", "weather");
  schedule("0 */6 * * *", "fx");
  schedule("0 5 * * *", "events");
  schedule("0 4 1 * *", "holidays");
  schedule("0 6 * * 1", "trends");
  schedule("15 4 2 * *", "school-holidays");
  schedule("45 5 * * *", "sports");
  schedule("30 2 3 * *", "venues");
  schedule("0 1 5 * *", "lodging");
  schedule("0 2 * * 0", "cruises");
  schedule("15 6 * * *", "bandsintown");
  schedule("45 3 * * 1,4", "flight-prices");
  schedule("30 1 4 * *", "str-supply");
  schedule("30 6 * * *", "health-alerts");

  console.log(
    "[intelligence] crons programados (flights/weather/fx/events/holidays/trends/school-holidays/sports/venues/lodging/cruises/bandsintown/flight-prices/str-supply/health-alerts)",
  );

  // Primera carga al arrancar (por defecto activa): puebla la base con los
  // connectors gratuitos y los de eventos para que el radar tenga datos sin
  // esperar al próximo cron. flights/trends quedan fuera (consumen cuota de
  // AeroDataBox / dependen del microservicio Python). venues también: la
  // corrida Overpass es larga — primera carga manual vía
  // POST /ingest/venues o IH_VENUES_ON_STARTUP=1.
  if (process.env.IH_INGEST_ON_STARTUP !== "0") {
    // bandsintown y health-alerts entran (baratos; el primero gated por
    // key). cruises, str-supply, venues y lodging quedan fuera (corridas
    // largas) — primera carga con POST /ingest/<connector>.
    // flight-prices queda fuera por cuota Amadeus, como flights.
    const startupConnectors = ["fx", "holidays", "weather", "events", "school-holidays", "sports", "bandsintown", "health-alerts"];
    if (process.env.IH_VENUES_ON_STARTUP === "1") startupConnectors.push("venues");
    setTimeout(() => {
      ingestAll("startup", startupConnectors).catch((err) =>
        console.error("[intelligence] ingesta inicial falló:", err),
      );
    }, 10_000);
  }
}
