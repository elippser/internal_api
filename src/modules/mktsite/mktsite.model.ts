import { Schema, model, type InferSchemaType } from "mongoose";

const seoSchema = new Schema(
  {
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    ogImage: { type: String, default: "" },
    noindex: { type: Boolean, default: false },
  },
  { _id: false },
);

const pixelsSchema = new Schema(
  {
    metaPixelId: { type: String, default: "" },
    /** Token de la Conversions API. Server-side, nunca se manda al navegador. */
    metaCapiToken: { type: String, default: "" },
    googleAdsConversionId: { type: String, default: "" },
    googleAdsConversionLabel: { type: String, default: "" },
    ga4MeasurementId: { type: String, default: "" },
    gtmContainerId: { type: String, default: "" },
  },
  { _id: false },
);

const siteSchema = new Schema(
  {
    siteId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    /** Sirve el sitio en /s/:slug */
    slug: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    defaultLanguage: { type: String, default: "es" },
    favicon: { type: String, default: "" },

    seo: { type: seoSchema, default: () => ({}) },
    pixels: { type: pixelsSchema, default: () => ({}) },

    /** HTML libre que se inyecta tal cual. Solo lo edita gente developer+. */
    headHtml: { type: String, default: "" },
    bodyEndHtml: { type: String, default: "" },

    createdByUserId: { type: String, default: "system" },
  },
  { timestamps: true, collection: "mkt_sites" },
);

export type MktSiteDoc = InferSchemaType<typeof siteSchema>;
export const MktSite = model("MktSite", siteSchema);

const pageSchema = new Schema(
  {
    pageId: { type: String, required: true, unique: true, index: true },
    siteId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    /** Siempre con barra inicial. La home es "/". */
    path: { type: String, required: true },
    status: { type: String, enum: ["draft", "published"], default: "draft" },

    /** Las tres pestañas del editor. `html` es solo el cuerpo, sin <html>/<head>. */
    html: { type: String, default: "" },
    css: { type: String, default: "" },
    js: { type: String, default: "" },

    seo: { type: seoSchema, default: () => ({}) },

    /**
     * Snapshot que se sirve al publico. Separar borrador de publicado permite
     * editar sin que el sitio en vivo cambie a media edicion.
     */
    publishedHtml: { type: String, required: false },
    publishedCss: { type: String, required: false },
    publishedJs: { type: String, required: false },
    publishedAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_pages" },
);

pageSchema.index({ siteId: 1, path: 1 }, { unique: true });

export type MktPageDoc = InferSchemaType<typeof pageSchema>;
export const MktPage = model("MktPage", pageSchema);

// ---------------------------------------------------------------------------
// Conversiones server-side
// ---------------------------------------------------------------------------

const conversionSchema = new Schema(
  {
    conversionId: { type: String, required: true, unique: true, index: true },
    siteId: { type: String, required: false, index: true },
    accountId: { type: String, required: false, index: true },
    eventName: { type: String, required: true },
    /** Compartido con el pixel del navegador para que Meta deduplique. */
    eventIdShared: { type: String, required: true },
    value: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    /** Solo hashes SHA-256. El dato en claro no se guarda nunca. */
    hashedEmail: { type: String, required: false },
    hashedPhone: { type: String, required: false },
    destinations: { type: [String], default: [] },
    status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
    error: { type: String, required: false },
    sentAt: { type: Date, required: false },
  },
  { timestamps: true, collection: "mkt_conversions" },
);

export type MktConversionDoc = InferSchemaType<typeof conversionSchema>;
export const MktConversion = model("MktConversion", conversionSchema);

export function sanitize<T>(doc: T): T {
  if (!doc) return doc;
  const obj =
    doc && typeof doc === "object" && "toObject" in (doc as object)
      ? (doc as unknown as { toObject: () => Record<string, unknown> }).toObject()
      : (doc as unknown as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}

/**
 * Quita el token de la CAPI antes de responder. Es un secreto de escritura: se
 * carga desde el panel pero no se devuelve nunca, ni siquiera a admin.
 */
export function sanitizeSite(doc: any) {
  const clean = sanitize(doc) as any;
  if (clean?.pixels) {
    clean.pixels = {
      ...clean.pixels,
      metaCapiToken: clean.pixels.metaCapiToken ? "__set__" : "",
    };
  }
  return clean;
}
