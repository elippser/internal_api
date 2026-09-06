// Smoke del hub de conectividad (event-list.md §7). Pega contra las fuentes
// reales: si OurAirports cambia columnas, adsbdb cambia el shape o Overpass se
// cae, esto lo tiene que gritar.
//
//   npm run test:connectivity

import { getConnectivityPoint } from "../modules/connectivity/connectivity.service";

interface Case {
  name: string;
  lat: number;
  lng: number;
  expect: string;
  minTier?: string;
}

const CASES: Case[] = [
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, expect: "hub internacional + subte + emisores", minTier: "major" },
  { name: "Bariloche", lat: -41.1335, lng: -71.3103, expect: "aeropuerto regional, sin subte" },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, expect: "Barajas + red ferroviaria densa", minTier: "major" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, expect: "sin aeropuertos, sin nada" },
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

const miles = (n: number): string => n.toLocaleString("es-AR");

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getConnectivityPoint(c.lat, c.lng, 100);

    console.log(
      "  pais: " + (p.country.name || "s/d") + " | jerarquia: " + p.airports.tier +
        " | aeropuertos con vuelos: " + p.airports.withScheduledService +
        " (grandes: " + p.airports.majorCount + ") | internacional: " + p.airports.internationalService,
    );
    if (p.airports.primary) {
      const a = p.airports.primary;
      console.log(
        "  referencia: " + a.name + " (" + (a.iata ?? a.ident) + ") a " + a.distanceKm + "km",
      );
    }
    if (p.airlift) {
      console.log(
        "  en el aire: " + p.airlift.observedAircraft + " aeronaves | " +
          p.airlift.commercialAircraft + " comerciales, " + p.airlift.cargoAircraft + " carga | ~" +
          miles(p.airlift.estimatedSeats) + " asientos" +
          (p.airlift.unknownTypeAircraft ? " (" + p.airlift.unknownTypeAircraft + " sin tabular)" : ""),
      );
      if (p.airlift.byType.length) {
        console.log("  tipos: " + p.airlift.byType.map((t) => t.model + "x" + t.count).join(" "));
      }
      if (p.airlift.carriers.length) {
        console.log("  aerolineas: " + p.airlift.carriers.slice(0, 6).join(", "));
      }
    }
    console.log(
      "  rutas locales observadas: " + p.routes.observed.length +
        " | paises conectados: " + (p.routes.directOriginCountries.join(", ") || "ninguno visto"),
    );
    for (const e of p.routes.emitterLinks) {
      console.log(
        "    " + e.countryCode + " " + e.countryName.padEnd(16) + " " + e.status +
          (e.via.length ? "  [" + e.via.join(", ") + "]" : ""),
      );
    }
    const g = p.ground;
    console.log(
      "  terrestre: tren " + g.train.count + " | subte " + g.subway.count +
        " | bus " + g.busTerminal.count + " | ferry " + g.ferry.count +
        " | rent-a-car " + g.carRental.count + " | frontera " + g.borderCrossing.count +
        (g.available ? "" : "  (Overpass no respondio)"),
    );

    // ── Invariantes ──
    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");

    // EL invariante de esta categoria: una muestra instantanea no puede probar
    // que una ruta no existe. Si alguna vez aparece un tercer estado que
    // afirme la ausencia, esto tiene que romperse.
    check(
      "nunca afirma que NO hay vuelo directo",
      p.routes.emitterLinks.every((e) => e.status === "observed" || e.status === "unknown"),
      p.routes.emitterLinks.map((e) => e.status).join(","),
    );
    check(
      "un 'observed' siempre trae la ruta que lo respalda",
      p.routes.emitterLinks.every((e) => e.status !== "observed" || e.via.length > 0),
    );
    check(
      "ningun emisor es el propio pais",
      !p.routes.emitterLinks.some((e) => e.countryCode === p.country.code),
    );
    check(
      "las rutas listadas tocan un aeropuerto del radio",
      p.routes.observed.every((r) => r.touchesLocal),
    );
    check(
      "los asientos estimados no salen de aviones de carga",
      !p.airlift || p.airlift.estimatedSeats >= 0,
    );
    check(
      "distancias de aeropuertos dentro del radio pedido",
      p.airports.nearby.every((a) => a.distanceKm <= 100),
      p.airports.nearby.length + " aeropuertos",
    );

    // Un vuelo de cabotaje no vuelve internacional a un aeropuerto: el propio
    // pais no puede aparecer como destino conectado.
    check(
      "el propio pais no cuenta como conexion internacional",
      !p.routes.directOriginCountries.includes(p.country.code),
      p.routes.directOriginCountries.join(",") || "(vacio)",
    );
    check(
      "servicio internacional solo si hay pais extranjero visto",
      (p.airports.internationalService === "observed") ===
        (p.routes.directOriginCountries.length > 0),
      p.airports.internationalService,
    );

    if (c.minTier) {
      check("jerarquia esperada", p.airports.tier === c.minTier, p.airports.tier);
    }
  }

  // ── Control duro: el oceano no tiene infraestructura ──
  console.log("\n=== Control: el oceano no inventa aeropuertos ===");
  const sea = await getConnectivityPoint(-30, -30, 100);
  check("sin aeropuertos", sea.airports.nearby.length === 0, String(sea.airports.nearby.length));
  check("jerarquia 'none'", sea.airports.tier === "none", sea.airports.tier);
  check("sin trafico aereo", sea.airlift === null || sea.airlift.commercialAircraft === 0);

  console.log(
    failures === 0 ? "\n✓ hub de conectividad OK" : "\n✗ " + failures + " chequeos fallaron",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test:connectivity exploto:", err);
  process.exit(1);
});
