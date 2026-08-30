// Prueba en vivo del hub de estacionalidad climática SIN base de datos:
// pega contra las fuentes reales (Open-Meteo, NASA POWER, NOAA CPC) para un
// puñado de puntos con estacionalidades bien distintas e imprime el resumen.
//
//   npm run test:climate                      # los 6 puntos de muestra
//   npm run test:climate -- -34.6 -58.4       # un lat/lng puntual
//
// No persiste nada — valida providers, parsing y las temporadas derivadas.

import "dotenv/config";
import { getClimatePoint } from "../modules/climate/climate.service";

/** Pausa entre puntos para no reventar el techo por minuto de Open-Meteo. */
const THROTTLE_MS = 20_000;

const MONTHS = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const names = (ms: number[]) => (ms.length ? ms.map((m) => MONTHS[m - 1]).join(" ") : "—");

const SAMPLES: Array<{ label: string; lat: number; lng: number }> = [
  { label: "Buenos Aires (templado sur)", lat: -34.6, lng: -58.4 },
  { label: "Bariloche (nieve/esquí)", lat: -41.13, lng: -71.31 },
  { label: "Cancún (huracanes Atlántico)", lat: 21.16, lng: -86.85 },
  { label: "Bombay (monzón)", lat: 19.08, lng: 72.88 },
  { label: "Kioto (cerezos/follaje)", lat: 35.01, lng: 135.77 },
  { label: "Oklahoma City (tornados)", lat: 35.47, lng: -97.52 },
];

async function run(label: string, lat: number, lng: number): Promise<boolean> {
  const t0 = Date.now();
  try {
    const d = await getClimatePoint(lat, lng);
    const ms = Date.now() - t0;
    const uvOk = d.normals.filter((n) => n.uvIndex !== null).length;

    console.log(`\n── ${label}  (${lat}, ${lng})  ${ms}ms`);
    console.log(
      `   perfil=${d.seasons.profile} amplitud=${d.seasons.amplitudeC}°C ` +
        `lluvia=${Math.round(d.seasons.annualPrecipMm)}mm${d.seasons.monsoonal ? " MONZÓNICO" : ""} ` +
        `${d.location.oceanWithinKm !== null ? `costa<${d.location.oceanWithinKm}km` : "interior"}`,
    );
    console.log(`   cálidos : ${names(d.seasons.warmest)}`);
    console.log(`   fríos   : ${names(d.seasons.coldest)}`);
    console.log(`   lluvias : ${names(d.seasons.wet)}`);
    console.log(`   seca    : ${names(d.seasons.dry)}`);
    console.log(`   nieve   : ${names(d.seasons.snow)}`);
    console.log(`   mejores : ${names(d.seasons.best)}`);
    if (d.hazards.hurricane) {
      console.log(`   ciclones: ${d.hazards.hurricane.basin} → ${names(d.hazards.hurricane.months)}`);
    }
    if (d.hazards.tornado) {
      console.log(`   tornados: ${d.hazards.tornado.region} → ${names(d.hazards.tornado.months)}`);
    }
    console.log(`   incendio: ${names(d.hazards.fireRisk)}`);
    if (d.special.foliage) console.log(`   follaje : ${names(d.special.foliage)}`);
    if (d.special.bloom) console.log(`   floración: ${names(d.special.bloom)}`);
    console.log(
      `   ENSO    : ${d.enso ? `${d.enso.phase} ONI ${d.enso.oni} (${d.enso.period})` : "sin dato"}`,
    );
    console.log(
      `   shift   : ${
        d.climateShift
          ? `${d.climateShift.annualDeltaC > 0 ? "+" : ""}${d.climateShift.annualDeltaC}°C ` +
            `(${d.climateShift.recent} vs ${d.climateShift.baseline})` +
            `${d.climateShift.trendCPerDecade !== null ? ` · tendencia ${d.climateShift.trendCPerDecade > 0 ? "+" : ""}${d.climateShift.trendCPerDecade}°C/década` : ""}`
          : "sin dato"
      }`,
    );
    const recOk = d.normals.filter((n) => n.tRecordHigh !== null).length;
    console.log(`   récords : ${recOk}/12 meses · luz solar calculada para los 12`);
    console.log(
      `   hoy     : UV=${d.current.uvIndexMaxToday ?? "—"} ` +
        `AQI=${d.current.airQuality?.europeanAqi ?? d.current.airQuality?.usAqi ?? "—"} ` +
        `nieve=${d.current.snowDepthCm ?? "—"}cm ` +
        `polen=${d.current.pollen ? "sí" : "no (fuera de Europa)"}`,
    );
    console.log(`   UV mensual: ${uvOk}/12 meses con dato de NASA POWER`);

    if (d.normals.every((n) => n.tMean === null)) {
      console.error("   ✗ normales vacías");
      return false;
    }
    return true;
  } catch (err) {
    console.error(`\n── ${label}  ✗ ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let ok = true;

  if (args.length >= 2) {
    const lat = Number(args[0]);
    const lng = Number(args[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error("Uso: npm run test:climate -- <lat> <lng>");
      process.exit(1);
    }
    ok = await run("punto manual", lat, lng);
  } else {
    for (const [i, s] of SAMPLES.entries()) {
      // Secuencial y con freno: cada punto son 3 llamadas a Open-Meteo (una
      // de ellas, 10 años de series diarias) y todas cuentan contra el mismo
      // techo por minuto. Sin esta pausa el propio smoke se auto-limita.
      if (i > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      ok = (await run(s.label, s.lat, s.lng)) && ok;
    }
  }

  console.log(ok ? "\n✓ hub de clima OK" : "\n✗ hub de clima con fallas");
  process.exit(ok ? 0 : 1);
}

void main();
