import fs from "fs";
import path from "path";
import { APP_IDS, HUBS } from "../modules/metrics/appCatalog";

/**
 * Verifica que el catálogo de hubs/apps de metrics siga en sync con el del PMS.
 *
 *   npm run verify:app-catalog
 *
 * `appCatalog.ts` es una copia deliberada de `pms-core/api/src/constants/`
 * (internal-laupser no importa código del PMS). Una copia sin chequeo se
 * desincroniza en silencio: si el PMS agrega una app, sus métricas no se
 * agrupan en ningún hub y desaparecen del tablero sin que nadie se entere.
 */

const PMS_CATALOG = path.resolve(
  __dirname,
  "../../../../pms-core/api/src/constants/appCatalog.ts",
);

function parsePmsAppIds(source: string): string[] {
  const block = source.match(/OS_APP_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) throw new Error("No se pudo leer OS_APP_IDS del catálogo del PMS");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function main(): void {
  if (!fs.existsSync(PMS_CATALOG)) {
    console.log(`[catalog] no se encontró el catálogo del PMS en ${PMS_CATALOG}`);
    console.log("[catalog] omitido (¿repo del PMS ausente en este entorno?)");
    return;
  }

  const pmsIds = parsePmsAppIds(fs.readFileSync(PMS_CATALOG, "utf8"));
  const mine = new Set(APP_IDS);

  // Las superficies públicas (motor, sitio, linkhub, staypass, bookfer-ia) son
  // propias de métricas: no están en OS_APP_IDS y no deben reclamarse como falta.
  const extra = new Set(
    APP_IDS.filter((a) => !HUBS.some((h) => h.apps.includes(a))),
  );

  const missing = pmsIds.filter((id) => !mine.has(id));
  const stale = [...mine].filter((id) => !extra.has(id) && !pmsIds.includes(id));

  console.log(`[catalog] apps en el PMS      : ${pmsIds.length}`);
  console.log(`[catalog] apps en metrics     : ${HUBS.flatMap((h) => h.apps).length}`);
  console.log(`[catalog] superficies propias : ${extra.size} (${[...extra].join(", ")})`);

  let failed = false;
  if (missing.length) {
    failed = true;
    console.error(`[catalog] FALTAN en metrics/appCatalog.ts: ${missing.join(", ")}`);
  }
  if (stale.length) {
    failed = true;
    console.error(`[catalog] SOBRAN en metrics/appCatalog.ts: ${stale.join(", ")}`);
  }

  if (failed) {
    console.error(
      "[catalog] actualizá src/modules/metrics/appCatalog.ts para que coincida.",
    );
    process.exit(1);
  }
  console.log("[catalog] en sync ✔");
}

main();
