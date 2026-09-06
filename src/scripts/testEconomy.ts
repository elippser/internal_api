// Smoke del hub economico (event-list.md §6). Pega contra las fuentes reales:
// si el FMI cambia el shape del WEO o el Banco Mundial archiva otro indicador,
// esto lo tiene que gritar.
//
//   npm run test:economy

import { getEconomyPoint } from "../modules/economy/economy.service";

interface Case {
  name: string;
  lat: number;
  lng: number;
  expect: string;
}

const CASES: Case[] = [
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, expect: "brecha cambiaria + emisores curados" },
  { name: "Sao Paulo", lat: -23.5505, lng: -46.6333, expect: "BRL esta en el BCE: serie de 12m" },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, expect: "EUR, nivel de precios alto" },
  { name: "Santiago de Chile", lat: -33.4489, lng: -70.6693, expect: "CLP fuera del BCE: solo spot" },
];

const pct = (n: number | null): string => (n === null ? "s/d" : (n > 0 ? "+" : "") + n + "%");

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
    const p = await getEconomyPoint(c.lat, c.lng);

    console.log(
      "  pais: " + p.country.name + " (" + p.country.code + ") | moneda: " + p.country.currency,
    );
    console.log(
      "  macro: inflacion " +
        pct(p.macro.inflation.value) +
        " (" +
        p.macro.inflation.year +
        (p.macro.inflation.projected ? ", proy." : "") +
        ") | PBI " +
        pct(p.macro.gdpGrowth.value) +
        " | desempleo " +
        pct(p.macro.unemployment.value) +
        " | nivel de precios " +
        (p.macro.priceLevel.value ?? "s/d"),
    );
    console.log(
      "  titular: mas barato para " +
        p.headline.cheaperFor +
        " / mas caro para " +
        p.headline.pricierFor +
        " de " +
        p.headline.measuredAgainst +
        " medidos" +
        (p.headline.bestMarket ? " | mejor: " + p.headline.bestMarket : ""),
    );
    console.log(
      "  nivel: mas barato que su casa para " +
        p.headline.cheaperThanHome +
        " de " +
        p.headline.levelComparedAgainst,
    );

    for (const e of p.emitters) {
      console.log(
        "    " +
          e.countryCode +
          " " +
          e.currency.padEnd(4) +
          " nivel rel " +
          String(e.relativePriceLevel ?? "s/d").padEnd(6) +
          " nominal " +
          pct(e.nominalChangePct).padEnd(7) +
          " real " +
          pct(e.realChangePct).padEnd(7) +
          " " +
          (e.verdict ?? "-") +
          (e.note ? "  [" + e.note + "]" : ""),
      );
    }

    if (p.parallelMarket) {
      const m = p.parallelMarket;
      console.log(
        "  brecha: oficial " +
          m.official +
          " vs " +
          m.parallelName +
          " " +
          m.parallel +
          " = " +
          m.gapPct +
          "% | devaluacion 12m " +
          pct(m.officialChange12mPct) +
          " vs inflacion " +
          pct(m.inflation12mPct) +
          " => real " +
          pct(m.realChange12mPct),
      );
    }

    // ── Invariantes ──
    check("resuelve pais", Boolean(p.country.code), p.country.code);
    check("trae macro", p.macro.inflation.value !== null);
    check("trae emisores", p.emitters.length > 0, p.emitters.length + " emisores");
    check(
      "ningun emisor es el propio pais",
      !p.emitters.some((e) => e.countryCode === p.country.code),
    );
    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");

    // El nivel de precios relativo tiene que ser un cociente sano: nadie es
    // 20 veces mas caro que su vecino.
    const levels = p.emitters.map((e) => e.relativePriceLevel).filter((v): v is number => v !== null);
    check(
      "niveles relativos en rango plausible",
      levels.every((v) => v > 0.05 && v < 20),
      levels.join(", "),
    );

    // Un verdict solo puede existir si hay cambio real que lo respalde.
    check(
      "verdict siempre respaldado por realChangePct",
      p.emitters.every((e) => (e.verdict === null) === (e.realChangePct === null)),
    );

    // El titular tiene que decir algo incluso sin serie cambiaria: esa es la
    // razon de ser de la mitad de nivel.
    check(
      "el titular nunca queda mudo",
      p.headline.measuredAgainst > 0 || p.headline.levelComparedAgainst > 0,
    );

    // Si al destino le falta la moneda en el BCE, la culpa no puede recaer
    // sobre el emisor: el mensaje tiene que nombrar la moneda del destino.
    if (p.headline.measuredAgainst === 0 && p.country.currency !== "?") {
      check(
        "explica que la moneda ausente es la del destino",
        p.emitters.every((e) => !e.note || e.note.includes(p.country.currency)),
        p.emitters[0]?.note ?? "",
      );
    }
  }

  // ── Control duro: EE.UU. es el numerario del nivel de precios ──
  console.log("\n=== Control: EE.UU. = 1.0 por definicion ===");
  const us = await getEconomyPoint(38.9072, -77.0369);
  check(
    "nivel de precios de EE.UU. == 1.0",
    us.macro.priceLevel.value !== null && Math.abs(us.macro.priceLevel.value - 1) < 0.001,
    String(us.macro.priceLevel.value),
  );

  // ── Control duro: el oceano no tiene pais ──
  console.log("\n=== Control: punto oceanico ===");
  try {
    await getEconomyPoint(-30, -30);
    check("el oceano deberia fallar", false, "devolvio payload");
  } catch {
    check("el oceano falla explicitamente", true);
  }

  console.log(
    failures === 0 ? "\n✓ hub economico OK" : "\n✗ " + failures + " chequeos fallaron",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test:economy exploto:", err);
  process.exit(1);
});
