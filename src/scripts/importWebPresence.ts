import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Prospect, WEB_PRESENCE, type WebPresence } from "../modules/prospects/prospects.model";

/**
 * Carga la revisión de presencia web de los prospectos (Prospectos › Presencia
 * web). La revisión se hace afuera —abrir la web de la ficha o la de la bio de
 * Instagram y buscar el motor de reservas— y deja un JSON con una fila por
 * prospecto:
 *
 *   [{ prospectId, status, detail?, url?, engine?, via?, checkedAt? }]
 *
 * `status` es uno de WEB_PRESENCE. Pisa la revisión anterior de cada prospecto
 * que viene en el archivo y no toca los demás. Idempotente.
 *
 * Uso: npm run import:web-presence -- <archivo.json> [--dry]
 */

interface Row {
  prospectId: string;
  status: WebPresence;
  detail?: string;
  url?: string;
  engine?: string;
  via?: string;
  checkedAt?: string;
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes("--dry");
  if (!file) throw new Error("Falta el archivo: npm run import:web-presence -- <archivo.json>");
  const rows = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Row[];

  const invalid = rows.filter((r) => !r.prospectId || !WEB_PRESENCE.includes(r.status));
  if (invalid.length) throw new Error(`${invalid.length} filas sin prospectId o con status invalido`);

  await connectDB();
  let updated = 0;
  let missing = 0;
  for (const r of rows) {
    const webPresence = {
      status: r.status,
      detail: r.detail ?? "",
      ...(r.url ? { url: r.url } : {}),
      ...(r.engine ? { engine: r.engine } : {}),
      ...(r.via ? { via: r.via } : {}),
      checkedAt: r.checkedAt ? new Date(r.checkedAt) : new Date(),
    };
    if (dry) {
      if (!(await Prospect.exists({ prospectId: r.prospectId }))) missing++;
      continue;
    }
    const res = await Prospect.updateOne({ prospectId: r.prospectId }, { $set: { webPresence } });
    if (res.matchedCount) updated++;
    else missing++;
  }
  const byStatus: Record<string, number> = {};
  rows.forEach((r) => (byStatus[r.status] = (byStatus[r.status] ?? 0) + 1));
  console.log(JSON.stringify({ dry, rows: rows.length, updated, missing, byStatus }));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
