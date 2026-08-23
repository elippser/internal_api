// Prueba en vivo de los plugins de eventos por mercado, sin base de datos.
//
//   npm run test:scrapers                    # todos los activos
//   npm run test:scrapers -- fr-paris-opendata
//
// Imprime por plugin: cantidad de señales, coordenadas distintas (la métrica
// que importa: eventos apilados en un punto no sirven en el mapa) y una
// muestra normalizada.

import "dotenv/config";
import { activePlugins } from "../modules/intelligence/connectors/events/scrapers/registry";

async function main() {
  const only = process.argv[2];
  const plugins = activePlugins().filter((p) => !only || p.sourceLabel === only);

  if (plugins.length === 0) {
    console.log("Sin plugins activos que coincidan.");
    return;
  }

  let grandTotal = 0;
  for (const plugin of plugins) {
    const t0 = Date.now();
    console.log(`\n━━━ ${plugin.sourceLabel} (${plugin.marketCode}, ${plugin.kind}) ━━━`);
    try {
      const signals = await plugin.scrape();
      grandTotal += signals.length;
      const coords = new Set(
        signals.map(
          (s) => `${s.scope.geo.lat?.toFixed(3)},${s.scope.geo.lng?.toFixed(3)}`,
        ),
      );
      const withOwnCoords = signals.filter((s) => s.rawPayload.approxLocation === false).length;
      console.log(
        `${signals.length} señales · ${coords.size} coordenadas distintas · ` +
          `${withOwnCoords} con geo propia · ${Date.now() - t0}ms`,
      );
      const s = signals[0];
      if (s) {
        console.log(
          "sample:",
          JSON.stringify(
            {
              name: s.rawPayload.name,
              geo: s.scope.geo,
              window: s.timeWindow,
              magnitude: s.magnitude,
              confidence: s.confidence,
            },
            null,
            1,
          ),
        );
      }
    } catch (err) {
      console.error("FALLÓ:", (err as Error).message);
    }
  }
  console.log(`\nTOTAL: ${grandTotal} señales de ${plugins.length} plugin(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
