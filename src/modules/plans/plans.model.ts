import { Schema, model, type InferSchemaType } from "mongoose";
import { PRODUCT_CATEGORIES } from "./productCatalog";

/* ────────────────────────── Productos ────────────────────────── */

export const PRODUCT_STATUSES = ["active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Un producto del full system (Habitaciones, Revenue, Sitios web, Bookfer IA…).
 *
 * Es la pieza que un plan incluye o no. Vive en Mongo y no en una constante
 * de TypeScript a proposito: lanzar un producto nuevo o renombrar uno no
 * deberia pedir un deploy del panel.
 *
 * `key` es el identificador estable (slug). Es lo que viaja en el snapshot del
 * plan que se guarda en la company, asi que no se edita despues del alta: si
 * cambiara, las companies que ya eligieron el plan perderian el producto.
 */
const productSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true, index: true },
    key: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      enum: PRODUCT_CATEGORIES,
      default: "operacion",
      index: true,
    },

    // Apps del catalogo del PMS que este producto habilita. Es la traduccion
    // entre "el plan incluye Revenue" y "este espacio puede abrir `revenue`".
    appIds: { type: [String], default: [] },
    // Prefijos de ruta del PMS que cubre. Los usa el gate del front cuando
    // alguien entra por URL directa en vez de por el menu.
    routes: { type: [String], default: [] },

    icon: { type: String, default: "" },

    // Producto que ningun plan puede dejar afuera (escritorio, ajustes,
    // propiedades). Sin esto un plan mal armado dejaria una cuenta sin poder
    // entrar ni a configurar su empresa.
    core: { type: Boolean, default: false },

    status: {
      type: String,
      enum: PRODUCT_STATUSES,
      default: "active",
      index: true,
    },
    order: { type: Number, default: 100 },

    createdByUserId: { type: String, default: "seed" },
  },
  { timestamps: true, collection: "products" },
);

export type ProductDoc = InferSchemaType<typeof productSchema>;
export const Product = model("Product", productSchema);

/* ──────────────────────────── Planes ─────────────────────────── */

export const PLAN_STATUSES = ["draft", "active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const BILLING_PERIODS = ["monthly", "yearly", "one_time"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

const priceSchema = new Schema(
  {
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD" },
    period: { type: String, enum: BILLING_PERIODS, default: "monthly" },
  },
  { _id: false },
);

// Limites duros del plan. Se copian a la company al elegirlo: el PMS ya tiene
// `planMaxProperties` / `planMaxUsers` en el modelo desde antes, sin nadie que
// los escribiera.
const limitsSchema = new Schema(
  {
    maxProperties: { type: Number, default: null },
    maxUsers: { type: Number, default: null },
    // Creditos (tokens) de Bookfer IA por mes. Es el cupo REAL y el unico:
    // el gate del chat lo lee de aca (planCredits.service). Antes el enforcement
    // vivia en un modulo `contracts` aparte, que se elimino al fusionar los dos
    // conceptos — un plan decia que productos veias y un contrato si tenias IA,
    // y se desincronizaban solos.
    iaMonthlyCredits: { type: Number, default: null },
    // Dia del mes (UTC) en que se renueva el cupo. 1 = mes calendario. Se topea
    // en 28 para que todos los meses tengan ese dia.
    iaResetDayUTC: { type: Number, default: 1, min: 1, max: 28 },
  },
  { _id: false },
);

const planSchema = new Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    // Una linea de venta ("Para empezar a recibir reservas online").
    tagline: { type: String, default: "" },
    description: { type: String, default: "" },

    // Los productos incluidos, por `key`. Se guardan por key y no por id para
    // que el snapshot que viaja a la company siga siendo legible.
    productKeys: { type: [String], default: [] },

    price: { type: priceSchema, default: () => ({}) },

    // Plan gratuito. Siempre acotado en el tiempo: `freeDurationDays` es el
    // limite a partir del alta, cumplido el cual la cuenta queda vencida y
    // tiene que elegir otro plan. `null` no se acepta en la validacion para
    // los planes gratis — un "gratis para siempre" no es un plan, es un hueco
    // de facturacion.
    free: { type: Boolean, default: false },
    freeDurationDays: { type: Number, default: null, min: 1 },

    // Prueba gratis de un plan pago. 0 = sin prueba.
    trialDays: { type: Number, default: 0, min: 0 },

    limits: { type: limitsSchema, default: () => ({}) },

    status: { type: String, enum: PLAN_STATUSES, default: "draft", index: true },

    // Se ofrece en la pantalla de eleccion del alta. Un plan puede estar
    // `active` y no ser publico: planes a medida que se asignan a mano.
    public: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 100 },
    highlighted: { type: Boolean, default: false },

    createdByUserId: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "plans" },
);

export type PlanDoc = InferSchemaType<typeof planSchema>;
export const Plan = model("Plan", planSchema);

/* ─────────────────────────── Helpers ─────────────────────────── */

export function sanitize<T>(doc: T): Record<string, unknown> {
  if (!doc) return doc as never;
  const obj = (doc as any).toObject ? (doc as any).toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest;
}

/** Slug a partir del nombre: minusculas, sin acentos, guiones. */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ─────────────── Contenido de la pantalla /planes ─────────────── */

/**
 * Los textos de la pantalla de eleccion de plan del PMS, por idioma.
 *
 * Documento unico (`key: "plan_selection"`): no es una coleccion de filas sino
 * la copia de UNA pantalla, y modelarlo como singleton evita tener que decidir
 * cual de varios documentos manda.
 *
 * `locales` es un mapa suelto (`Schema.Types.Mixed`) a proposito: los campos
 * los define `planPageFields.ts` y agregar uno no deberia pedir una migracion
 * del schema. Un campo vacio o ausente significa "usa el texto por defecto del
 * PMS", asi que un documento a medio cargar nunca deja huecos en pantalla.
 */
const planPageContentSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: "plan_selection",
    },
    locales: { type: Schema.Types.Mixed, default: () => ({}) },
    updatedByUserId: { type: String, default: "" },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "plan_page_content" },
);

export type PlanPageContentDoc = InferSchemaType<typeof planPageContentSchema>;
export const PlanPageContent = model("PlanPageContent", planPageContentSchema);
