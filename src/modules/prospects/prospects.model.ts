import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Prospectos: la lista de alojamientos a los que hay que LLAMAR para ofrecerles
 * bookfer. Es el paso previo al CRM (`mkt_accounts`): mientras no haya
 * conversacion no hay cuenta, y no tiene sentido ensuciar el embudo comercial
 * con cientos de perfiles de Instagram que nadie llamo todavia.
 *
 * Cuando un prospecto se gana se convierte en cuenta del CRM
 * (`POST /prospects/:id/convert`) y queda el puente en `accountId`. La lista de
 * llamadas y el embudo de cuentas siguen siendo dos cosas distintas a proposito.
 *
 * Los enums van en ingles (como en `crm.model` y `competitors.model`); los
 * labels en espanol viven en el front (`web/src/modules/prospects/types.ts`).
 */

// ---------------------------------------------------------------------------
// Catalogos
// ---------------------------------------------------------------------------

/**
 * Etapa del prospecto. El orden de la constante ES el orden del embudo, y de
 * ahi salen las columnas del tablero.
 *
 *   new         nunca se lo llamo
 *   attempting  se intento y no atendio (o quedo reagendado)
 *   contacted   hubo conversacion real, todavia sin postura
 *   interested  mostro interes concreto
 *   demo        demo agendada o hecha
 *   proposal    propuesta / precio enviado
 *   won         cerro -> se convierte en cuenta del CRM
 *
 * Terminales negativos (fuera del embudo, por eso van al final):
 *   lost          dijo que no despues de hablar
 *   disqualified  no es cliente posible (no es alojamiento, cerro, etc.)
 *   unreachable   la data no sirve: sin telefono util o numero equivocado
 */
export const PROSPECT_STATUSES = [
  "new",
  "attempting",
  "contacted",
  "interested",
  "demo",
  "proposal",
  "won",
  "lost",
  "disqualified",
  "unreachable",
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** Las etapas que siguen vivas, en orden de avance. */
export const PIPELINE_STATUSES: ProspectStatus[] = [
  "new",
  "attempting",
  "contacted",
  "interested",
  "demo",
  "proposal",
  "won",
];

/**
 * Resultado agregado. Es lo que responde "cuantos fueron exito y cuantos
 * fracaso" sin tener que sumar etapas a mano en cada pantalla.
 */
export const PROSPECT_OUTCOMES = ["open", "won", "lost"] as const;
export type ProspectOutcome = (typeof PROSPECT_OUTCOMES)[number];

export function outcomeOf(status: ProspectStatus): ProspectOutcome {
  if (status === "won") return "won";
  if (status === "lost" || status === "disqualified" || status === "unreachable") {
    return "lost";
  }
  return "open";
}

/** Se considera "alcanzado" a partir de que hubo conversacion real. */
export function isReached(status: ProspectStatus): boolean {
  return (
    status === "contacted" ||
    status === "interested" ||
    status === "demo" ||
    status === "proposal" ||
    status === "won" ||
    status === "lost"
  );
}

export const LOST_REASONS = [
  "price",
  "has_pms",
  "no_interest",
  "no_answer",
  "too_small",
  "seasonal_closed",
  "closed_business",
  "bad_data",
  "not_lodging",
  "competitor",
  "other",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const PROSPECT_SOURCES = [
  "instagram_saved",
  "manual",
  "import",
  "referral",
  "web",
  "inbound",
  "other",
] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

export const LODGING_TYPES = [
  "hotel",
  "apart_hotel",
  "resort",
  "lodge",
  "inn_bnb",
  "cabins",
  "apartment",
  "house",
  "country_house",
  "glamping",
  "villas",
  "hostel",
  "camping",
  "other",
] as const;
export type LodgingType = (typeof LODGING_TYPES)[number];

export const PROSPECT_PRIORITIES = ["A", "B", "C"] as const;
export type ProspectPriority = (typeof PROSPECT_PRIORITIES)[number];

/**
 * Por donde se lo puede alcanzar. Se deriva de los datos de contacto y es EL
 * filtro de la cola: una ficha sin ningun canal no se puede trabajar, y verla
 * en la cola solo hace perder tiempo.
 */
export const CONTACTABILITY = ["phone", "digital", "none"] as const;
export type Contactability = (typeof CONTACTABILITY)[number];

// ---------------------------------------------------------------------------
// Actividad (cada intento de contacto)
// ---------------------------------------------------------------------------

export const ACTIVITY_TYPES = [
  "call",
  "whatsapp",
  "email",
  "instagram_dm",
  "meeting",
  "note",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * Resultado del intento. `connected` y `not_interested` son los unicos que
 * implican conversacion real; el resto son intentos fallidos, y por eso el
 * ratio intento->contacto es la metrica que dice si la lista sirve.
 */
export const ACTIVITY_OUTCOMES = [
  "connected",
  "no_answer",
  "voicemail",
  "busy",
  "wrong_number",
  "callback",
  "left_message",
  "not_interested",
  "none",
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Los outcomes que significan "hablamos con alguien". */
export const CONNECTED_OUTCOMES: ActivityOutcome[] = ["connected", "not_interested"];

/** Los tipos que cuentan como intento de contacto (una nota no lo es). */
export const ATTEMPT_TYPES: ActivityType[] = [
  "call",
  "whatsapp",
  "email",
  "instagram_dm",
  "meeting",
];

const activitySchema = new Schema(
  {
    activityId: { type: String, required: true, unique: true, index: true },
    prospectId: { type: String, required: true, index: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true, index: true },
    outcome: { type: String, enum: ACTIVITY_OUTCOMES, default: "none" },
    notes: { type: String, default: "" },
    /** Duracion de la llamada. Solo se carga si el operador la sabe. */
    durationSec: { type: Number, required: false },
    /** Transicion de etapa que provoco esta actividad, si hubo. */
    statusFrom: { type: String, enum: PROSPECT_STATUSES, required: false },
    statusTo: { type: String, enum: PROSPECT_STATUSES, required: false },
    userId: { type: String, required: false, index: true },
    userEmail: { type: String, required: false },
    occurredAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true, collection: "prospect_activities" },
);

activitySchema.index({ prospectId: 1, occurredAt: -1 });
activitySchema.index({ occurredAt: -1, type: 1 });

export type ProspectActivityDoc = InferSchemaType<typeof activitySchema>;
export const ProspectActivity = model("ProspectActivity", activitySchema);

// ---------------------------------------------------------------------------
// Prospecto
// ---------------------------------------------------------------------------

const contactSchema = new Schema(
  {
    /** Tal cual vino de la fuente, para que el operador vea lo mismo que el post. */
    phoneRaw: { type: String, required: false },
    /** E.164 cuando se pudo normalizar. Es el numero que se marca. */
    phone: { type: String, required: false, index: true },
    /** ISO-3166 alpha-2 deducido del telefono; alimenta `country` si falta. */
    phoneCountry: { type: String, required: false },
    email: { type: String, required: false, lowercase: true, trim: true },
    website: { type: String, required: false },
    websiteDomain: { type: String, required: false, index: true },
  },
  { _id: false },
);

/** Cada post del que salio el perfil. Sirve de evidencia y de senal de vida. */
const postSchema = new Schema(
  {
    url: { type: String, required: true },
    postedAt: { type: Date, required: false },
  },
  { _id: false },
);

const prospectSchema = new Schema(
  {
    prospectId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },

    // --- Identidad en la fuente ---------------------------------------------
    /** Handle de Instagram en minusculas. Es la clave de dedupe de la fuente. */
    handle: { type: String, required: false, lowercase: true, trim: true },
    handleUrl: { type: String, required: false },
    source: { type: String, enum: PROSPECT_SOURCES, default: "manual", index: true },
    /** Etiqueta del lote de importacion, para poder auditar de donde salio. */
    sourceBatch: { type: String, required: false, index: true },
    posts: { type: [postSchema], default: [] },
    /** Fecha del post mas reciente. Proxy de "el negocio sigue vivo". */
    lastPostAt: { type: Date, required: false },

    // --- Que es y donde -----------------------------------------------------
    lodgingType: { type: String, enum: LODGING_TYPES, default: "other", index: true },
    /** Texto libre tal cual vino: la fuente no trae la ubicacion estructurada. */
    location: { type: String, required: false },
    /** ISO-3166 alpha-2 cuando se pudo deducir. Vacio si no hay certeza. */
    country: { type: String, required: false, index: true },
    region: { type: String, required: false, index: true },

    contact: { type: contactSchema, default: () => ({}) },

    // --- Estado comercial ---------------------------------------------------
    status: { type: String, enum: PROSPECT_STATUSES, default: "new", index: true },
    /** Derivado de `status`. Se persiste para poder agrupar sin $switch. */
    outcome: { type: String, enum: PROSPECT_OUTCOMES, default: "open", index: true },
    statusChangedAt: { type: Date, default: () => new Date() },
    lostReason: { type: String, enum: LOST_REASONS, required: false, index: true },
    lostNote: { type: String, default: "" },

    priority: { type: String, enum: PROSPECT_PRIORITIES, default: "C", index: true },
    /** 0-100. Lo recalcula `recomputeDerived`; nadie lo escribe a mano. */
    score: { type: Number, default: 0, index: true },
    contactability: {
      type: String,
      enum: CONTACTABILITY,
      default: "none",
      index: true,
    },

    ownerUserId: { type: String, required: false, index: true },

    // --- Seguimiento de la llamada ------------------------------------------
    attempts: { type: Number, default: 0, index: true },
    lastAttemptAt: { type: Date, required: false, index: true },
    lastOutcome: { type: String, enum: ACTIVITY_OUTCOMES, required: false },
    firstReachedAt: { type: Date, required: false },
    /** Cuando volver a llamar. Es lo que ordena la cola del dia. */
    nextActionAt: { type: Date, required: false, index: true },
    nextActionNote: { type: String, default: "" },
    /** Pidio que no lo llamemos mas. Lo saca de la cola para siempre. */
    doNotCall: { type: Boolean, default: false, index: true },

    tags: { type: [String], default: [], index: true },
    notes: { type: String, default: "" },

    /** Puente con el CRM: se puebla al convertir. */
    accountId: { type: String, required: false },
  },
  { timestamps: true, collection: "prospects" },
);

// Un handle de Instagram no puede estar dos veces. Parcial porque un prospecto
// cargado a mano puede no tener handle.
prospectSchema.index(
  { handle: 1 },
  { unique: true, partialFilterExpression: { handle: { $type: "string" } } },
);
// Una cuenta del CRM no puede venir de dos prospectos.
prospectSchema.index(
  { accountId: 1 },
  { unique: true, partialFilterExpression: { accountId: { $type: "string" } } },
);
// La cola de llamadas: vencidos primero, despues por score.
prospectSchema.index({ doNotCall: 1, outcome: 1, nextActionAt: 1, score: -1 });
prospectSchema.index({ status: 1, updatedAt: -1 });
prospectSchema.index({ ownerUserId: 1, status: 1 });

export type ProspectDoc = InferSchemaType<typeof prospectSchema>;
export const Prospect = model("Prospect", prospectSchema);

// ---------------------------------------------------------------------------
// Derivados
// ---------------------------------------------------------------------------

/** Tipos que suelen tener mas de 10 unidades: mejor encaje con el full system. */
const BIG_FIT: LodgingType[] = ["hotel", "apart_hotel", "resort", "lodge", "hostel"];
const MID_FIT: LodgingType[] = [
  "inn_bnb",
  "cabins",
  "country_house",
  "glamping",
  "villas",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Score 0-100 de "a quien conviene llamar primero". No es una prediccion de
 * cierre: es cuan accionable esta la ficha (¿hay a donde llamar?), cuanto
 * encaja el tipo de alojamiento y si el negocio da senales de vida.
 *
 * Se recalcula en cada escritura para que ordenar por score nunca dependa de
 * cuando se importo la fila.
 */
export function computeScore(doc: {
  contact?: { phone?: string | null; email?: string | null; website?: string | null };
  lodgingType?: string | null;
  location?: string | null;
  lastPostAt?: Date | null;
  posts?: unknown[];
}): number {
  let score = 0;

  if (doc.contact?.phone) score += 35;
  if (doc.contact?.email) score += 10;
  if (doc.contact?.website) score += 10;
  if (doc.location) score += 8;

  const type = (doc.lodgingType ?? "other") as LodgingType;
  if (BIG_FIT.includes(type)) score += 15;
  else if (MID_FIT.includes(type)) score += 8;

  if (doc.lastPostAt) {
    const days = (Date.now() - new Date(doc.lastPostAt).getTime()) / DAY_MS;
    if (days <= 90) score += 18;
    else if (days <= 365) score += 11;
    else if (days <= 730) score += 4;
  }

  // Aparecer en varios posts distintos es senal de actividad sostenida.
  const posts = doc.posts?.length ?? 0;
  if (posts >= 3) score += 4;
  else if (posts === 2) score += 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * El handle de Instagram cuenta como canal: la fuente de esta lista son perfiles
 * de Instagram y la mayoria NO publica telefono, asi que el DM es el unico
 * camino que hay. Sin contarlo, tres de cada cuatro fichas quedarian fuera de la
 * cola por "no contactables" cuando en realidad si se las puede abordar.
 */
export function computeContactability(doc?: {
  handle?: string | null;
  contact?: {
    phone?: string | null;
    phoneRaw?: string | null;
    email?: string | null;
    website?: string | null;
  } | null;
}): Contactability {
  const contact = doc?.contact;
  if (contact?.phone || contact?.phoneRaw) return "phone";
  if (contact?.email || contact?.website || doc?.handle) return "digital";
  return "none";
}

/**
 * Deja consistentes los campos que se calculan a partir de otros. Se llama
 * SIEMPRE antes de guardar: `outcome`, `score` y `contactability` no se
 * escriben nunca desde afuera.
 */
export function recomputeDerived(doc: {
  status?: string | null;
  handle?: string | null;
  outcome?: string;
  score?: number;
  contactability?: string;
  contact?: Record<string, unknown>;
  lodgingType?: string | null;
  location?: string | null;
  lastPostAt?: Date | null;
  posts?: unknown[];
  country?: string | null;
}): void {
  const status = (doc.status ?? "new") as ProspectStatus;
  doc.outcome = outcomeOf(status);
  doc.score = computeScore(doc as never);
  doc.contactability = computeContactability(doc as never);
  // El pais del telefono es mejor dato que el texto libre de la ubicacion,
  // pero solo se usa para RELLENAR: si ya hay pais cargado no se pisa.
  const phoneCountry = (doc.contact as { phoneCountry?: string } | undefined)
    ?.phoneCountry;
  if (!doc.country && phoneCountry) doc.country = phoneCountry;
}

// ---------------------------------------------------------------------------

export function sanitizeDoc<T>(doc: T): T {
  if (!doc) return doc;
  const obj =
    doc && typeof doc === "object" && "toObject" in (doc as object)
      ? (doc as unknown as { toObject: () => Record<string, unknown> }).toObject()
      : (doc as unknown as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}
