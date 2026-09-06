// Smoke del hub regulatorio (event-list.md §8). Pega contra la fuente real:
// si el CSV de passport-index cambia de forma o de URL, esto lo grita.
//
//   npm run test:policy

import { getPolicyPoint } from "../modules/policy/policy.service";
import { classify } from "../modules/policy/visa";

interface Case {
  name: string;
  lat: number;
  lng: number;
  expect: string;
}

const CASES: Case[] = [
  { name: "Buenos Aires", lat: -34.6037, lng: -58.3816, expect: "Mercosur libre, EE.UU. con visa para AR pero no al reves" },
  { name: "Madrid", lat: 40.4168, lng: -3.7038, expect: "Schengen + restriccion de alquiler temporario" },
  { name: "Nueva York", lat: 40.7128, lng: -74.006, expect: "Local Law 18: prohibicion de alquiler temporario" },
  { name: "Lagos", lat: 6.5244, lng: 3.3792, expect: "fiebre amarilla a todo viajero + CEDEAO" },
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
  // ── Unitarios de la normalizacion ──
  console.log("=== Normalizacion del dataset ===");
  const table: Array<[string, string, number | null]> = [
    ["90", "visa-free", 90],
    ["visa free", "visa-free", null],
    ["visa required", "visa-required", null],
    ["e-visa", "e-visa", null],
    ["visa on arrival", "visa-on-arrival", null],
    ["eta", "eta", null],
    ["no admission", "no-admission", null],
    ["-1", "same-country", null],
  ];
  for (const [raw, cat, days] of table) {
    const r = classify(raw);
    check(
      'clasifica "' + raw + '"',
      r.category === cat && r.days === days,
      r.category + (r.days !== null ? "/" + r.days : ""),
    );
  }

  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getPolicyPoint(c.lat, c.lng);

    console.log(
      "  pais: " + p.country.name + " (" + p.country.code + ") | dataset " + p.dataset.dataDate +
        " (" + p.dataset.monthsOld + " meses" + (p.dataset.stale ? ", VIEJO" : "") + ")",
    );
    console.log(
      "  titular: " + p.headline.noPriorPaperwork + " sin tramite previo / " +
        p.headline.priorPaperwork + " con tramite" +
        (p.headline.blocked ? " / " + p.headline.blocked + " sin admision" : "") +
        ", de " + p.headline.total + " | mismo bloque: " + p.headline.sameBloc,
    );
    if (p.destinationBlocs.length) {
      console.log("  bloques del destino: " + p.destinationBlocs.map((b) => b.name).join(", "));
    }
    for (const e of p.emitters) {
      console.log(
        "    " + e.countryCode + " " + e.countryName.padEnd(16) + e.category.padEnd(16) +
          (e.days ? e.days + "d " : "    ") +
          (e.blocs.length ? "[" + e.blocs.join(", ") + "]" : "") +
          (e.conflict ? "  ⚠ contradiccion" : ""),
      );
    }
    console.log("  sanitario: " + p.health.yellowFever);
    for (const s of p.strRegulation) {
      console.log("  alquiler temporario: " + s.city + " [" + s.severity + "] " + s.summary.slice(0, 70));
    }

    // ── Invariantes ──
    check("resuelve pais", Boolean(p.country.code), p.country.code);
    check("trae emisores", p.emitters.length > 0, p.emitters.length + " emisores");
    check(
      "ningun emisor es el propio pais",
      !p.emitters.some((e) => e.countryCode === p.country.code),
    );
    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");

    // Los tres cubos tienen que cubrir a todos los emisores: si alguno queda
    // afuera el titular miente por omision, que fue el bug de Lagos.
    check(
      "los cubos del titular suman el total",
      p.headline.noPriorPaperwork + p.headline.priorPaperwork + p.headline.blocked ===
        p.headline.total,
      p.headline.noPriorPaperwork + "+" + p.headline.priorPaperwork + "+" +
        p.headline.blocked + " vs " + p.headline.total,
    );

    // La frescura viaja siempre: es la garantia mas debil de este hub y no
    // puede quedar implicita.
    check(
      "publica la fecha del dataset",
      Boolean(p.dataset.dataDate) && /^\d{4}-\d{2}-\d{2}$/.test(p.dataset.dataDate),
      p.dataset.dataDate,
    );
    check(
      "declara la vejez cuando corresponde",
      !p.dataset.stale || p.coverage.gaps.some((g) => g.includes("matriz de visados")),
    );

    // La tabla se lee de arriba hacia abajo: el orden es la respuesta.
    check(
      "emisores ordenados por friccion",
      p.emitters.every((e, i) => i === 0 || p.emitters[i - 1].friction <= e.friction),
      p.emitters.map((e) => e.friction).join(","),
    );

    // Un bloque de libre transito y una visa exigida no pueden convivir sin
    // que quede marcado.
    check(
      "nadie con bloque compartido queda como 'visa requerida' sin marca",
      p.emitters.every(
        (e) => !(e.blocs.length > 0 && e.category === "visa-required") || e.conflict,
      ),
    );
  }

  // ── Controles duros contra pares conocidos ──
  console.log("\n=== Control: pares de visado conocidos ===");
  const ar = await getPolicyPoint(-34.6037, -58.3816);
  const br = ar.emitters.find((e) => e.countryCode === "BR");
  const us = ar.emitters.find((e) => e.countryCode === "US");
  check("Brasil entra a Argentina sin visa", br?.category === "visa-free", br?.category ?? "?");
  check("Brasil comparte Mercosur con Argentina", (br?.blocs.length ?? 0) > 0, br?.blocs.join(",") ?? "");
  check("EE.UU. entra a Argentina sin visa", us?.category === "visa-free", us?.category ?? "?");

  const es = await getPolicyPoint(40.4168, -3.7038);
  const esAr = es.emitters.find((e) => e.countryCode === "AR");
  check("Argentina entra a Espana sin visa", esAr?.category === "visa-free", esAr?.category ?? "?");
  check(
    "Madrid tiene norma de alquiler temporario",
    es.strRegulation.length > 0,
    es.strRegulation.map((s) => s.city).join(","),
  );

  // ── Control duro: el oceano no tiene politica migratoria ──
  console.log("\n=== Control: punto oceanico ===");
  try {
    await getPolicyPoint(-30, -30);
    check("el oceano deberia fallar", false, "devolvio payload");
  } catch {
    check("el oceano falla explicitamente", true);
  }

  console.log(failures === 0 ? "\n✓ hub regulatorio OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test:policy exploto:", err);
  process.exit(1);
});
