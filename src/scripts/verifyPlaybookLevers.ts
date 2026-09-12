/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verifica que el catálogo de playbooks siga siendo ejecutable.
 *
 *   npm run verify:playbook-levers
 *
 * Un playbook puede quedar inútil sin que nada falle: si una tool se renombra o
 * se desactiva, la palanca queda apuntando al vacío y el efecto es silencioso —
 * el modelo propone un paso, la validación lo descarta, y el usuario recibe un
 * plan más corto sin que nadie se entere de por qué. Este script convierte eso
 * en un error de consola.
 *
 * Lee de la base pero no escribe nada.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { loadActivePlaybooks } from "../modules/growth/playbooks/growthPlaybook.model";
import { CORE_LEVERS, DRILLDOWN_TOOLS } from "../modules/growth/playbooks/leverIndex";
import { Tool } from "../modules/tools/tools.model";
import { flattenSnapshot } from "../modules/growth/snapshot/indicators";
import { resolveApplicablePlaybooks } from "../modules/growth/playbooks/resolver";
import type { PropertySnapshot } from "../modules/growth/snapshot/snapshot.types";

let problems = 0;

function bad(msg: string) {
  problems++;
  console.log(`  ✗ ${msg}`);
}

async function main() {
  await connectDB();

  const playbooks = await loadActivePlaybooks();
  console.log(`Playbooks activos: ${playbooks.length}`);
  if (playbooks.length === 0) {
    bad("no hay ningún playbook activo — corré `npm run seed:growth-playbooks`");
  }

  // 1. Toda palanca referenciada existe y está activa.
  const referenced = new Set<string>([...CORE_LEVERS, ...DRILLDOWN_TOOLS]);
  for (const p of playbooks) for (const l of p.levers) referenced.add(l.tool);

  const docs = await Tool.find(
    { name: { $in: [...referenced] } },
    { name: 1, status: 1, category: 1, "execution.method": 1 },
  ).lean();
  const byName = new Map(docs.map((d) => [d.name, d]));

  console.log("\n── Palancas contra el catálogo real ──");
  for (const name of [...referenced].sort()) {
    const doc = byName.get(name);
    if (!doc) {
      const where = playbooks
        .filter((p) => p.levers.some((l) => l.tool === name))
        .map((p) => p.playbookId);
      bad(
        `"${name}" no existe en el catálogo` +
          (where.length ? ` (lo usan: ${where.join(", ")})` : " (núcleo fijo)"),
      );
      continue;
    }
    if (doc.status !== "active") bad(`"${name}" existe pero está inactiva`);
  }

  // 2. Los drill-downs tienen que ser lecturas. Ofrecer una escritura como
  //    "drill-down" le daría al turno estratégico la capacidad de operar sin
  //    pasar por el plan ni por la confirmación del usuario.
  console.log("\n── Drill-downs: sólo lecturas ──");
  for (const name of DRILLDOWN_TOOLS) {
    const doc = byName.get(name);
    if (!doc) continue;
    if (doc.execution?.method !== "GET" || /(_write$|^raw_write$)/.test(doc.category)) {
      bad(`"${name}" está ofrecida como drill-down pero NO es de lectura`);
    }
  }

  // 3. Reglas sanas: sin reglas, un playbook sería un comodín que aplica siempre.
  console.log("\n── Reglas de aplicabilidad ──");
  for (const p of playbooks) {
    if (p.applicability.length === 0) {
      bad(`"${p.playbookId}" no tiene reglas: nunca va a aplicar (el resolver lo descarta)`);
    }
    if (p.levers.length === 0) {
      bad(`"${p.playbookId}" no tiene palancas: el modelo no tendría qué proponer`);
    }
    if (p.kpis.length === 0) {
      bad(`"${p.playbookId}" no declara KPI: no se va a poder medir si funcionó`);
    }
    for (const rule of p.applicability) {
      // Los nombres llevan dígitos (`ops.occ30`, `demand.otb90`): la ventana en
      // días es parte del indicador, no un sufijo decorativo.
      if (!/^[a-z]+\.[a-zA-Z][a-zA-Z0-9]*$/.test(rule.path)) {
        bad(`"${p.playbookId}": el path "${rule.path}" no tiene forma bloque.campo`);
      }
    }
  }

  // 4. Un hotel promedio tiene que matchear algo. Si con una foto típica no
  //    aplica ningún playbook, el turno estratégico existe pero no sirve.
  console.log("\n── Cobertura con perfiles típicos ──");
  for (const [label, snap] of Object.entries(PROFILES)) {
    const matches = resolveApplicablePlaybooks(playbooks, flattenSnapshot(snap));
    const ids = matches.map((m) => m.playbook.playbookId);
    console.log(`  ${label}: ${ids.join(", ") || "(ninguno)"}`);
    if (ids.length === 0) {
      bad(`el perfil "${label}" no matchea ningún playbook`);
    }
  }

  console.log(
    problems === 0
      ? "\n✓ El catálogo de playbooks es ejecutable."
      : `\n✗ ${problems} problema(s).`,
  );
  await mongoose.disconnect();
  process.exit(problems === 0 ? 0 : 1);
}

// Perfiles de hotel para la cobertura. No son datos reales: son las situaciones
// que el agente tiene que poder diagnosticar.
function base(over: Partial<PropertySnapshot>): PropertySnapshot {
  return {
    propertyId: "p",
    companyId: "c",
    takenAt: new Date().toISOString(),
    missing: [],
    collectedInMs: 0,
    identity: {
      propertyId: "p", name: "H", type: "hotel", city: "X", countryCode: "AR",
      currency: "ARS", lat: -34, lng: -58, salesModel: "category_based",
      units: 20, categories: 4, monthsOnPlatform: 24,
    },
    demand: null, ops: null, direct: null, presence: null,
    reputation: null, market: null, revenue: null,
    ...over,
  };
}

const PROFILES: Record<string, PropertySnapshot> = {
  "recién llegado": base({
    identity: { ...base({}).identity, monthsOnPlatform: 1 },
    demand: { hasHistory: false, historyDays: 0, otb30: 0, otb60: 0, otb90: 0, occ30: 0, adr: null, revenueOtb30: 0, paceIndexAvg: null, pickup7d: 0, datesAtRisk: 0 },
    presence: { sitePublished: false, siteLanguages: 0, linkhubPublished: false, visibilityScore: 12, seoScore: 10, geoScore: 5, gbpCompleteness: 0, otaCompleteness: 0, otaPlatforms: [], socialConnected: 0 },
  }),
  "invisible": base({
    presence: { sitePublished: false, siteLanguages: 0, linkhubPublished: false, visibilityScore: 28, seoScore: 30, geoScore: 12, gbpCompleteness: 0.3, otaCompleteness: 0.4, otaPlatforms: ["booking"], socialConnected: 0 },
    direct: { engineActive: true, ratePlans: 2, promosActive: 0, webOnlyPromo: false, hasRestrictions: false },
  }),
  "temporada baja lenta": base({
    market: { season: "baja", eventsNext90d: 1, topEvents: [], longWeekendsNext90d: 1, radiusKm: 30 },
    demand: { hasHistory: true, historyDays: 120, otb30: 30, otb60: 40, otb90: 45, occ30: 0.21, adr: 60, revenueOtb30: 1800, paceIndexAvg: 0.72, pickup7d: 3, datesAtRisk: 14 },
  }),
  "se llena barato": base({
    demand: { hasHistory: true, historyDays: 200, otb30: 90, otb60: 120, otb90: 150, occ30: 0.88, adr: 60000, revenueOtb30: 9000000, paceIndexAvg: 1.2, pickup7d: 20, datesAtRisk: 0 },
  }),
  "reputación desatendida": base({
    reputation: { rating: 4.0, reviews: 60, responded: 8, last90d: 12 },
  }),
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
