import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Bitacora de cambios de DNS.
 *
 * Cloudflare tiene su propio Audit Log, pero solo en planes pagos y sin el
 * usuario del panel interno: desde su lado todos los cambios salen del mismo
 * token. Aca queda quien lo hizo, con el antes y el despues, que es lo que se
 * necesita cuando un hostname deja de resolver un martes a las 3 AM.
 *
 * Se escribe DESPUES de que Cloudflare confirma: si la API falla no hay fila.
 * Y si falla el guardado, el cambio ya esta hecho igual — se loguea el error y
 * no se revierte, porque revertir a ciegas un DNS es peor que un hueco en la
 * bitacora.
 */
const dnsChangeSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["create", "update", "delete"],
      required: true,
      index: true,
    },
    zoneId: { type: String, required: true },
    zoneName: { type: String, required: true },
    recordId: { type: String, required: true, index: true },
    /** FQDN completo, para poder buscar por hostname. */
    name: { type: String, required: true, index: true },
    type: { type: String, required: true },

    /** Snapshot previo. Vacio en `create`. */
    before: { type: Schema.Types.Mixed, default: null },
    /** Snapshot posterior. Vacio en `delete`. */
    after: { type: Schema.Types.Mixed, default: null },

    /**
     * Se salteo un guardarrail del inventario (poner en naranja un hostname
     * que tiene que ir gris, borrar un registro requerido). Es lo primero que
     * se busca cuando algo se rompe.
     */
    forced: { type: Boolean, default: false },
    /** Que guardarrail se salteo, en texto. */
    forcedReason: { type: String, default: "" },

    actorId: { type: String, required: true },
    actorEmail: { type: String, required: true },
  },
  { timestamps: true, collection: "dns_changelog" },
);

dnsChangeSchema.index({ createdAt: -1 });

export type DnsChange = InferSchemaType<typeof dnsChangeSchema>;

export const DnsChangeModel = model("DnsChange", dnsChangeSchema);
