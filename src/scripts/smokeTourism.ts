/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smoke del estado turístico contra DATOS REALES, sin gastar un token.
 *
 *   npm run smoke:tourism -- <propertyId> [opciones]
 *   npm run smoke:tourism -- --point -32.89,-68.84,mendoza [opciones]
 *
 * Opciones:
 *   --facets eventos,entorno   facetas de la tarjeta (default: las cuatro, una tarjeta por faceta)
 *   --budget 6000              presupuesto del primer pedido, en ms
 *   --fresh                    ignora el TTL
 *   --persist                  guarda en `tourism_dossiers` (ESCRIBE en la base compartida con producción)
 *   --dump <label>             guarda los payloads crudos como fixtures en src/scripts/fixtures/tourism/<label>/
 *   --print                    imprime el bloque completo que leería el modelo
 *
 * Corre lo mismo que el turno ANTES del modelo: ubica la propiedad, lee los
 * hubs en proceso con el presupuesto del turno, arma las tarjetas y el bloque.
 * Después espera las lecturas lentas y muestra lo que habría encontrado la
 * pregunta siguiente. Sin `--persist` todo queda en memoria.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { createCollectors } from "../modules/tourism/collectors";
import {
  createMemoryDossierStore,
  getDossier,
  waitForDossierFlights,
  type DossierDeps,
  type DossierResult,
} from "../modules/tourism/dossier.service";
import { geocodeAddress, loadPropertyDoc, type PropertyDoc } from "../modules/tourism/location";
import { buildCard } from "../modules/tourism/card";
import { renderTourismBlock } from "../modules/tourism/render";
import {
  TOURISM_FACETS,
  TOURISM_HUBS,
  hubsForFacets,
  isTourismFacet,
  type HubEnvelope,
  type TourismFacet,
} from "../modules/tourism/tourism.types";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const tokens = (s: string) => Math.round(s.length / 3.6);
const box = (title: string) => console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);

function printResult(label: string, r: DossierResult) {
  box(label);
  if (!r.ok) {
    console.log(`✗ ${r.reason}: ${r.message}`);
    return;
  }
  const d = r.dossier;
  console.log(`${d.property.typeLabel} "${d.property.name}" · ${d.property.addressShort}`);
  console.log(`Ubicación: ${d.location.lat.toFixed(5)}, ${d.location.lng.toFixed(5)} (${d.location.source}${d.location.geocodedFrom ? ` ← ${d.location.geocodedFrom}` : ""})`);
  console.log(`Foto: ${d.property.photoUrl ?? "(sin foto)"}`);
  console.log(`Tardó ${d.meta.ms} ms\n`);
  for (const hub of TOURISM_HUBS) {
    const env = d.hubs[hub] as HubEnvelope | undefined;
    const state = d.meta.computed.includes(hub)
      ? "leído"
      : d.meta.pending.includes(hub)
        ? "PENDIENTE"
        : d.meta.skipped.some((s) => s.hub === hub)
          ? "omitido"
          : d.meta.stale.includes(hub)
            ? "vencido"
            : env
              ? "cache"
              : "—";
    const data = env ? (env.data ? "con dato" : "SIN DATO") : "";
    console.log(
      `  ${hub.padEnd(10)} ${state.padEnd(10)} ${data.padEnd(9)} ${env ? `${String(env.ms).padStart(6)} ms` : "".padStart(9)}` +
        `${env?.error ? `  error: ${env.error}` : ""}${env?.missing.length ? `  faltó: ${env.missing.join("; ")}` : ""}`,
    );
  }
  for (const s of d.meta.skipped) console.log(`  (omitido ${s.hub}: ${s.reason})`);
}

async function main() {
  const point = option("point");
  if (!positional && !point) {
    console.error("Uso: npm run smoke:tourism -- <propertyId> | --point lat,lng[,label] [--facets a,b] [--budget ms] [--persist] [--dump label] [--print]");
    process.exit(1);
  }

  const facetsArg = option("facets");
  const facets: TourismFacet[] = facetsArg
    ? facetsArg.split(",").map((f) => f.trim()).filter(isTourismFacet)
    : [...TOURISM_FACETS];
  const budgetMs = Number(option("budget") ?? 6000);
  const dumpLabel = option("dump");

  // La cola larga de eventos se lee en proceso: hace falta la base del internal.
  try {
    await connectDB();
  } catch (err) {
    console.warn("⚠ Sin base del internal: la agenda de eventos va por HTTP si INTELLIGENCE_API_URL está configurada.", (err as Error).message);
  }

  const raws: Record<string, unknown> = {};
  let pointDoc: PropertyDoc | null = null;
  if (point) {
    const [lat, lng, label] = point.split(",");
    pointDoc = {
      propertyId: `point:${label ?? `${lat},${lng}`}`,
      name: label ?? "Punto de prueba",
      type: "hotel",
      address: { city: label ?? "", lat: Number(lat), lng: Number(lng) },
    };
  }

  const store = flag("persist")
    ? (await import("../modules/tourism/tourismDossier.model")).mongoDossierStore
    : createMemoryDossierStore();
  const deps: DossierDeps = {
    store,
    loadProperty: pointDoc ? async () => pointDoc : loadPropertyDoc,
    geocode: geocodeAddress,
    collectors: createCollectors({ onRaw: dumpLabel ? (name, payload) => { raws[name] = payload; } : undefined }),
    now: () => new Date(),
  };
  const propertyId = pointDoc?.propertyId ?? (positional as string);
  const hubs = hubsForFacets(facets);
  console.log(`${flag("persist") ? "⚠ PERSISTE en tourism_dossiers" : "Store en memoria (no escribe nada)"} · facetas: ${facets.join(", ")} · hubs: ${hubs.join(", ")}`);

  const t0 = Date.now();
  const first = await getDossier({ propertyId, hubs, budgetMs, fresh: flag("fresh") }, deps);
  printResult(`1. LO QUE VE EL USUARIO (presupuesto ${budgetMs} ms)`, first);
  if (!first.ok) {
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
  for (const facet of facets) {
    const card = buildCard(first.dossier, [facet]);
    console.log(`\n  Tarjeta [${facet}] "${card.title}" · confianza ${card.confidence}${card.alert ? ` · ⚠ ${card.alert.text}` : ""}`);
    for (const m of card.metrics) {
      console.log(`    ${m.label.padEnd(38)} ${m.value.padEnd(22)} ${m.confidence.padEnd(8)} ${m.hint ?? ""}`);
    }
    if (card.missing.length) console.log(`    faltó: ${card.missing.join("; ")}`);
  }

  // Lo que queda leyéndose en segundo plano.
  await waitForDossierFlights(propertyId);
  const second = await getDossier({ propertyId, hubs, budgetMs: 0 }, deps);
  printResult(`2. LA PREGUNTA SIGUIENTE (tras las escrituras tardías, ${Date.now() - t0} ms en total)`, second);
  if (!second.ok) return;

  box("3. BLOQUE PARA EL MODELO");
  const block = renderTourismBlock(second.dossier, facets, { level: "basico" });
  console.log(`${tokens(block)} tokens (${block.length} caracteres)`);
  if (flag("print")) console.log(`\n${block}`);
  else console.log("(--print para verlo completo)");

  if (dumpLabel) {
    const dir = path.join(__dirname, "fixtures", "tourism", dumpLabel);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, payload] of Object.entries(raws)) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(payload, null, 2));
    }
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify(
        { lat: second.dossier.location.lat, lng: second.dossier.location.lng, name: second.dossier.property.name, capturedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(`\nFixtures: ${Object.keys(raws).join(", ")} → ${path.relative(process.cwd(), dir)}`);
  }

  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
