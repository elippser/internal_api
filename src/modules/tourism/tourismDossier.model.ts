/**
 * Colección `tourism_dossiers`: un documento por propiedad, un sobre por hub.
 *
 * Por qué Mongo y no la memoria del proceso, como hacen los hubs: en
 * producción el API corre como función serverless y la memoria muere en cada
 * cold start. Sin persistencia, cada pregunta volvería a pagar seis llamadas a
 * Open-Meteo y minutos de Overpass.
 *
 * Sólo dos índices, a propósito: cada índice declarado vuelve solo en cada
 * cold start (autoIndex), y en un M0 pesan más que los datos (pasó en
 * `ih_signals`).
 *
 * Las escrituras van por la colección nativa con `$set` por sobre: dos hubs que
 * terminan a la vez (escrituras tardías) no se pisan entre sí.
 */

import { Schema, model } from "mongoose";
import type { DossierStore, StoredDossier } from "./dossier.service";

/** Un dossier que nadie consulta en 60 días se borra solo. */
export const DOSSIER_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

const dossierSchema = new Schema(
  {
    propertyId: { type: String, required: true },
    property: { type: Schema.Types.Mixed, default: null },
    location: { type: Schema.Types.Mixed, default: null },
    geocode: { type: Schema.Types.Mixed, default: null },
    hubs: { type: Schema.Types.Mixed, default: {} },
    narratives: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "tourism_dossiers", minimize: false },
);

dossierSchema.index({ propertyId: 1 }, { unique: true });
dossierSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TourismDossierModel = model("TourismDossier", dossierSchema);

async function upsert(propertyId: string, set: Record<string, unknown>): Promise<void> {
  const now = new Date();
  const update = {
    $set: { ...set, updatedAt: now, expiresAt: new Date(now.getTime() + DOSSIER_RETENTION_MS) },
    $setOnInsert: { propertyId, createdAt: now },
  };
  try {
    await TourismDossierModel.collection.updateOne({ propertyId }, update, { upsert: true });
  } catch (err) {
    // Dos upserts simultáneos sobre un documento que no existía: uno gana el
    // insert y el otro choca contra el índice único. El segundo intento ya
    // encuentra el documento y actualiza.
    if ((err as { code?: number }).code !== 11000) throw err;
    await TourismDossierModel.collection.updateOne({ propertyId }, update, { upsert: true });
  }
}

export const mongoDossierStore: DossierStore = {
  async load(propertyId) {
    const doc = await TourismDossierModel.collection.findOne(
      { propertyId },
      { projection: { _id: 0 } },
    );
    return (doc as unknown as StoredDossier | null) ?? null;
  },
  async saveBase(propertyId, base) {
    await upsert(propertyId, {
      property: base.property,
      location: base.location,
      geocode: base.geocode,
    });
  },
  async saveHub(propertyId, hub, env) {
    await upsert(propertyId, { [`hubs.${hub}`]: env });
  },
  async clearHubs(propertyId) {
    await upsert(propertyId, { hubs: {}, narratives: null });
  },
  async saveNarratives(propertyId, narratives) {
    await upsert(propertyId, { narratives });
  },
};
