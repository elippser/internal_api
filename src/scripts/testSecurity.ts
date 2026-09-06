// Smoke del hub de seguridad (event-list.md §9). Pega contra fuentes reales:
// si Canada cambia el shape del JSON, el RSS de Estados Unidos cambia el
// formato del titulo o la OMS mueve su endpoint, esto lo grita.
//
//   npm run test:security

import { getSecurityPoint } from "../modules/security/security.service";
import { advisorySet, normalizeName } from "../modules/security/advisories";

interface Case {
  name: string;
  lat: number;
  lng: number;
  expect: string;
  /** Nivel minimo esperado, para los casos donde el riesgo es notorio. */
  minLevel?: number;
  maxLevel?: number;
}

const CASES: Case[] = [
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, expect: "nivel bajo, homicidios bajos", maxLevel: 2 },
  { name: "Ciudad de Mexico", lat: 19.4326, lng: -99.1332, expect: "alerta con avisos regionales", minLevel: 2 },
  { name: "Kiev", lat: 50.4501, lng: 30.5234, expect: "nivel maximo: guerra", minLevel: 4 },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, expect: "nivel bajo", maxLevel: 2 },
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
  // ── Unitarios de la normalizacion de nombres ──
  console.log("=== Normalizacion de nombres de pais ===");
  const pairs: Array<[string, string]> = [
    // "democratic" y "republic" se conservan a proposito: son lo que separa a
    // las dos Congo. Colapsarlas las haria colisionar.
    ["Democratic Republic of the Congo", "democratic republic of congo"],
    ["Republic of the Congo", "republic of congo"],
    ["Côte d'Ivoire", "cote d ivoire"],
    ["United Arab Emirates", "united arab emirates"],
    ["Bosnia and Herzegovina", "bosnia and herzegovina"],
    // El RSS estadounidense le agrega el sufijo al nombre del pais.
    ["Mexico Travel Advisory", "mexico"],
  ];
  for (const [raw, expected] of pairs) {
    check('normaliza "' + raw + '"', normalizeName(raw) === expected, normalizeName(raw));
  }

  // La razon de ser de conservar esas palabras: las dos Congo tienen que dar
  // claves distintas.
  check(
    "las dos Congo no colapsan",
    normalizeName("Democratic Republic of the Congo") !== normalizeName("Republic of the Congo"),
  );

  // ── El indice de nombres tiene que resolver los dos feeds ──
  console.log("\n=== Indice de nombres (Canada) ===");
  const set = await advisorySet();
  check("Canada trae avisos", set.canada.size > 100, set.canada.size + " paises");
  check("indice de nombres armado", set.isoByName.size > 100, set.isoByName.size + " nombres");
  check(
    "el RSS de EE.UU. cruza contra el indice",
    set.usaAvailable && set.usa.size > 50,
    set.usa.size + " paises cruzados",
  );
  // Si el cruce de nombres se rompiera, `usa` quedaria casi vacio sin fallar:
  // por eso se compara la cobertura de los dos feeds y no solo que exista.
  check(
    "cobertura de EE.UU. comparable a la de Canada",
    !set.usaAvailable || set.usa.size > set.canada.size * 0.5,
    set.usa.size + " vs " + set.canada.size,
  );

  // Los paises que cada feed nombra distinto. Sin la tabla de alias, estos se
  // caen del cruce sin que nada falle: el hub simplemente muestra una
  // cancilleria menos y nadie se entera.
  const MUST_CROSS = ["MX", "TR", "MM", "CD", "CG", "CI", "KG", "TL"];
  const missing = MUST_CROSS.filter((cc) => !set.usa.has(cc));
  check(
    "los alias resuelven los nombres divergentes",
    missing.length === 0,
    missing.length ? "faltan " + missing.join(",") : MUST_CROSS.join(","),
  );

  // Dos paises distintos no pueden compartir clave: si pasara, uno pisa al
  // otro y el hub atribuye la alerta equivocada.
  const byKey = new Map<string, string[]>();
  for (const [iso, name] of set.namesByIso) {
    const k = normalizeName(name);
    if (!byKey.has(k)) byKey.set(k, []);
    (byKey.get(k) as string[]).push(iso);
  }
  const collisions = [...byKey.entries()].filter(([, v]) => v.length > 1);
  check(
    "ningun nombre normalizado colisiona",
    collisions.length === 0,
    collisions.map(([k, v]) => k + "=" + v.join("/")).join(" ") || "0 colisiones",
  );

  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getSecurityPoint(c.lat, c.lng, 7);

    console.log("  pais: " + p.country.name + " (" + p.country.code + ")");
    for (const a of p.advisories) {
      console.log(
        "    " + a.issuerName.padEnd(30) + " nivel " + a.level + " · " + a.label +
          (a.regional ? " [avisos regionales]" : "") +
          (a.publishedAt ? " · " + a.publishedAt : ""),
      );
      if (a.recentUpdate) console.log("      ultimo cambio: " + a.recentUpdate.slice(0, 90));
    }
    console.log(
      "  peor nivel: " + (p.worstLevel ?? "s/d") +
        (p.disagreement ? "  ⚠ DESACUERDO entre cancillerias" : "") +
        " | homicidios: " + (p.homicideRate.value ?? "s/d") +
        (p.homicideRate.year ? " (" + p.homicideRate.year + ")" : ""),
    );
    if (p.outbreaks.length) {
      console.log("  brotes OMS: " + p.outbreaks.map((o) => o.title.slice(0, 45)).join(" | "));
    }
    console.log(
      "  conflictividad: " +
        (p.unrest.available ? p.unrest.items.length + " notas en " + p.unrest.windowDays + "d" : "GDELT no respondio"),
    );
    for (const u of p.unrest.items.slice(0, 3)) {
      console.log("    · " + u.date + " " + u.title.slice(0, 70));
    }

    // ── Invariantes ──
    check("resuelve pais", Boolean(p.country.code), p.country.code);
    check("trae al menos una alerta", p.advisories.length > 0, p.advisories.length + " cancillerias");
    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    check(
      "todos los niveles en la escala 1-4",
      p.advisories.every((a) => a.level >= 1 && a.level <= 4),
      p.advisories.map((a) => a.level).join(","),
    );
    check(
      "worstLevel es el maximo de las alertas",
      p.worstLevel === Math.max(...p.advisories.map((a) => a.level)),
      String(p.worstLevel),
    );
    // El desacuerdo tiene que estar respaldado por los niveles que se muestran.
    const spread =
      p.advisories.length > 1
        ? Math.max(...p.advisories.map((a) => a.level)) -
          Math.min(...p.advisories.map((a) => a.level))
        : 0;
    check("el desacuerdo coincide con los niveles", p.disagreement === spread >= 2, "spread " + spread);

    // GDELT caido no puede leerse como "no hay conflictividad".
    check(
      "si GDELT no respondio, se declara y no se muestra como cero",
      p.unrest.available || p.coverage.gaps.some((g) => g.includes("GDELT")),
    );

    if (c.minLevel !== undefined) {
      check("nivel >= " + c.minLevel, (p.worstLevel ?? 0) >= c.minLevel, String(p.worstLevel));
    }
    if (c.maxLevel !== undefined) {
      check("nivel <= " + c.maxLevel, (p.worstLevel ?? 9) <= c.maxLevel, String(p.worstLevel));
    }
  }

  // ── Control duro: paises en guerra deben dar el nivel maximo ──
  console.log("\n=== Control: zonas de guerra en nivel 4 ===");
  for (const [name, lat, lng] of [
    ["Kabul", 34.5553, 69.2075],
    ["Damasco", 33.5138, 36.2765],
  ] as Array<[string, number, number]>) {
    const p = await getSecurityPoint(lat, lng, 7);
    check(name + " en nivel 4", p.worstLevel === 4, p.country.code + " nivel " + p.worstLevel);
  }

  // ── Control duro: el oceano no tiene pais ──
  console.log("\n=== Control: punto oceanico ===");
  try {
    await getSecurityPoint(-30, -30, 7);
    check("el oceano deberia fallar", false, "devolvio payload");
  } catch {
    check("el oceano falla explicitamente", true);
  }

  console.log(failures === 0 ? "\n✓ hub de seguridad OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test:security exploto:", err);
  process.exit(1);
});
