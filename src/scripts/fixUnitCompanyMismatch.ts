/* eslint-disable @typescript-eslint/no-explicit-any */
// La propiedad es la fuente de verdad del owner. Algunos units/categorias estan
// stampeados con un companyId distinto al de SU propiedad → rooms-app los filtra
// por (propertyId + companyId) y quedan INVISIBLES ("0 habitaciones" aunque
// existan). Este script detecta y (con APPLY=1) re-stampa companyId = el de la
// property. DRY-RUN por defecto.
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.env.APPLY === "1";
const COLLECTIONS = ["units", "categories", "unitstatehistories"];

async function main() {
  const conn = await mongoose.createConnection(process.env.PMS_MONGODB_URI!).asPromise();
  const db = conn.db!;
  console.log(`DB=${conn.name}  modo=${APPLY ? "APPLY (escribe)" : "DRY-RUN"}\n`);

  // propertyId -> companyId (fuente de verdad)
  const props = await db.collection("properties").find({}, { projection: { propertyId: 1, companyId: 1, name: 1 } }).toArray();
  const propCompany = new Map<string, string>();
  const propName = new Map<string, string>();
  for (const p of props) {
    if (p.propertyId && p.companyId) propCompany.set(p.propertyId, p.companyId);
    if (p.propertyId) propName.set(p.propertyId, p.name);
  }
  console.log(`properties: ${propCompany.size} con companyId\n`);

  let grandTotal = 0;
  for (const col of COLLECTIONS) {
    const exists = (await db.listCollections({ name: col }).toArray()).length > 0;
    if (!exists) { console.log(`[${col}] no existe, skip`); continue; }

    const docs = await db.collection(col).find({}, { projection: { _id: 1, propertyId: 1, companyId: 1 } }).toArray();
    const mismatches: any[] = [];
    let orphanProp = 0;
    for (const d of docs) {
      const truth = d.propertyId ? propCompany.get(d.propertyId) : undefined;
      if (!truth) { if (d.propertyId && !propCompany.has(d.propertyId)) orphanProp++; continue; }
      if (d.companyId !== truth) mismatches.push({ _id: d._id, propertyId: d.propertyId, from: d.companyId, to: truth });
    }

    console.log(`[${col}] total=${docs.length}  mismatch=${mismatches.length}  (property inexistente=${orphanProp})`);
    // Agrupar por propiedad
    const byProp = new Map<string, { from: string; to: string; n: number }>();
    for (const m of mismatches) {
      const k = m.propertyId;
      const e = byProp.get(k) ?? { from: m.from, to: m.to, n: 0 };
      e.n++; byProp.set(k, e);
    }
    for (const [pid, e] of byProp) {
      console.log(`   · ${propName.get(pid) ?? "?"} (${pid.slice(0, 18)}…): ${e.n} docs  ${String(e.from).slice(0, 16)}… → ${String(e.to).slice(0, 16)}…`);
    }

    if (APPLY && mismatches.length) {
      const ops = mismatches.map((m) => ({
        updateOne: { filter: { _id: m._id }, update: { $set: { companyId: m.to } } },
      }));
      const r = await db.collection(col).bulkWrite(ops);
      console.log(`   ✓ APPLY: ${r.modifiedCount} docs actualizados`);
    }
    grandTotal += mismatches.length;
    console.log("");
  }

  console.log(`TOTAL mismatch: ${grandTotal}${APPLY ? " (aplicado)" : " (dry-run, corre con APPLY=1 para fijar)"}`);
  await conn.close();
  process.exit(0);
}

main().catch((e) => { console.error("error:", e); process.exit(1); });
