// Smoke del hub de oferta hotelera (event-list.md §11).
//   npm run test:supply

import { getSupplyPoint } from "../modules/supply/supply.service";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error("  ✗ " + label + (detail ? " -> " + detail : "")); }
  else console.log("  ✓ " + label + (detail ? " -> " + detail : ""));
};

const CASES: Array<{ name: string; lat: number; lng: number; r: number; expect: string }> = [
  { name: "Buenos Aires centro", lat: -34.6037, lng: -58.3816, r: 5, expect: "oferta densa + registro STR" },
  { name: "Barcelona", lat: 41.3874, lng: 2.1686, r: 5, expect: "oferta densa + prohibicion STR" },
  { name: "Bariloche", lat: -41.1335, lng: -71.3103, r: 10, expect: "cabanias y sustitutos" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, r: 10, expect: "sin oferta" },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getSupplyPoint(c.lat, c.lng, c.r);
    console.log(
      "  total: " + p.total + " establecimientos | densidad " + p.densityPerKm2 + "/km2" +
      (p.coverage.truncated ? " (TRUNCADO)" : ""),
    );
    console.log("  por tipo: " + (p.byKind.map((k) => k.label + " " + k.count).join(" | ") || "ninguno"));
    console.log(
      "  sustitutos: " + p.substitutes.count + " (" + Math.round(p.substitutes.share * 100) + "%)" +
      " | cadenas: " + p.chains.count + " (" + Math.round(p.chains.share * 100) + "%)",
    );
    if (p.chains.top.length) console.log("  marcas: " + p.chains.top.slice(0, 5).map((b) => b.name).join(", "));
    for (const s of p.strRegulation) console.log("  regulacion STR: " + s.city + " [" + s.severity + "]");

    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    // Los conteos por tipo tienen que sumar el total: si no, algo se conto dos
    // veces o se perdio en el camino.
    check(
      "los tipos suman el total",
      p.byKind.reduce((s, k) => s + k.count, 0) === p.total,
      p.byKind.reduce((s, k) => s + k.count, 0) + " vs " + p.total,
    );
    check("sustitutos no superan el total", p.substitutes.count <= p.total);
    check("cadenas no superan el total", p.chains.count <= p.total);
    check(
      "las proporciones estan entre 0 y 1",
      p.substitutes.share >= 0 && p.substitutes.share <= 1 && p.chains.share >= 0 && p.chains.share <= 1,
      p.substitutes.share + " / " + p.chains.share,
    );
    // Un hotel no es sustituto de si mismo.
    check(
      "los hoteles no cuentan como sustitutos",
      p.substitutes.count === p.byKind.filter((k) => k.kind !== "hotel").reduce((s, k) => s + k.count, 0),
    );
    check(
      "las marcas suman como mucho el conteo de cadenas",
      p.chains.top.reduce((s, b) => s + b.count, 0) <= p.chains.count,
    );
  }

  // ── Control duro: el oceano no tiene hoteles ──
  console.log("\n=== Control: el oceano ===");
  const sea = await getSupplyPoint(-30, -30, 10);
  check("sin alojamientos", sea.total === 0, String(sea.total));
  check("densidad cero", sea.densityPerKm2 === 0, String(sea.densityPerKm2));

  // ── Control duro: Barcelona tiene norma restrictiva y Bariloche no ──
  console.log("\n=== Control: la regulacion discrimina ===");
  const bcn = await getSupplyPoint(41.3874, 2.1686, 5);
  check(
    "Barcelona trae la prohibicion de alquiler temporario",
    bcn.strRegulation.some((s) => s.severity === "ban"),
    bcn.strRegulation.map((s) => s.city + ":" + s.severity).join(",") || "(ninguna)",
  );

  console.log(failures === 0 ? "\n✓ hub de oferta OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("test:supply exploto:", e); process.exit(1); });
