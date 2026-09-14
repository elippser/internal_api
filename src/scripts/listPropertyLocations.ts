/**
 * Qué propiedades pueden mostrar el estado turístico: coordenadas cargadas,
 * dirección para geocodificar, o nada. Sólo lectura.
 *
 *   npx ts-node --transpile-only src/scripts/listPropertyLocations.ts
 */
import "dotenv/config";
import mongoose, { Schema } from "mongoose";
import { getPmsConnection } from "../shared/pmsDb";
import { coordsFromAddress, type PropertyDoc } from "../modules/tourism/location";

async function main() {
  const conn = await getPmsConnection();
  const Property = conn.model("LocationProperty", new Schema({}, { strict: false, collection: "properties" }));
  const props = (await Property.find(
    {},
    { propertyId: 1, companyId: 1, name: 1, type: 1, status: 1, address: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1 })
    .limit(25)
    .lean()) as unknown as Array<PropertyDoc & { status?: string }>;

  for (const p of props) {
    const a = p.address ?? {};
    const coords = coordsFromAddress(a);
    const street = a.addressLine1 || a.street;
    const where = coords
      ? `coordenadas ${coords.lat}, ${coords.lng}`
      : street && a.city
        ? `sin coordenadas · se geocodifica "${street}, ${a.city}"`
        : a.city
          ? `sin coordenadas · sólo ciudad "${a.city}" (sin entorno a pie)`
          : "SIN UBICACIÓN: no va a haber tarjeta";
    console.log(`${p.propertyId}  ${p.name ?? "(sin nombre)"} · ${p.status ?? "?"}\n  company ${p.companyId} · ${where}\n`);
  }
  await conn.close();
  await mongoose.disconnect().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
