import { Schema, model, type InferSchemaType } from "mongoose";

export const SIGNAL_TYPES = [
  "flight_volume",
  "event",
  "fx_rate",
  "holiday",
  "weather",
  "search_trend",
  "school_holiday",
  "venue",
  "flight_price",
  "str_supply",
  "health_alert",
  "lodging",
] as const;

const geoSchema = new Schema(
  {
    lat: { type: Number },
    lng: { type: Number },
    airportCode: { type: String },
    countryCode: { type: String },
    city: { type: String },
  },
  { _id: false },
);

const signalSchema = new Schema(
  {
    // Sin `index: true` en estos tres, a proposito. La coleccion pasa las
    // 170k señales y sus indices llegaron a pesar MAS que los datos (111MB de
    // indices sobre 113MB de documentos). Los tres que estaban aca no aportaban
    // nada: `signalId` no se consulta en ningun lado del codigo, y `type` y
    // `source` sueltos son prefijo de los compuestos declarados mas abajo, que
    // ya sirven esas consultas. Volver a agregarlos cuesta ~44MB.
    signalId: { type: String, required: true }, // uuid v4 del connector
    type: { type: String, enum: SIGNAL_TYPES, required: true },
    source: { type: String, required: true },
    scope: {
      geo: { type: geoSchema, default: () => ({}) },
      radiusKm: { type: Number },
    },
    timeWindow: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },
    magnitude: { type: Number, required: true, min: 0, max: 1 },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    rawPayload: { type: Schema.Types.Mixed, default: {} },
    ingestedAt: { type: Date, required: true },
    // Upsert determinístico: re-correr un cron actualiza la señal existente
    // en vez de duplicarla (ej. refresh mensual de feriados, weather diario).
    dedupeKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, collection: "ih_signals" },
);

signalSchema.index({ type: 1, "timeWindow.start": 1 });
signalSchema.index({ type: 1, "scope.geo.airportCode": 1, "timeWindow.start": -1 });
signalSchema.index({ type: 1, "scope.geo.countryCode": 1, "timeWindow.start": -1 });
signalSchema.index({ source: 1, ingestedAt: -1 });

// Poda automatica. La coleccion no tenia TTL ni purga alguna y el cron de
// `events` corre diario y COMPLETO, asi que solo acumulaba: 174k señales /
// 184 MB en cuatro semanas de cluster nuevo, el 90% de un M0. Con esto una
// señal se borra sola `SIGNAL_TTL_DAYS` despues de que termino su ventana.
// Mongo compara `timeWindow.end` contra ahora, no contra `ingestedAt`: las
// señales de ventana futura (el caso normal) no expiran nunca, y las de
// eventos ya pasados — el 43% del volumen — se van solas.
// El TTL tiene que ser indice de UN campo, por eso no se cuelga de los
// compuestos de arriba.
const SIGNAL_TTL_DAYS = Number(process.env.IH_SIGNAL_TTL_DAYS || 90);
signalSchema.index({ "timeWindow.end": 1 }, { expireAfterSeconds: SIGNAL_TTL_DAYS * 86400 });

export type SignalDoc = InferSchemaType<typeof signalSchema>;
export const SignalModel = model("IhSignal", signalSchema);

// Registro de corridas por connector, alimenta GET /intelligence/health.
const connectorRunSchema = new Schema(
  {
    connector: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    ok: { type: Boolean, required: true },
    signalCount: { type: Number, default: 0 },
    upserted: { type: Number, default: 0 },
    error: { type: String },
    meta: { type: Schema.Types.Mixed },
    trigger: { type: String, enum: ["cron", "manual", "startup"], default: "cron" },
  },
  { timestamps: true, collection: "ih_connector_runs" },
);

connectorRunSchema.index({ connector: 1, startedAt: -1 });

// `getHealth` solo lee la ULTIMA corrida de cada connector y el cron mas lento
// es mensual (venues, lodging, str-supply), asi que 90 dias dejan margen de
// sobra. Sin esto los logs tambien crecian sin techo (3.540 docs / 4,3 MB).
connectorRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 86400 });

export type ConnectorRunDoc = InferSchemaType<typeof connectorRunSchema>;
export const ConnectorRunModel = model("IhConnectorRun", connectorRunSchema);

// Puntos de barrido registrados por servicios de la plataforma (el RMS por
// property): la cobertura de eventos deja de depender del catálogo de ciudades.
const watchpointSchema = new Schema(
  {
    pointId: { type: String, required: true, unique: true },
    label: { type: String, required: true }, // nombre de la ciudad (matching de deportes)
    countryCode: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    radiusKm: { type: Number, default: 30 },
    source: { type: String, default: "rms" },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "ih_watchpoints" },
);

export type WatchpointDoc = InferSchemaType<typeof watchpointSchema>;
export const WatchpointModel = model("IhWatchpoint", watchpointSchema);

export function sanitizeSignal(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}
