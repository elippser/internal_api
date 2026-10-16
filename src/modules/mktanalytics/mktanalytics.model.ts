import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Eventos del sitio de marca (roombir.com, `public-side/mkt-renderer`).
 *
 * Colección propia y no `analytics_events`: aquella es de comportamiento DENTRO
 * de la plataforma, exige `companyId` (descarta lo que no lo trae) y alimenta
 * los rollups por hotel. Un visitante del sitio de marca todavía no es de
 * ninguna compañía, y mezclarlo ensuciaría esos tableros.
 *
 * Nada identificable: `vid` es un id anónimo de navegador y `sid` el de la
 * sesión (30 min de inactividad). No se guarda IP ni lo que la persona escribe
 * en los formularios: sólo QUÉ campo tocó, nunca su valor.
 */

const utmSchema = new Schema(
  {
    source: String,
    medium: String,
    campaign: String,
    term: String,
    content: String,
  },
  { _id: false },
);

const mktSiteEventSchema = new Schema(
  {
    /** page_view, page_leave, click, form_*, video_*. Ver MKT_EVENT_TYPES. */
    t: { type: String, required: true },
    vid: { type: String, required: true },
    sid: { type: String, required: true },
    /** Fecha del navegador (orden dentro de la sesión). */
    ts: { type: Date, required: true },
    /** Fecha del servidor: eje de todos los rangos del tablero. */
    at: { type: Date, required: true, default: () => new Date() },
    /** Ruta pública tal como se vio (`/en/platform/ai`). */
    path: { type: String, required: true },
    /** Clave de ruta, igual en los 5 idiomas (`producto-ia`). */
    route: { type: String, default: null },
    locale: { type: String, default: null },
    /** Atribución de la SESIÓN (la de su primera página), no del evento. */
    channel: { type: String, default: "direct" },
    refHost: { type: String, default: null },
    utm: { type: utmSchema, default: undefined },
    landing: { type: String, default: null },
    /** Primera visita de este navegador (la sesión que lo trajo). */
    newVisitor: { type: Boolean, default: false },
    country: { type: String, default: null },
    /** Provincia o estado (DB-IP en el proxy del sitio). Nombre, no código. */
    region: { type: String, default: null },
    device: { type: String, default: null },
    browser: { type: String, default: null },
    os: { type: String, default: null },
    /** Lo propio de cada tipo (target del clic, campos del formulario…). */
    data: { type: Schema.Types.Mixed, default: undefined },
  },
  { collection: "mkt_site_events", versionKey: false },
);

mktSiteEventSchema.index({ t: 1, at: -1 });
mktSiteEventSchema.index({ sid: 1, ts: 1 });
// 25 meses: alcanza para comparar un mes contra el mismo del año anterior.
mktSiteEventSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 760 });

export type MktSiteEventDoc = InferSchemaType<typeof mktSiteEventSchema>;
export const MktSiteEvent = model("MktSiteEvent", mktSiteEventSchema);
