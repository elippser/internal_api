// Prueba en vivo del hub de calendario y feriados SIN base de datos: pega
// contra las fuentes reales (Nominatim, Nager.Date, OpenHolidays, Aladhan,
// Hebcal) para puntos de calendarios bien distintos.
//
//   npm run test:calendar                      # los 5 puntos de muestra
//   npm run test:calendar -- -34.6 -58.4       # un lat/lng puntual
//
// No persiste nada. El cache por (país, año) hace que la 2ª corrida vuele.

import "dotenv/config";
import { getCalendarPoint } from "../modules/calendar/calendar.service";

const SAMPLES: Array<{ label: string; lat: number; lng: number }> = [
  { label: "Buenos Aires (AR: puentes + aguinaldo)", lat: -34.6, lng: -58.4 },
  { label: "Madrid (ES: escolares + efemérides propias)", lat: 40.42, lng: -3.7 },
  { label: "São Paulo (BR: sin escolares, padre en agosto)", lat: -23.55, lng: -46.63 },
  { label: "Berlín (DE: escolares por länder)", lat: 52.52, lng: 13.4 },
  { label: "Dubái (AE: sin curar, Ramadán relevante)", lat: 25.2, lng: 55.27 },
];

const dow = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

async function run(label: string, lat: number, lng: number): Promise<boolean> {
  const t0 = Date.now();
  try {
    const d = await getCalendarPoint(lat, lng);
    console.log(`\n── ${label}  ${Date.now() - t0}ms`);
    console.log(`   país: ${d.location.countryCode} ${d.location.countryName} · ventana ${d.window.from} → ${d.window.to}`);

    const byKind = (k: string) => d.entries.filter((e) => e.kind === k);
    console.log(
      `   entradas: ${d.entries.length}` +
        ` (públicos ${byKind("public").length}` +
        ` · efemérides ${byKind("observance").length}` +
        ` · religiosas ${byKind("religious").length}` +
        ` · cobros ${byKind("payday").length})`,
    );

    console.log(`   fines de semana largos: ${d.longWeekends.length}`);
    for (const lw of d.longWeekends.slice(0, 3)) {
      console.log(
        `     ${lw.startDate}→${lw.endDate} (${lw.dayCount}d)` +
          `${lw.needBridgeDay ? ` PUENTE: ${lw.bridgeDays.join(",")}` : ""}` +
          `${lw.holidays.length ? ` · ${lw.holidays.join(" / ")}` : ""}`,
      );
    }

    const obs = byKind("observance");
    if (obs.length) {
      console.log(`   efemérides: ${obs.map((o) => `${o.name} ${o.date}(${dow[o.weekday]})`).join(" · ")}`);
    }
    const pay = byKind("payday");
    if (pay.length) console.log(`   cobros: ${pay.map((p) => `${p.name} ${p.date}`).join(" · ")}`);

    console.log(`   recesos escolares: ${d.schoolBreaks.length}`);
    for (const b of d.schoolBreaks.slice(0, 2)) {
      console.log(`     ${b.startDate}→${b.endDate} ${b.name} [${b.season}] ${b.dayCount}d ${b.nationwide ? "nacional" : "regional"}`);
    }

    const m = d.moveable;
    console.log(
      `   móviles: Ramadán ${m.ramadan ? `${m.ramadan.start}→${m.ramadan.end}` : "—"}` +
        ` · Eid al-Fitr ${m.eidAlFitr ?? "—"} · Eid al-Adha ${m.eidAlAdha ?? "—"}` +
        ` · judías ${m.jewish.length} · Pascua ${m.easter?.date ?? "—"}`,
    );

    console.log(`   emisores: ${d.emitters.map((e) => `${e.countryCode}(${e.longWeekends.length}fds)`).join(" ")}`);
    console.log(`   cobertura: ${Object.entries(d.coverage).filter(([k]) => k !== "gaps").map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ")}`);
    for (const g of d.coverage.gaps) console.log(`     hueco: ${g}`);

    if (d.entries.length === 0) {
      console.error("   ✗ sin ninguna entrada de calendario");
      return false;
    }
    return true;
  } catch (err) {
    console.error(`\n── ${label}  ✗ ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let ok = true;

  if (args.length >= 2) {
    const lat = Number(args[0]);
    const lng = Number(args[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error("Uso: npm run test:calendar -- <lat> <lng>");
      process.exit(1);
    }
    ok = await run("punto manual", lat, lng);
  } else {
    for (const [i, s] of SAMPLES.entries()) {
      // Nominatim pide máximo 1 req/s y Nager agradece no ser martillado.
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      ok = (await run(s.label, s.lat, s.lng)) && ok;
    }
  }

  console.log(ok ? "\n✓ hub de calendario OK" : "\n✗ hub de calendario con fallas");
  process.exit(ok ? 0 : 1);
}

void main();
