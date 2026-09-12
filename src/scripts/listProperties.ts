/**
 * Lista propiedades reales del PMS, para tener con qué correr los smokes.
 * Sólo lectura.
 *
 *   npm run list:properties
 */
import "dotenv/config";
import mongoose from "mongoose";
import { getPmsConnection } from "../shared/pmsDb";
import { Schema } from "mongoose";

async function main() {
  const conn = await getPmsConnection();
  const Property = conn.model(
    "SmokeProperty",
    new Schema({}, { strict: false, collection: "properties" }),
  );
  const props = await Property.find(
    {},
    { propertyId: 1, companyId: 1, name: 1, type: 1, status: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  console.log(`${props.length} propiedades (las más recientes):\n`);
  for (const p of props as any[]) {
    console.log(
      `${p.propertyId}\n  ${p.name ?? "(sin nombre)"} · ${p.type ?? "?"} · ${p.status ?? "?"}\n  company: ${p.companyId}\n`,
    );
  }

  const User = conn.model(
    "SmokeUser",
    new Schema({}, { strict: false, collection: "users" }),
  );
  const users = await User.find(
    { status: "active" },
    { userId: 1, email: 1, role: 1, activeCompanyId: 1 },
  )
    .limit(8)
    .lean();
  console.log("Usuarios activos:\n");
  for (const u of users as any[]) {
    console.log(`${u.userId}  ${u.email ?? ""} (${u.role ?? "?"}) company=${u.activeCompanyId ?? "-"}`);
  }

  await conn.close();
  await mongoose.disconnect().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
