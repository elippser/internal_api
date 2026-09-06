// Smoke del hub de desastres naturales (event-list.md §10). Pega contra
// fuentes reales: si GDACS cambia el shape, USGS la firma de la consulta por
// radio o EONET la categoria, esto lo grita.
//
//   npm run test:hazards

import { getHazardsPoint } from "../modules/hazards/hazards.service";

interface Case {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
  expect: string;
}

const CASES: Case[] = [
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, radiusKm: 500, expect: "zona tranquila: pocos eventos" },
  { name: "Santiago de Chile", lat: -33.4489, lng: -70.6693, radiusKm: 600, expect: "sismos y volcanes andinos" },
  { name: "Tokio", lat: 35.6762, lng: 139.6503, radiusKm: 600, expect: "sismos frecuentes" },
  { name: "Miami", lat: 25.7617, lng: -80.1918, radiusKm: 800, expect: "ciclones tropicales en temporada" },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, radiusKm: 500, expect: "sequia continental: entra por pais, no por distancia" },
];

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) {
    failures++;
    console.error("  ✗ " + label + (detail ? " -> " + detail : ""));
  } else {
    console.log("  ✓ " + label + (detail ? " -> " + detail : ""));
  }
};

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getHazardsPoint(c.lat, c.lng, c.radiusKm, 30);

    console.log(
      "  titular: " + p.headline.activeCount + " activos | peor alerta: " +
        (p.headline.worstAlert ?? "ninguna") +
        " | vias de impacto: " + (p.headline.paths.join(", ") || "ninguna"),
    );
    for (const e of p.active.slice(0, 5)) {
      console.log(
        "    [" + e.alertLevel.padEnd(6) + "] " + e.typeName.padEnd(18) + e.name.slice(0, 40).padEnd(42) +
          e.distanceKm + "km (" + e.scope + ")",
      );
    }
    if (p.recent.length) console.log("  terminados en la ventana: " + p.recent.length);
    if (p.quakes.length) {
      console.log(
        "  sismos (90d): " + p.quakes.slice(0, 3).map((q) => "M" + q.magnitude + " a " + q.distanceKm + "km").join(" | "),
      );
    }
    if (p.volcanoes.length) {
      console.log(
        "  volcanes activos: " + p.volcanoes.slice(0, 3).map((v) => v.name.replace(" Volcano", "") + " (" + v.distanceKm + "km)").join(" | "),
      );
    }
    for (const a of p.anomalies) {
      console.log(
        "  anomalia " + a.kind + ": " + a.startDate + " a " + a.endDate + " (" + a.days + "d), pico " +
          a.peakC + "C sobre umbral " + a.thresholdC + "C",
      );
    }
    for (const r of p.airliftRisk) {
      console.log(
        "  RIESGO AEREO: " + r.hazardType + " a " + r.hazardDistanceKm + "km de " +
          (r.airportIata ?? r.airport) + " [" + r.alertLevel + "]",
      );
    }

    // ── Invariantes ──
    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    // Un evento "local" tiene que estar de verdad dentro del radio. Los que
    // entran por pais pueden estar a miles de km: es el caso de las sequias
    // continentales, y por eso llevan scope propio en vez de colarse como si
    // fueran cercanas.
    check(
      "todo evento local esta dentro del radio",
      p.active.filter((e) => e.scope === "local").every((e) => e.distanceKm <= c.radiusKm),
      p.active.length + " activos",
    );
    check(
      "los eventos por pais declaran su alcance",
      p.active.filter((e) => e.distanceKm > c.radiusKm).every((e) => e.scope === "country"),
      p.active.map((e) => e.scope).join(",") || "(ninguno)",
    );
    // Solo lo realmente areal puede entrar por pais. Un incendio a 4.000 km no
    // es una amenaza directa aunque comparta pais con el punto.
    check(
      "solo las sequias entran por alcance de pais",
      p.active.filter((e) => e.scope === "country").every((e) => e.type === "DR"),
      p.active.filter((e) => e.scope === "country").map((e) => e.type).join(",") || "(ninguno)",
    );
    check(
      "activo y terminado son excluyentes",
      p.active.every((e) => e.ongoing) && p.recent.every((e) => !e.ongoing),
    );
    check(
      "worstAlert es el maximo de los activos",
      p.headline.activeCount === 0
        ? p.headline.worstAlert === null
        : p.active.some((e) => e.alertLevel === p.headline.worstAlert),
      String(p.headline.worstAlert),
    );
    check(
      "los activos vienen ordenados por severidad",
      p.active.every((e, i) => {
        if (i === 0) return true;
        const rank = { Red: 3, Orange: 2, Green: 1 } as Record<string, number>;
        return rank[p.active[i - 1].alertLevel] >= rank[e.alertLevel];
      }),
    );
    check(
      "sismos ordenados por magnitud",
      p.quakes.every((q, i) => i === 0 || p.quakes[i - 1].magnitude >= q.magnitude),
    );
    // El riesgo aereo tiene que estar respaldado por una amenaza que
    // efectivamente cierre aeropuertos.
    check(
      "el riesgo aereo solo sale de amenazas que cierran pistas",
      p.airliftRisk.every((r) =>
        ["Erupcion volcanica", "Ciclon tropical", "Inundacion", "Tsunami"].includes(r.hazardType),
      ),
      p.airliftRisk.map((r) => r.hazardType).join(",") || "(ninguno)",
    );
    check(
      "una via de impacto declarada tiene evidencia",
      (!p.headline.paths.includes("direct") || p.active.length > 0) &&
        (!p.headline.paths.includes("airlift") || p.airliftRisk.length > 0),
      p.headline.paths.join(",") || "(ninguna)",
    );
    // Las rachas se declaran solo con 3 dias o mas: un dia caluroso no es ola.
    check(
      "las anomalias duran al menos 3 dias",
      p.anomalies.every((a) => a.days >= 3),
      p.anomalies.map((a) => a.kind + ":" + a.days + "d").join(" ") || "(ninguna)",
    );
    check(
      "el pico de calor supera su umbral y el de frio queda debajo",
      p.anomalies.every((a) => (a.kind === "heat" ? a.peakC > a.thresholdC : a.peakC < a.thresholdC)),
    );
  }

  // ── Control duro: zona sismica vs zona estable ──
  console.log("\n=== Control: el catalogo sismico discrimina ===");
  const tokyo = await getHazardsPoint(35.6762, 139.6503, 600, 30);
  const bsas = await getHazardsPoint(-34.6037, -58.3816, 600, 30);
  check(
    "Tokio registra mas sismos que Buenos Aires",
    tokyo.quakes.length > bsas.quakes.length,
    "Tokio " + tokyo.quakes.length + " vs BsAs " + bsas.quakes.length,
  );

  // ── Control duro: el radio filtra de verdad ──
  console.log("\n=== Control: el radio acota ===");
  const wide = await getHazardsPoint(-33.4489, -70.6693, 2000, 30);
  const narrow = await getHazardsPoint(-33.4489, -70.6693, 100, 30);
  check(
    "un radio chico no trae mas eventos que uno grande",
    narrow.active.length <= wide.active.length,
    narrow.active.length + " vs " + wide.active.length,
  );

  console.log(failures === 0 ? "\n✓ hub de amenazas OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test:hazards exploto:", err);
  process.exit(1);
});
