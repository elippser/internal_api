// Smoke del hub institucional (event-list.md §15).
//   npm run test:institutional
import { getInstitutionalPoint } from "../modules/institutional/institutional.service";

let f = 0;
const check = (l: string, ok: boolean, d = ""): void => {
  if (!ok) { f++; console.error("  ✗ " + l + (d ? " -> " + d : "")); }
  else console.log("  ✓ " + l + (d ? " -> " + d : ""));
};

const CASES = [
  { name: "Ciudad Universitaria (BA)", lat: -34.5426, lng: -58.4436, r: 5, expect: "universidad dominante" },
  { name: "Rochester, Minnesota", lat: 44.0121, lng: -92.4802, r: 10, expect: "Mayo Clinic: salud dominante" },
  { name: "Santiago de Compostela", lat: 42.8805, lng: -8.5457, r: 5, expect: "religioso" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, r: 10, expect: "sin anclas" },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getInstitutionalPoint(c.lat, c.lng, c.r);
    console.log("  pais: " + (p.country || "s/d") + " | anclas: " + p.totalAnchors + " | dominante: " + (p.dominant ?? "ninguna"));
    for (const g of p.groups) {
      console.log(
        "    " + g.label.padEnd(30) + String(g.count).padStart(4) +
        (g.nearest ? "  mas cerca: " + (g.nearest.name ?? "s/n").slice(0, 28) + " a " + g.nearest.distanceM + "m" : ""),
      );
    }
    if (p.academic) {
      console.log("  graduaciones: meses " + p.academic.graduationMonths.join(",") + (p.academic.approximate ? " (aprox)" : ""));
    }
    if (p.netMigration) console.log("  migracion neta: " + p.netMigration.value.toLocaleString("es-AR") + " (" + p.netMigration.year + ")");

    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    check("el total coincide con la suma por grupo", p.totalAnchors === p.groups.reduce((s, g) => s + g.count, 0));
    check("los grupos vacios no se listan", p.groups.every((g) => g.count > 0));
    check(
      "toda ancla mas cercana esta dentro del radio",
      p.groups.every((g) => !g.nearest || g.nearest.distanceM <= c.r * 1000 + 50),
    );
    check("cada grupo explica por que genera demanda", p.groups.every((g) => g.why.length > 10));
    check(
      "el calendario academico es coherente",
      !p.academic || p.academic.graduationMonths.every((m) => m >= 1 && m <= 12),
    );
  }

  console.log("\n=== Control: el hemisferio define las graduaciones ===");
  const ar = await getInstitutionalPoint(-34.6037, -58.3816, 5);
  const us = await getInstitutionalPoint(40.7128, -74.006, 5);
  check(
    "Argentina gradua en verano austral y EE.UU. no",
    Boolean(ar.academic?.graduationMonths.includes(12)) && Boolean(us.academic?.graduationMonths.includes(6)),
    "AR " + ar.academic?.graduationMonths.join(",") + " | US " + us.academic?.graduationMonths.join(","),
  );

  console.log(f === 0 ? "\n✓ hub institucional OK" : "\n✗ " + f + " chequeos fallaron");
  process.exit(f === 0 ? 0 : 1);
}
main().catch((e) => { console.error("test:institutional exploto:", e); process.exit(1); });
