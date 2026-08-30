// Prueba en vivo del hub de eventos deportivos SIN base de datos.
//
//   npm run test:sports                       # 6 puntos de muestra
//   npm run test:sports -- -34.6 -58.4 400    # lat lng [radioKm]
//
// Pega contra Jolpica (F1) y contra el intelligence-hub si esta configurado;
// lo curado se resuelve local.

import "dotenv/config";
import { getSportsPoint } from "../modules/sports/sports.service";

const SAMPLES: Array<{ label: string; lat: number; lng: number; radius?: number }> = [
  { label: "Los Angeles (JJOO 2028 + Super Bowl LXI)", lat: 34.05, lng: -118.24 },
  { label: "Montevideo (partido del centenario 2030)", lat: -34.9, lng: -56.16 },
  { label: "Londres (Eurocopa 2028, Wimbledon, maraton)", lat: 51.51, lng: -0.13 },
  { label: "Monza (GP de Italia)", lat: 45.62, lng: 9.28, radius: 60 },
  { label: "Rio de Janeiro (Mundial femenino 2027)", lat: -22.91, lng: -43.17 },
  { label: "Ushuaia (fin del mundo: no deberia haber nada)", lat: -54.8, lng: -68.3 },
];

const fmtLead = (d: number): string => {
  if (d < 0) return "en curso";
  if (d < 60) return `${d}d`;
  if (d < 730) return `${Math.round(d / 30)}m`;
  return `${(d / 365).toFixed(1)}a`;
};

async function run(label: string, lat: number, lng: number, radius?: number): Promise<boolean> {
  const t0 = Date.now();
  try {
    const d = await getSportsPoint(lat, lng, radius ?? 300);
    console.log(`\n── ${label}  ${Date.now() - t0}ms`);
    console.log(`   radio ${d.location.radiusKm}km · ventana ${d.window.from} → ${d.window.to}`);
    console.log(
      `   eventos: ${d.events.length}  [${Object.entries(d.byCategory)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")}]`,
    );
    if (d.headline) {
      console.log(
        `   principal: ${d.headline.name} (${d.headline.startDate}, ${d.headline.distanceKm}km, impacto ${d.headline.impact})`,
      );
    }
    for (const e of d.events.slice(0, 7)) {
      console.log(
        `     ${e.startDate}${e.endDate !== e.startDate ? `→${e.endDate}` : "        "}` +
          ` ${String(e.distanceKm).padStart(4)}km  ${fmtLead(e.leadDays).padStart(6)}  ` +
          `[${e.category}] ${e.name}${e.curated ? " ◦" : ""}`,
      );
    }
    if (d.events.length > 7) console.log(`     ... y ${d.events.length - 7} mas`);
    console.log(
      `   cobertura: ${Object.entries(d.coverage)
        .filter(([k]) => k !== "gaps")
        .map(([k, v]) => `${k}=${v ? "si" : "no"}`)
        .join(" ")}`,
    );
    return true;
  } catch (err) {
    console.error(`\n── ${label}  FALLO ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let ok = true;

  if (args.length >= 2) {
    ok = await run("punto manual", Number(args[0]), Number(args[1]), args[2] ? Number(args[2]) : undefined);
  } else {
    for (const s of SAMPLES) ok = (await run(s.label, s.lat, s.lng, s.radius)) && ok;
    // Un punto sin nada cerca tiene que dar lista vacia, no error.
    const empty = await getSportsPoint(-54.8, -68.3, 100);
    if (empty.events.length > 0) {
      console.error("\n✗ Ushuaia con radio 100km devolvio eventos: revisar el filtro");
      ok = false;
    }
    console.log("\nHuecos declarados:");
    for (const g of empty.coverage.gaps) console.log(`  · ${g}`);
  }

  console.log(ok ? "\n✓ hub de deportes OK" : "\n✗ hub de deportes con fallas");
  process.exit(ok ? 0 : 1);
}

void main();
