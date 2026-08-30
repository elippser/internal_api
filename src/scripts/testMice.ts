// Prueba en vivo del hub de eventos de negocios / MICE SIN base de datos.
//
//   npm run test:mice                      # 6 puntos de muestra
//   npm run test:mice -- 41.39 2.17 100    # lat lng [radioKm]

import "dotenv/config";
import { getMicePoint, classifyMice, inferPattern } from "../modules/mice/mice.service";

const SAMPLES: Array<{ label: string; lat: number; lng: number; radius?: number }> = [
  { label: "Barcelona (MWC)", lat: 41.39, lng: 2.17 },
  { label: "Las Vegas (CES)", lat: 36.17, lng: -115.14 },
  { label: "Davos (Foro Economico)", lat: 46.8, lng: 9.84, radius: 60 },
  { label: "Buenos Aires (Hotelga, FIT)", lat: -34.6, lng: -58.4, radius: 250 },
  { label: "Miami (G20 2026)", lat: 25.76, lng: -80.19 },
  { label: "Medio del Atlantico (nada)", lat: 20, lng: -40 },
];

const fmtLead = (d: number): string =>
  d < 0 ? "en curso" : d < 45 ? `${d}d` : d < 730 ? `${Math.round(d / 30)}m` : `${(d / 365).toFixed(1)}a`;
const miles = (n: number): string => n.toLocaleString("es-AR");

async function run(label: string, lat: number, lng: number, radius?: number): Promise<boolean> {
  const t0 = Date.now();
  try {
    const d = await getMicePoint(lat, lng, radius ?? 150);
    console.log(`\n── ${label}  ${Date.now() - t0}ms`);
    console.log(`   radio ${d.location.radiusKm}km · ventana ${d.window.from} → ${d.window.to}`);
    console.log(
      `   anclas: ${d.anchors.length} · agenda local: ${d.listingsTotal}` +
        ` · noches-delegado: ${miles(d.delegateNights)}`,
    );
    if (Object.keys(d.byCategory).length) {
      console.log(
        `   categorias: ${Object.entries(d.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`,
      );
    }
    if (d.headline) {
      console.log(
        `   principal: ${d.headline.name} · ${d.headline.startDate} · ${d.headline.distanceKm}km` +
          `${d.headline.attendees ? ` · ${miles(d.headline.attendees)} asistentes` : ""}`,
      );
    }
    for (const a of d.anchors.slice(0, 5)) {
      console.log(
        `     ANCLA ${a.startDate}→${a.endDate} ${String(a.distanceKm).padStart(4)}km ` +
          `${fmtLead(a.leadDays).padStart(6)} [${a.dayPattern}] ${a.name}` +
          `${a.attendees ? ` (${miles(a.attendees)})` : ""}${a.approximate ? " ~" : ""}`,
      );
    }
    if (d.anchors.length > 5) console.log(`     ... y ${d.anchors.length - 5} anclas mas`);
    for (const l of d.listings.slice(0, 2)) {
      console.log(
        `     local ${l.startDate} ${String(l.distanceKm).padStart(4)}km [${l.category}/${l.dayPattern}] ${l.name.slice(0, 44)}`,
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

    // El patron semanal es lo propio de esta categoria: se chequea explicito.
    console.log("\nPatron semanal inferido:");
    const patrones: Array<[string, string, string]> = [
      ["2027-03-01", "2027-03-04", "midweek"], // MWC: lun-jue
      ["2027-03-16", "2027-03-18", "midweek"], // ITB: mar-jue
      ["2027-01-20", "2027-01-24", "full-week"], // FITUR: mie-dom
      ["2027-02-06", "2027-02-07", "weekend"], // sab-dom
    ];
    for (const [s, e, esp] of patrones) {
      const got = inferPattern(s, e);
      if (got !== esp) { ok = false; console.error(`  ✗ ${s}→${e} → ${got} (esperado ${esp})`); }
      else console.log(`  ✓ ${s} → ${e}  ${got}`);
    }

    console.log("\nClasificacion corporativa (null = no es MICE):");
    const casos: Array<[string, string, string | null]> = [
      ["conference", "Tech Meetup", "tech"], // gana la regla tech, que va antes
      ["conference", "Salon Profesional del Agro", "trade-fair"],
      ["Music", "Recital de rock", null],
      ["miscellaneous", "Congreso de Cardiologia", "congress"],
      ["miscellaneous", "Hackathon 2027", "tech"],
      ["Arts & Theatre", "Obra de teatro", null],
    ];
    for (const [seg, name, esp] of casos) {
      const got = classifyMice(seg, name);
      if (got !== esp) { ok = false; console.error(`  ✗ "${name}" → ${got} (esperado ${esp})`); }
      else console.log(`  ✓ ${name.padEnd(26)} → ${got ?? "no-MICE"}`);
    }

    const vacio = await getMicePoint(20, -40, 100);
    if (vacio.anchors.length > 0 || vacio.listingsTotal > 0) {
      console.error("\n✗ el medio del Atlantico devolvio eventos");
      ok = false;
    }
    console.log("\nHuecos declarados:");
    for (const g of vacio.coverage.gaps) console.log(`  · ${g}`);
  }

  console.log(ok ? "\n✓ hub MICE OK" : "\n✗ hub MICE con fallas");
  process.exit(ok ? 0 : 1);
}

void main();
