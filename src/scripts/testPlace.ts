// Smoke del hub de ubicacion y entorno fisico (event-list.md §12).
//   npm run test:place

import { getPlacePoint } from "../modules/place/place.service";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error("  ✗ " + label + (detail ? " -> " + detail : "")); }
  else console.log("  ✓ " + label + (detail ? " -> " + detail : ""));
};

const CASES = [
  { name: "Microcentro porteno", lat: -34.6037, lng: -58.3816, r: 1, expect: "denso, caminable, de oficinas" },
  { name: "Barceloneta", lat: 41.3784, lng: 2.1925, r: 1, expect: "playa cerca" },
  { name: "Bariloche", lat: -41.1335, lng: -71.3103, r: 1, expect: "montania y lago" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, r: 1, expect: "nada" },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getPlacePoint(c.lat, c.lng, c.r);
    console.log("  perfil: " + p.profile);
    console.log(
      "  caminabilidad: " + p.walkability.score + " (" + p.walkability.label + ") " +
      JSON.stringify(p.walkability.components),
    );
    console.log("  ruido: " + p.noise.score + " (" + p.noise.label + ") " + (p.noise.sources.join(" · ") || "sin fuentes"));
    console.log(
      "  densidad: gastronomia " + p.density.gastronomy + " | nocturna " + p.density.nightlife +
      " | comercios " + p.density.shops + " | oficinas " + p.density.offices +
      " | cadenas " + p.density.chains,
    );
    const near = Object.entries(p.proximity).filter(([, v]) => v).map(([k, v]) => k + " " + (v as { distanceM: number }).distanceM + "m");
    console.log("  cerca: " + (near.join(" | ") || "nada"));
    console.log("  vista: " + (p.view.elevationM ?? "s/d") + "m · " + (p.view.hints.join(" · ") || "sin indicios"));

    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    // Un cero en un lugar habitado tiene que venir explicado, no mudo.
    check(
      "un entorno vacio con aeropuerto cerca se declara",
      !(p.density.shops === 0 && p.density.gastronomy === 0 && p.proximity.airport) ||
        !p.coverage.census,
      "census=" + p.coverage.census,
    );
    check("caminabilidad entre 0 y 100", p.walkability.score >= 0 && p.walkability.score <= 100, String(p.walkability.score));
    check("ruido entre 0 y 100", p.noise.score >= 0 && p.noise.score <= 100, String(p.noise.score));
    check(
      "los componentes de caminabilidad estan entre 0 y 1",
      Object.values(p.walkability.components).every((v) => v >= 0 && v <= 1),
      JSON.stringify(p.walkability.components),
    );
    // Un puntaje de ruido sin fuentes seria un numero sin respaldo.
    check(
      "todo ruido declarado tiene su fuente",
      p.noise.score === 0 || p.noise.sources.length > 0,
      p.noise.sources.join(",") || "(ninguna)",
    );
    check(
      "las distancias del radio caminable no lo exceden",
      [p.proximity.park, p.proximity.attraction, p.proximity.museum]
        .filter((x): x is { name: string | null; distanceM: number } => x !== null)
        .every((x) => x.distanceM <= c.r * 1000 + 50),
    );
    check(
      "la accesibilidad no supera lo etiquetado",
      p.accessibility.taggedAccessible <= p.accessibility.taggedTotal,
      p.accessibility.taggedAccessible + "/" + p.accessibility.taggedTotal,
    );
  }

  // ── Control duro: un centro urbano es mas caminable que el oceano ──
  console.log("\n=== Control: la caminabilidad discrimina ===");
  const centro = await getPlacePoint(-34.6037, -58.3816, 1);
  const mar = await getPlacePoint(-30, -30, 1);
  check(
    "el microcentro es mas caminable que el mar",
    centro.walkability.score > mar.walkability.score,
    centro.walkability.score + " vs " + mar.walkability.score,
  );
  check("el mar no tiene comercios", mar.density.shops === 0 && mar.density.gastronomy === 0);

  // ── Control duro: la elevacion distingue montania de llanura ──
  console.log("\n=== Control: la elevacion es real ===");
  const bar = await getPlacePoint(-41.1335, -71.3103, 1);
  check(
    "Bariloche esta mas alto que Buenos Aires",
    (bar.view.elevationM ?? 0) > (centro.view.elevationM ?? 0),
    (bar.view.elevationM ?? "s/d") + "m vs " + (centro.view.elevationM ?? "s/d") + "m",
  );

  console.log(failures === 0 ? "\n✓ hub de entorno OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("test:place exploto:", e); process.exit(1); });
