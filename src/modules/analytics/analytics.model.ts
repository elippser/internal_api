import { Schema, model, type InferSchemaType } from "mongoose";

const analyticsEventSchema = new Schema(
  {
    eventName: { type: String, required: true, index: true },
    category: { type: String, required: true },
    source: { type: String, required: true },
    companyId: { type: String, required: true, index: true },
    propertyId: { type: String, default: null, index: true },
    userId: { type: String, default: null },
    sessionId: { type: String, required: true },
    userRole: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    clientTimestamp: { type: Date, required: true },
    serverTimestamp: { type: Date, required: true, default: () => new Date() },
    /**
     * Idempotencia de la ingesta (`<source>:<sessionId>:<n>`). Los SDKs
     * bufferizan y reintentan con `sendBeacon`, así que el mismo evento puede
     * llegar más de una vez; el índice unique lo colapsa. Opcional: los
     * emisores server-side que no reintentan pueden omitirlo.
     */
    correlationId: { type: String, default: null },
  },
  { collection: "analytics_events", versionKey: false },
);

// Indices compuestos para queries de dashboard
analyticsEventSchema.index({ companyId: 1, eventName: 1, serverTimestamp: -1 });
analyticsEventSchema.index({ eventName: 1, serverTimestamp: -1 });
// Funnel por sesión: los pasos de una misma sesión se agrupan sin escanear.
analyticsEventSchema.index({ sessionId: 1, eventName: 1 });
// Timeline "qué hizo adentro" de una persona (`/access/users/:id/actions`).
// `userId` no estaba indexado y ningún índice existente arranca por él, así que
// esa query escaneaba la colección entera para devolver 100 filas.
analyticsEventSchema.index({ userId: 1, serverTimestamp: -1 });
// Idempotencia. Sparse: la mayoría de los eventos server-side no lo mandan.
analyticsEventSchema.index(
  { correlationId: 1 },
  { unique: true, sparse: true },
);
// TTL: 1 año
analyticsEventSchema.index(
  { serverTimestamp: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 },
);

export type AnalyticsEventDoc = InferSchemaType<typeof analyticsEventSchema>;
export const AnalyticsEvent = model("AnalyticsEvent", analyticsEventSchema);
