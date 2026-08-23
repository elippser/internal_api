import { Schema, model, type InferSchemaType } from "mongoose";

export const CONTRACT_STATUSES = [
  "draft",
  "active",
  "suspended",
  "archived",
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * Catalogo de apps/productos del full system. Por ahora el contrato solo guarda
 * que esta habilitado (sin enforcement real de acceso a las apps todavia — eso
 * es Fase 2). La categoria IA se modela aparte (creditos), no como app.
 */
export const APP_CATALOG = [
  { key: "pms", label: "PMS Core" },
  { key: "rooms", label: "Habitaciones" },
  { key: "bookings", label: "Reservas" },
  { key: "engine", label: "Motor de reservas" },
  { key: "builder", label: "Editor web (sitios)" },
  { key: "analytics", label: "Analytics" },
] as const;

export type AppKey = (typeof APP_CATALOG)[number]["key"];

const appItemSchema = new Schema(
  {
    key: { type: String, required: true },
    enabled: { type: Boolean, default: false },
  },
  { _id: false },
);

// Categoria IA del contrato: bolsa de creditos (tokens) MENSUAL compartida por
// todos los agentes de la company (editor + bookfer IA). credito === token.
const iaSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    // Creditos (tokens) por periodo mensual. 0 = sin creditos (bloquea).
    monthlyCredits: { type: Number, default: 0, min: 0 },
    // Dia del mes (UTC) en que se reinicia la bolsa. 1 = mes calendario.
    resetDayUTC: { type: Number, default: 1, min: 1, max: 28 },
  },
  { _id: false },
);

const contractSchema = new Schema(
  {
    contractId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },

    // Companies a las que aplica el contrato. Cada una tiene su PROPIA bolsa de
    // creditos (la asignacion `ia.monthlyCredits` es por company, no compartida
    // entre companies). Vacio = contrato sin asociar todavia.
    companyIds: { type: [String], default: [], index: true },

    // Contrato GLOBAL: aplica a TODAS las companies que no tengan un contrato
    // propio. Un contrato especifico (companyIds) siempre gana sobre el global.
    // Solo puede haber UN contrato global activo a la vez.
    appliesToAll: { type: Boolean, default: false, index: true },

    status: {
      type: String,
      enum: CONTRACT_STATUSES,
      default: "draft",
      index: true,
    },

    ia: { type: iaSchema, default: () => ({}) },
    apps: { type: [appItemSchema], default: [] },

    createdByUserId: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "contracts" },
);

// A lo sumo UN contrato activo por company. Indice unico multikey parcial:
// entre los contratos active, cada companyId aparece en uno solo (un array
// vacio no aporta claves, asi que no colisiona).
contractSchema.index(
  { companyIds: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
  },
);

export type ContractDoc = InferSchemaType<typeof contractSchema>;
export const Contract = model("Contract", contractSchema);

export function sanitizeContract(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

// Inicializa el array de apps desde el catalogo (todas deshabilitadas).
export function defaultApps(): { key: string; enabled: boolean }[] {
  return APP_CATALOG.map((a) => ({ key: a.key, enabled: false }));
}
