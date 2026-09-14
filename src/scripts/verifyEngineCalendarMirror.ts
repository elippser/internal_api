/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * El diagnóstico del calendario de Roombir IA decide IGUAL que la web.
 *
 * `diagnose_booking_calendar` (engineCalendarDiagnosis.ts) le explica al
 * hotelero por qué un huésped no puede elegir una fecha. Para eso copia las
 * reglas del datepicker del motor, que viven en el FRONT (`calendarInfo.ts`,
 * con copias en el web-renderer, el builder y web-engine-public) y en el
 * normalizador del Estudio del Motor. Si una copia cambia y la otra no, el
 * agente explica un calendario que no es el que ve el huésped — el mismo
 * punto ciego que el 13-09-2026 lo dejó adivinando por qué noviembre no se
 * podía seleccionar.
 *
 * Qué corre (sin DB, sin red):
 *   1. Una matriz determinística de calendarios (cupo, CTA/CTD, estadías
 *      mínimas/máximas por día y del motor, fecha mínima, días sin dato) y, para
 *      cada llegada, compara día por día `dayDecision` contra la misma
 *      composición hecha con las funciones de CADA copia del front, más
 *      `checkoutBounds`.
 *   2. El caso real que originó todo, como regresión con nombre.
 *   3. Que cada consumidor del front use `picksCheckout` (una copia de la
 *      regla que nadie llama no arregla nada).
 *   4. El bloque `calendar` de `normalizeEngineStudioConfig` contra
 *      `describeEngineStudio`.
 *
 *   npm run verify:engine-calendar-mirror
 */
import fs from "fs";
import path from "path";

import * as diag from "../modules/conversations/services/engineCalendarDiagnosis";
import { REPO_ROOT } from "./lib/pmsRouteInventory";

const RULE_COPIES = [
  "public-side/web-renderer/src/renderer/components/BookingEngineRenderer/calendarInfo.ts",
  "pms-core/app/src/app/apps/builder/components/Builder/PreviewRenderer/BookingEngineRenderer/calendarInfo.ts",
  "booking-app/web-engine-public/src/lib/calendarInfo.ts",
];

const CONSUMERS = [
  "public-side/web-renderer/src/renderer/components/BookingEngineRenderer/BookingEngineRenderer.tsx",
  "pms-core/app/src/app/apps/builder/components/Builder/PreviewRenderer/BookingEngineRenderer/BookingEngineRenderer.tsx",
  "booking-app/web-engine-public/src/components/AvailabilitySearch/Calendar.tsx",
  "booking-app/web-engine-public/src/components/AvailabilitySearch/AvailabilitySearchBar.tsx",
];

const STUDIO_COPIES = [
  "public-side/web-renderer/src/renderer/engine-studio/engineStudioTypes.ts",
  "pms-core/app/src/app/apps/builder/engine-studio/engineStudioTypes.ts",
];

let failures = 0;
let checks = 0;
function fail(msg: string): void {
  failures++;
  if (failures <= 25) console.log(`  FALLA ${msg}`);
}

// ── Datos determinísticos ────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = "2026-10-01";
const SPAN = 80;

function makeData(rand: () => number): diag.PublicCalendarData {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const days: Record<string, diag.PublicCalendarDay> = {};
  for (let i = 0; i < SPAN; i++) {
    if (rand() < 0.05) continue; // día sin dato: no bloquea
    const date = diag.addDaysIso(START, i);
    const available = rand() > 0.12;
    days[date] = {
      date,
      available,
      units: available ? pick([1, 2, 5, 12]) : null,
      closed: !available,
      closed_to_arrival: rand() < 0.1,
      closed_to_departure: rand() < 0.1,
      min_stay: pick([null, null, null, 2, 4]),
      max_stay: pick([null, null, null, 3, 20]),
      rate_from: available ? 100 : null,
    };
  }
  return {
    currency: "ARS",
    display: {
      enabled: true,
      showPrices: true,
      showUnits: true,
      showRestrictionFlags: true,
      showStayHints: true,
      minDate: diag.addDaysIso(START, pick([0, 0, 2, 9])),
      engineMinNights: pick([1, 1, 2, 3, 0]),
      engineMaxNights: pick([30, 7, 14, 365, 0]),
    },
    days,
  };
}

/** Misma composición que BookingEngineRenderer, con las funciones de una copia. */
function frontDecision(f: any, iso: string, ci: string | null, data: diag.PublicCalendarData) {
  const pickingCheckout = !!ci && f.picksCheckout(iso, ci, data);
  const disabled = iso < data.display.minDate;
  let vxBlocked = false;
  if (data.days[iso]) {
    vxBlocked = pickingCheckout ? !f.isValidCheckout(iso, ci, data) : !f.canStartStay(iso, data);
  }
  return { blocked: disabled || vxBlocked, as: pickingCheckout ? "departure" : "arrival" };
}

function loadTs(rel: string): any | null {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return require(abs);
}

function main(): void {
  const copies = RULE_COPIES.map((rel) => ({ rel, mod: loadTs(rel) })).filter((c) => c.mod);
  if (!copies.length) {
    console.log(`⚠ No se encontraron las copias del front bajo ${REPO_ROOT}. Definí PMS_REPOS_ROOT. Nada que verificar.`);
    process.exit(0);
  }

  console.log("\n[1] Reglas del calendario: diagnóstico vs cada copia del front");
  for (const { rel, mod } of copies) {
    for (const fn of ["canStartStay", "checkoutBounds", "isValidCheckout", "picksCheckout"]) {
      if (typeof mod[fn] !== "function") fail(`${rel}: falta ${fn} — copia desactualizada`);
    }
  }
  if (failures) finish();

  const rand = mulberry32(20260913);
  for (let scenario = 0; scenario < 60; scenario++) {
    const data = makeData(rand);
    const cis: Array<string | null> = [null];
    for (let k = 0; k < 8; k++) cis.push(diag.addDaysIso(START, Math.floor(rand() * SPAN)));
    for (const ci of cis) {
      for (const { rel, mod } of copies) {
        if (ci) {
          const a = diag.checkoutBounds(ci, data);
          const b = mod.checkoutBounds(ci, data);
          checks++;
          if (a.minCo !== b.minCo || a.maxCo !== b.maxCo) {
            fail(`escenario ${scenario} llegada ${ci}: checkoutBounds ${JSON.stringify(a)} ≠ ${JSON.stringify(b)} (${rel})`);
          }
        }
        for (let i = -2; i < SPAN + 10; i++) {
          const iso = diag.addDaysIso(START, i);
          const want = frontDecision(mod, iso, ci, data);
          const got = diag.dayDecision(iso, ci, data);
          checks++;
          if (want.blocked !== got.blocked || want.as !== got.as) {
            fail(`escenario ${scenario} llegada ${ci ?? "(ninguna)"} día ${iso}: front ${JSON.stringify(want)} ≠ diagnóstico ${JSON.stringify(got)} (${rel})`);
          }
        }
      }
    }
  }
  console.log(`  ${checks} comparaciones sobre ${copies.length} copia(s)`);

  console.log("\n[2] Regresión 13-09-2026: estadía máxima de 30 noches, noviembre seleccionable");
  const november: diag.PublicCalendarData = {
    currency: "ARS",
    display: { enabled: true, showPrices: true, showUnits: true, showRestrictionFlags: true, showStayHints: true, minDate: "2026-09-13", engineMinNights: 1, engineMaxNights: 30 },
    days: {},
  };
  for (let i = 0; i < 110; i++) {
    const date = diag.addDaysIso("2026-09-13", i);
    november.days[date] = { date, available: true, units: 24, closed: false, closed_to_arrival: false, closed_to_departure: false, min_stay: null, max_stay: null, rate_from: 100000 };
  }
  for (const { rel, mod } of [{ rel: "diagnóstico", mod: diag }, ...copies]) {
    const d = frontDecision(mod, "2026-11-15", "2026-10-02", november);
    checks++;
    if (d.blocked || d.as !== "arrival") {
      fail(`${rel}: con llegada 2026-10-02 el 2026-11-15 da ${JSON.stringify(d)}; tiene que ser llegada nueva seleccionable`);
    }
    const inside = frontDecision(mod, "2026-10-20", "2026-10-02", november);
    checks++;
    if (inside.blocked || inside.as !== "departure") {
      fail(`${rel}: con llegada 2026-10-02 el 2026-10-20 da ${JSON.stringify(inside)}; tiene que ser salida válida`);
    }
  }

  console.log("\n[3] Los consumidores del front usan picksCheckout");
  for (const rel of CONSUMERS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    checks++;
    if (!/picksCheckout\(/.test(fs.readFileSync(abs, "utf8"))) {
      fail(`${rel} no llama a picksCheckout: el calendario vuelve a validar como salida los días fuera de la estadía`);
    }
  }

  console.log("\n[4] Estudio del Motor: normalizeEngineStudioConfig vs describeEngineStudio");
  const samples: unknown[] = [
    null,
    undefined,
    {},
    { calendar: null },
    { calendar: { enabled: false } },
    { calendar: { showPrices: false, showUnits: "no" } },
    { calendar: { enabled: true, showStatusDots: false, showRestrictionFlags: false, showStayHints: false } },
    [],
  ];
  for (const rel of STUDIO_COPIES) {
    const mod = loadTs(rel);
    if (!mod) continue;
    if (typeof mod.normalizeEngineStudioConfig !== "function") {
      fail(`${rel}: no exporta normalizeEngineStudioConfig`);
      continue;
    }
    for (const raw of samples) {
      const want = mod.normalizeEngineStudioConfig(raw)?.calendar ?? {};
      const got = diag.describeEngineStudio(raw).effective.calendar;
      const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
      for (const k of keys) {
        checks++;
        if (want[k] !== (got as any)[k]) {
          fail(`${rel} con ${JSON.stringify(raw)}: calendar.${k} front=${want[k]} diagnóstico=${(got as any)[k]}`);
        }
      }
    }
  }

  finish();
}

function finish(): never {
  console.log(`\n${checks} chequeos · ${failures} fallas`);
  console.log(failures ? "✗ El diagnóstico y la web deciden distinto (ver arriba)." : "✓ El diagnóstico decide igual que la web.");
  process.exit(failures ? 1 : 0);
}

main();
