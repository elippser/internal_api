import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Segmentos = queries guardadas, no listas materializadas. Se resuelven contra
 * `mkt_accounts` en el momento en que alguien los pide, asi que nunca quedan
 * viejos (una lista estatica envejece al dia siguiente).
 */

export const SEGMENT_FIELDS = [
  "lifecycle",
  "source",
  "tags",
  "country",
  "stats.plan",
  "stats.propertiesCount",
  "stats.unitsCount",
  "stats.reservationsProcessed",
  "stats.iaCreditsUsed",
  "stats.daysInactive",
  "stats.mrr",
] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const SEGMENT_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "lt",
  "gte",
  "lte",
  "in",
  "not_in",
  "exists",
] as const;
export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number];

const ruleSchema = new Schema(
  {
    field: { type: String, enum: SEGMENT_FIELDS, required: true },
    operator: { type: String, enum: SEGMENT_OPERATORS, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const segmentSchema = new Schema(
  {
    segmentId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    rules: { type: [ruleSchema], default: [] },
    /** `all` = AND entre reglas, `any` = OR. */
    match: { type: String, enum: ["all", "any"], default: "all" },
    /** Los del seed no se pueden borrar: son la base del tablero. */
    isSystem: { type: Boolean, default: false },
    createdByUserId: { type: String, default: "system" },
  },
  { timestamps: true, collection: "mkt_segments" },
);

export type MktSegmentDoc = InferSchemaType<typeof segmentSchema>;
export const MktSegment = model("MktSegment", segmentSchema);

/**
 * Traduce las reglas a un filtro de Mongo.
 *
 * `daysInactive` con `gt` incluye a proposito las cuentas SIN actividad
 * registrada: una cuenta que nunca consumio nada es el caso mas inactivo que
 * hay, y dejarla afuera del segmento de riesgo la volveria invisible.
 */
export function buildSegmentQuery(
  rules: { field: string; operator: string; value: unknown }[],
  match: "all" | "any" = "all",
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const { field, operator, value } = rule;
    let clause: Record<string, unknown>;

    switch (operator) {
      case "eq":
        clause = { [field]: value };
        break;
      case "ne":
        clause = { [field]: { $ne: value } };
        break;
      case "gt":
        clause = { [field]: { $gt: value } };
        break;
      case "lt":
        clause = { [field]: { $lt: value } };
        break;
      case "gte":
        clause = { [field]: { $gte: value } };
        break;
      case "lte":
        clause = { [field]: { $lte: value } };
        break;
      case "in":
        clause = { [field]: { $in: Array.isArray(value) ? value : [value] } };
        break;
      case "not_in":
        clause = { [field]: { $nin: Array.isArray(value) ? value : [value] } };
        break;
      case "exists":
        clause = { [field]: { $exists: Boolean(value) } };
        break;
      default:
        continue;
    }

    if (field === "stats.daysInactive" && (operator === "gt" || operator === "gte")) {
      clause = { $or: [clause, { "stats.daysInactive": { $exists: false } }] };
    }

    clauses.push(clause);
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1 && match === "all") return clauses[0];
  return match === "any" ? { $or: clauses } : { $and: clauses };
}

/** Segmentos que se crean solos la primera vez que arranca el modulo. */
export const SYSTEM_SEGMENTS: {
  name: string;
  description: string;
  match: "all" | "any";
  rules: { field: SegmentField; operator: SegmentOperator; value: unknown }[];
}[] = [
  {
    name: "Nuevos leads",
    description: "Todavia no los contacto nadie.",
    match: "all",
    rules: [{ field: "lifecycle", operator: "eq", value: "lead" }],
  },
  {
    name: "En trial",
    description: "Probando el producto ahora mismo.",
    match: "all",
    rules: [{ field: "lifecycle", operator: "eq", value: "trial" }],
  },
  {
    name: "Clientes activos",
    description: "Pagando y con actividad en los ultimos 30 dias.",
    match: "all",
    rules: [
      { field: "lifecycle", operator: "eq", value: "customer" },
      { field: "stats.daysInactive", operator: "lte", value: 30 },
    ],
  },
  {
    name: "Riesgo de churn",
    description: "Clientes sin actividad hace mas de 30 dias.",
    match: "all",
    rules: [
      { field: "lifecycle", operator: "eq", value: "customer" },
      { field: "stats.daysInactive", operator: "gt", value: 30 },
    ],
  },
  {
    name: "Alto consumo de IA",
    description: "Mas de un millon de tokens: candidatos a plan superior.",
    match: "all",
    rules: [{ field: "stats.iaCreditsUsed", operator: "gt", value: 1_000_000 }],
  },
  {
    name: "Sin propiedades cargadas",
    description: "Se dieron de alta pero nunca cargaron nada. Onboarding trabado.",
    match: "all",
    rules: [{ field: "stats.propertiesCount", operator: "eq", value: 0 }],
  },
];
