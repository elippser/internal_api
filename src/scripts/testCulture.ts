// Prueba en vivo del hub de eventos culturales SIN base de datos.
//
//   npm run test:culture                     # 6 puntos de muestra
//   npm run test:culture -- -34.6 -58.4 200  # lat lng [radioKm]

import "dotenv/config";
import { getCulturePoint, normalizeSegment } from "../modules/culture/culture.service";

const SAMPLES: Array<{ label: string; lat: number; lng: number; radius?: number }> = [
  { label: "Rio de Janeiro (Carnaval)", lat: -22.91, lng: -43.17 },
  { label: "Munich (Oktoberfest)", lat: 48.14, lng: 11.58 },
  { label: "Mendoza (Vendimia)", lat: -32.89, lng: -68.85 },
  { label: "Buenos Aires (cola larga + Gualeguaychu a 200km)", lat: -34.6, lng: -58.4, radius: 250 },
  { label: "Singapur (Ano Nuevo Chino + Diwali)", lat: 1.35, lng: 103.82 },
  { label: "Medio del Pacifico (nada)", lat: -30, lng: -140 },
];

const fmtLead = (d: number): string =>
  d < 0 ? "en curso" : d < 45 ? `${d}d` : d < 730 ? `${Math.round(d / 30)}m` : `${(d / 365).toFixed(1)}a`;

async function run(label: string, lat: number, lng: number, radius?: number): Promise<boolean> {
  const t0 = Date.now();
  try {
    const d = await getCulturePoint(lat, lng, radius ?? 150);
    console.log(`\n── ${label}  ${Date.now() - t0}ms`);
    console.log(`   radio ${d.location.radiusKm}km · ventana ${d.window.from} → ${d.window.to}`);
    console.log(
      `   anclas: ${d.anchors.length} · cola larga: ${d.listingsTotal}` +
        ` (se muestran ${d.listings.length})`,
    );
    console.log(
      `   categorias: ${Object.entries(d.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")}`,
    );
    if (d.headline) {
      console.log(
        `   principal: ${d.headline.name} · ${d.headline.startDate} · ${d.headline.distanceKm}km · ${fmtLead(d.headline.leadDays)}`,
      );
    }
    for (const a of d.anchors.slice(0, 6)) {
      console.log(
        `     ANCLA ${a.startDate}→${a.endDate} ${String(a.distanceKm).padStart(4)}km ` +
          `${fmtLead(a.leadDays).padStart(6)}  [${a.category}] ${a.name}${a.approximate ? " ~" : ""}`,
      );
    }
    if (d.anchors.length > 6) console.log(`     ... y ${d.anchors.length - 6} anclas mas`);
    for (const l of d.listings.slice(0, 3)) {
      console.log(
        `     lista ${l.startDate} ${String(l.distanceKm).padStart(4)}km  [${l.category}] ` +
          `${l.name.slice(0, 46)}${l.rawSegment ? `  <${l.rawSegment.slice(0, 22)}>` : ""}`,
      );
    }
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

    // La normalizacion es el corazon del hub: se chequea explicitamente.
    console.log("\nNormalizacion de taxonomia:");
    const casos: Array<[string, string]> = [
      ["Arts & Theatre", "theatre"],
      ["music &amp; comedy", "music"],
      ["música", "music"],
      ["library events", "book"],
      ["miscellaneous", "other"],
    ];
    for (const [raw, esp] of casos) {
      const got = normalizeSegment(raw);
      if (got !== esp) { ok = false; console.error(`  ✗ ${raw} → ${got} (esperado ${esp})`); }
      else console.log(`  ✓ ${raw.padEnd(22)} → ${got}`);
    }

    const vacio = await getCulturePoint(-30, -140, 100);
    if (vacio.anchors.length > 0 || vacio.listingsTotal > 0) {
      console.error("\n✗ el medio del Pacifico devolvio eventos: revisar el filtro");
      ok = false;
    }
    console.log("\nHuecos declarados:");
    for (const g of vacio.coverage.gaps) console.log(`  · ${g}`);
  }

  console.log(ok ? "\n✓ hub de cultura OK" : "\n✗ hub de cultura con fallas");
  process.exit(ok ? 0 : 1);
}

void main();
