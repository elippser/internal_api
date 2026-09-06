import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Leads del sitio publico: quien pidio acceso a Roombir y con que alojamiento.
 *
 * Es la UNICA puerta de alta de la plataforma. El formulario de
 * `/crear-cuenta` (public-side/mkt-renderer) escribe aca, este modulo emite un
 * invite de un solo uso y lo manda por mail, y el `/register` del PMS no crea
 * absolutamente nada sin ese invite. Sin lead no hay cuenta.
 *
 * Dos colecciones y no una:
 *
 * - `leads` es la ficha comercial (que alojamiento, cuantas unidades, donde) y
 *   se conserva aunque el invite venza, se revoque o se reemita.
 * - `lead_invites` son los tokens. Cada reenvio es una fila nueva y revoca las
 *   anteriores, asi que el historial de "cuantas veces se le mando" queda a la
 *   vista y un token viejo filtrado no sirve mas.
 *
 * El token NUNCA se guarda en claro: se guarda su SHA-256. Quien lea la base no
 * puede darse de alta con lo que ve, que es justo el punto de tener un porton.
 *
 * Los enums van en ingles (como en `prospects.model` y `crm.model`); los labels
 * en castellano viven en el front (`web/src/modules/leads/types.ts`) y en los
 * cinco diccionarios del sitio publico.
 */

// ---------------------------------------------------------------------------
// Catalogos
// ---------------------------------------------------------------------------

/**
 * Tipo de alojamiento. Los valores son DELIBERADAMENTE los mismos strings que
 * `LODGING_TYPES` de `prospects.model`: un lead que despues se trabaja como
 * prospecto o se convierte en cuenta del CRM no necesita tabla de traduccion.
 *
 * Se redeclara en vez de importarse porque esta lista tambien es un desplegable
 * publico traducido a cinco idiomas: sumar un tipo alla no deberia hacer
 * aparecer una opcion sin etiqueta en el formulario del sitio.
 */
export const LEAD_LODGING_TYPES = [
  "hotel",
  "apart_hotel",
  "hostel",
  "cabins",
  "inn_bnb",
  "apartment",
  "house",
  "country_house",
  "resort",
  "lodge",
  "glamping",
  "camping",
  "villas",
  "other",
] as const;
export type LeadLodgingType = (typeof LEAD_LODGING_TYPES)[number];

/**
 * Estado del lead. El orden es el del embudo real:
 *
 *   new         entro el formulario, todavia no salio el mail
 *   invited     se le mando el acceso
 *   opened      abrio el enlace (el /register valido su token)
 *   registered  creo la cuenta: el invite quedo consumido
 *   discarded   lo descartamos a mano (no es cliente posible)
 *   spam        lo descarto el filtro: honeypot, tiempo imposible, dominio quemado
 *
 * `spam` no se borra a proposito: es la unica forma de ver si el formulario
 * esta bajo ataque y de medir si el filtro se esta comiendo gente real.
 */
export const LEAD_STATUSES = [
  "new",
  "invited",
  "opened",
  "registered",
  "discarded",
  "spam",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** De donde salio. Hoy solo el sitio, pero el alta a mano desde el panel viene. */
export const LEAD_SOURCES = ["public_site", "manual", "import", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * Motivos por los que el filtro marco el envio. Se guardan aunque el lead pase:
 * una sola bandera no descalifica, pero dos sobre la misma ficha explican por
 * que se la mando a `spam`.
 */
export const LEAD_RISK_FLAGS = [
  "honeypot",
  "too_fast",
  "no_interaction",
  "disposable_email",
  "role_email",
  "rate_limited",
  "duplicate_burst",
  "captcha_failed",
  "suspicious_text",
] as const;
export type LeadRiskFlag = (typeof LEAD_RISK_FLAGS)[number];

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

const leadSchema = new Schema(
  {
    leadId: { type: String, required: true, unique: true, index: true },

    // ---- El alojamiento (lo que pide el formulario) ----
    hotelName: { type: String, required: true, trim: true, maxlength: 160 },
    lodgingType: {
      type: String,
      enum: LEAD_LODGING_TYPES,
      default: "other",
      index: true,
    },
    /** Habitaciones o unidades. Dimensiona el onboarding y ordena la prioridad. */
    units: { type: Number, min: 1, max: 100000, default: null },
    /** ISO-3166-1 alpha-2, siempre en mayusculas. */
    countryCode: { type: String, uppercase: true, minlength: 2, maxlength: 2, index: true },
    city: { type: String, trim: true, maxlength: 120 },

    // ---- Quien escribe ----
    contactName: { type: String, trim: true, maxlength: 120 },
    /** Normalizado a minusculas. Es la llave real del lead. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    /** E.164 si vino; opcional (phone-e164-convention). */
    phone: { type: String, trim: true, maxlength: 32, default: "" },
    /** Idioma en el que llego: decide en que idioma sale el mail de acceso. */
    locale: { type: String, default: "es", maxlength: 5 },

    // ---- Estado ----
    status: { type: String, enum: LEAD_STATUSES, default: "new", index: true },
    statusChangedAt: { type: Date, default: Date.now },
    source: { type: String, enum: LEAD_SOURCES, default: "public_site" },
    siteId: { type: String, default: "" },

    // ---- Atribucion ----
    utm: { type: Schema.Types.Mixed, default: {} },
    referer: { type: String, default: "", maxlength: 500 },

    // ---- Contexto del envio (para el filtro y para el soporte) ----
    capture: {
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "", maxlength: 400 },
      /** Milisegundos entre que se pinto el formulario y se apreto enviar. */
      elapsedMs: { type: Number, default: null },
    },

    /** Lo que vio el filtro anti-bots. `score` alto = mas sospechoso. */
    screening: {
      score: { type: Number, default: 0 },
      flags: [{ type: String, enum: LEAD_RISK_FLAGS }],
    },

    // ---- Resumen del invite (el token vive en lead_invites) ----
    invite: {
      sentCount: { type: Number, default: 0 },
      firstSentAt: { type: Date, default: null },
      lastSentAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      openedAt: { type: Date, default: null },
      usedAt: { type: Date, default: null },
      revokedAt: { type: Date, default: null },
      /** Ultimo error del proveedor de mail, si lo hubo. Se limpia al reenviar. */
      lastError: { type: String, default: "" },
    },

    // ---- Cierre del circuito ----
    registeredUserId: { type: String, default: null },
    registeredAt: { type: Date, default: null },

    // ---- Trabajo interno ----
    ownerUserId: { type: String, default: null, index: true },
    notes: { type: String, default: "", maxlength: 4000 },
    submissions: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "leads" },
);

// La lista del panel ordena por fecha y filtra por estado; el detalle entra por
// email cuando alguien escribe a soporte "no me llego el mail".
leadSchema.index({ createdAt: -1 });
leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ email: 1, createdAt: -1 });

export type LeadDoc = InferSchemaType<typeof leadSchema>;
export const Lead = model("Lead", leadSchema);

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

const leadInviteSchema = new Schema(
  {
    inviteId: { type: String, required: true, unique: true, index: true },
    leadId: { type: String, required: true, index: true },
    /** Copia del email al momento de emitir: el invite vale para ESE correo. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    /**
     * SHA-256 del token en hex. El token en claro existe una sola vez, dentro
     * del mail. Ni el panel ni la base pueden reconstruirlo.
     */
    tokenHash: { type: String, required: true, unique: true, index: true },

    expiresAt: { type: Date, required: true, index: true },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    /** Por que se revoco: "resend" (salio uno nuevo) o "manual" (lo corto alguien). */
    revokedReason: { type: String, default: "" },

    /** Desde donde se consumio. Sirve para auditar un alta rara. */
    usedFrom: {
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "", maxlength: 400 },
    },
    /** Intentos fallidos de canje sobre este token (vencido, mail que no coincide). */
    failedAttempts: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "lead_invites" },
);

export type LeadInviteDoc = InferSchemaType<typeof leadInviteSchema>;
export const LeadInvite = model("LeadInvite", leadInviteSchema);
