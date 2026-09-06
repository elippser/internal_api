// Smoke del hub de industria y sector especifico (event-list.md §16).
//   npm run test:industry
import { getIndustryPoint } from "../modules/industry/industry.service";

let f = 0;
const check = (l: string, ok: boolean, d = ""): void => {
  if (!ok) { f++; console.error("  ✗ " + l + (d ? " -> " + d : "")); }
  else console.log("  ✓ " + l + (d ? " -> " + d : ""));
};

const CASES = [
  { name: "Lujan de Cuyo (Mendoza)", lat: -33.0392, lng: -68.8817, r: 25, expect: "vitivinicola" },
  { name: "Burdeos", lat: 44.8378, lng: -0.5792, r: 25, expect: "vitivinicola, hemisferio norte" },
  { name: "Antofagasta", lat: -23.6509, lng: -70.3975, r: 40, expect: "minera" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, r: 25, expect: "sin vocacion" },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getIndustryPoint(c.lat, c.lng, c.r);
    console.log("  hemisferio: " + p.hemisphere + " | dominante: " + (p.dominant ?? "ninguna"));
    for (const v of p.vocations) {
      console.log(
        "    " + v.label.padEnd(18) + String(v.count).padStart(5) + " elementos, peso " +
        String(v.demandWeight).padStart(5) + ", mas cerca " + v.nearestKm + "km" +
        (v.season ? "  temporada: " + v.season.label + (v.season.inSeason ? " [AHORA]" : "") : "  sin temporada"),
      );
    }
    if (p.inSeasonNow.length) console.log("  en temporada: " + p.inSeasonNow.join(", "));

    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    check("las vocaciones vienen ordenadas por peso", p.vocations.every((v, i) => i === 0 || p.vocations[i - 1].demandWeight >= v.demandWeight));
    check("el peso nunca es menor que el conteo", p.vocations.every((v) => v.demandWeight >= v.count));
    check("las vocaciones vacias no se listan", p.vocations.every((v) => v.count > 0));
    check("los meses de temporada son validos", p.vocations.every((v) => !v.season || v.season.months.every((m) => m >= 1 && m <= 12)));
    check(
      "'en temporada ahora' coincide con las vocaciones marcadas",
      p.inSeasonNow.length === p.vocations.filter((v) => v.season?.inSeason).length,
    );
    check("el hemisferio coincide con la latitud", p.hemisphere === (c.lat < 0 ? "south" : "north"));
  }

  // ── Control duro: la vendimia se invierte entre hemisferios ──
  console.log("\n=== Control: la vendimia se invierte con el hemisferio ===");
  const mza = await getIndustryPoint(-33.0392, -68.8817, 25);
  const bdx = await getIndustryPoint(44.8378, -0.5792, 25);
  const wineMonths = (p: typeof mza) => p.vocations.find((v) => v.key === "wine")?.season?.months ?? [];
  const mzaW = wineMonths(mza);
  const bdxW = wineMonths(bdx);
  check(
    "Mendoza vendimia en marzo y Burdeos en septiembre",
    mzaW.includes(3) && bdxW.includes(9),
    "MZA " + mzaW.join(",") + " | BDX " + bdxW.join(","),
  );
  check("las dos ventanas no se superponen", !mzaW.some((m) => bdxW.includes(m)), mzaW + " vs " + bdxW);

  console.log(f === 0 ? "\n✓ hub de industria OK" : "\n✗ " + f + " chequeos fallaron");
  process.exit(f === 0 ? 0 : 1);
}
main().catch((e) => { console.error("test:industry exploto:", e); process.exit(1); });
