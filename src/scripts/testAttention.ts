// Smoke del hub de atencion y tendencias (event-list.md §13).
//   npm run test:attention

import { getAttentionPoint } from "../modules/attention/attention.service";

let failures = 0;
const check = (l: string, ok: boolean, d = ""): void => {
  if (!ok) { failures++; console.error("  ✗ " + l + (d ? " -> " + d : "")); }
  else console.log("  ✓ " + l + (d ? " -> " + d : ""));
};

const CASES = [
  { name: "Bariloche", lat: -41.1335, lng: -71.3103, expect: "atencion dominante en espaniol" },
  { name: "Paris", lat: 48.8566, lng: 2.3522, expect: "atencion multi-idioma alta" },
  { name: "Kioto", lat: 35.0116, lng: 135.7681, expect: "destino global" },
  { name: "Medio del Atlantico", lat: -30, lng: -30, expect: "sin articulo" },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log("\n=== " + c.name + " (" + c.expect + ") ===");
    const p = await getAttentionPoint(c.lat, c.lng, 180);
    console.log(
      "  articulo: " + (p.article.title ?? "ninguno") +
      " (via " + p.article.resolvedVia + ")" +
      (p.article.place ? " | lugar: " + p.article.place : ""),
    );
    console.log("  vistas totales (180d): " + p.totalViews.toLocaleString("es-AR"));
    for (const l of p.byLanguage.slice(0, 5)) {
      console.log(
        "    " + l.code + " " + l.label.padEnd(11) + String(l.totalViews).padStart(8) +
        "  " + Math.round(l.share * 100) + "%  " + l.dailyMean + "/dia" +
        (l.spike ? "  PICO x" + l.spike.ratio : ""),
      );
    }
    if (p.spike) console.log("  PICO: x" + p.spike.ratio + " vs mediana " + p.spike.baselineDailyMedian);
    if (p.nearby.length) console.log("  cerca: " + p.nearby.slice(0, 3).map((n) => n.title).join(" | "));

    check("declara gaps", p.coverage.gaps.length > 0, p.coverage.gaps.length + " gaps");
    // Las proporciones tienen que sumar 1 si hay algun idioma con datos.
    const sum = p.byLanguage.reduce((s, l) => s + l.share, 0);
    check(
      "las proporciones por idioma suman 1",
      p.byLanguage.length === 0 || Math.abs(sum - 1) < 0.02,
      sum.toFixed(3),
    );
    check(
      "los idiomas vienen ordenados por volumen",
      p.byLanguage.every((l, i) => i === 0 || p.byLanguage[i - 1].totalViews >= l.totalViews),
    );
    check(
      "el total coincide con la suma por idioma",
      p.totalViews === p.byLanguage.reduce((s, l) => s + l.totalViews, 0),
    );
    // Un pico declarado tiene que superar el umbral que lo define.
    check(
      "todo pico supera 1.5x",
      p.byLanguage.every((l) => !l.spike || l.spike.ratio >= 1.5),
      p.byLanguage.filter((l) => l.spike).map((l) => l.code + ":" + l.spike!.ratio).join(",") || "(ninguno)",
    );
    check("sin articulo no hay vistas", p.article.title !== null || p.totalViews === 0);
  }

  // ── Control duro: un destino global supera a uno regional ──
  console.log("\n=== Control: la atencion discrimina ===");
  const paris = await getAttentionPoint(48.8566, 2.3522, 180);
  const bari = await getAttentionPoint(-41.1335, -71.3103, 180);
  check(
    "Paris tiene mas atencion que Bariloche",
    paris.totalViews > bari.totalViews,
    paris.totalViews + " vs " + bari.totalViews,
  );
  check(
    "Paris tiene mas idiomas con datos que Bariloche",
    paris.byLanguage.length >= bari.byLanguage.length,
    paris.byLanguage.length + " vs " + bari.byLanguage.length,
  );
  // El espaniol pesa MUCHO mas en Bariloche que en Kioto: esa comparacion si
  // es valida, porque compara la misma edicion entre dos destinos. Comparar
  // idiomas entre si no lo es (ver el gap de trafico base).
  const kioto = await getAttentionPoint(35.0116, 135.7681, 180);
  const esShare = (p2: typeof bari) => p2.byLanguage.find((l) => l.code === "es")?.share ?? 0;
  check(
    "el espaniol pesa mas en Bariloche que en Kioto",
    esShare(bari) > esShare(kioto),
    Math.round(esShare(bari) * 100) + "% vs " + Math.round(esShare(kioto) * 100) + "%",
  );
  // Y los titulos por idioma tienen que ser distintos donde corresponde: si
  // fueran todos iguales, el ingles daria casi cero y la lectura se invertiria.
  const kEn = kioto.byLanguage.find((l) => l.code === "en");
  check(
    "cada idioma usa su propio titulo",
    kEn !== undefined && kEn.title !== kioto.article.title,
    (kioto.article.title ?? "?") + " vs en:" + (kEn?.title ?? "?"),
  );

  console.log(failures === 0 ? "\n✓ hub de atencion OK" : "\n✗ " + failures + " chequeos fallaron");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("test:attention exploto:", e); process.exit(1); });
