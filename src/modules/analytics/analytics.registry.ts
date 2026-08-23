import Joi from "joi";

/**
 * Catálogo de eventos de comportamiento de la plataforma.
 *
 * Es la lista blanca de la ingesta: un evento que no está acá se descarta (con
 * contador, ver `analytics.dropped.ts`). Antes `eventName`, `category`, `source`
 * y `payload` eran strings/Mixed libres, así que nada garantizaba que los
 * campos que leen los dashboards (`payload.appId`, `payload.durationSeconds`,
 * `payload.componentType`) llegaran realmente.
 *
 * Al agregar un evento nuevo: definilo acá PRIMERO, después instrumentá el
 * emisor. Si el emisor manda algo fuera del contrato, el evento se pierde en
 * silencio (la ingesta nunca devuelve error al cliente, es telemetría).
 *
 * Ver METRICAS-COMPORTAMIENTO-SPEC.md §5 en la raíz del repo.
 */

/** Apps que pueden emitir eventos. */
export const EVENT_SOURCES = [
  "pms-core",
  "web-engine-public",
  "web-renderer",
  "staypass",
  "booking-app",
  "linkhub-renderer",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export interface EventDefinition {
  /** Agrupador para filtros y dashboards. */
  category: string;
  /** Apps autorizadas a emitirlo. */
  sources: EventSource[];
  /** Contrato del payload. `unknown(true)` donde convenga tolerar extras. */
  payload: Joi.ObjectSchema;
}

const PMS: EventSource[] = ["pms-core"];
/** Los tres fronts que embeben el motor de reservas. */
const ENGINE_FRONTS: EventSource[] = [
  "web-engine-public",
  "web-renderer",
  "staypass",
];

/** Emitido server-side por un api, no por un browser. */
const num = Joi.number();
const str = Joi.string().max(200);

export const EVENT_REGISTRY: Record<string, EventDefinition> = {
  // ── Onboarding (alta guiada de 9 pasos) ──────────────────────────────────
  onboarding_started: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({ stepIndex: num.min(0).max(8).default(0) }),
  },
  onboarding_step_completed: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      stepIndex: num.min(0).max(8).required(),
      stage: num.min(1).max(4),
      durationSeconds: num.min(0),
    }),
  },
  onboarding_step_skipped: {
    category: "onboarding",
    sources: PMS,
    // Sólo los pasos 6 (promociones) y 7 (motor) son omitibles.
    payload: Joi.object({ stepIndex: num.valid(6, 7).required() }),
  },
  onboarding_step_exit: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      stepIndex: num.min(0).max(8).required(),
      msOnStep: num.min(0),
    }),
  },
  onboarding_stage_completed: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({ stage: num.min(1).max(4).required() }),
  },
  onboarding_resumed: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      stepIndex: num.min(0).max(8).required(),
      dormantHours: num.min(0),
    }),
  },
  onboarding_completed: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      totalSteps: num.min(0),
      skippedSteps: Joi.array().items(num).max(9),
    }),
  },
  onboarding_ota_declared: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({ value: Joi.boolean().required() }),
  },

  // ── Fricción del paso Habitaciones (piloto §5) ───────────────────────────
  // Separa fricción de ESFUERZO (tipear, tedio) de fricción de DECISIÓN (no
  // sabe qué nombre o precio poner): los `msIdleBefore*` miden mirar el campo
  // sin tipear; los `ms*Filled`, el tipeo efectivo.
  onboarding_rooms_started: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({}),
  },
  onboarding_rooms_category_saved: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      categoryIndex: num.min(0).required(),
      msToFirstInput: num.min(0),
      msIdleBeforeName: num.min(0),
      msIdleBeforePrice: num.min(0),
      msNameFilled: num.min(0),
      msPriceFilled: num.min(0),
      msFirstPhoto: num.min(0),
      msTotal: num.min(0),
      photosCount: num.min(0),
      unitsCreated: num.min(0),
      usedBulkUnits: Joi.boolean(),
    }),
  },
  onboarding_rooms_help_opened: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({ field: str.required() }),
  },
  onboarding_rooms_completed: {
    category: "onboarding",
    sources: PMS,
    payload: Joi.object({
      categoriesCount: num.min(0),
      unitsCount: num.min(0),
      msTotal: num.min(0),
    }),
  },

  // ── Uso del PMS ──────────────────────────────────────────────────────────
  /**
   * El payload lleva equipo y ubicación desde que existe la bitácora de accesos
   * (USERS-ACTIONS-SPEC §6.4). El detalle completo de cada acceso vive en
   * `user_access_events`, que es un log de seguridad con su propia retención;
   * acá van sólo los cortes que los tableros de adopción necesitan agregar.
   *
   * Ojo: agregar un campo al emisor SIN agregarlo acá hace que el evento entero
   * se descarte en silencio.
   */
  staff_login: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({
      method: str.valid("password", "auth0"),
      deviceType: str,
      browser: str,
      os: str,
      country: str.max(2),
      city: str,
      isNewDevice: Joi.boolean(),
    }),
  },
  app_opened: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      spaceId: str,
      spaceType: str,
    }),
  },
  app_session_ended: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      durationSeconds: num.min(0).required(),
    }),
  },
  guide_started: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({ guideId: str.required(), totalSteps: num.min(0) }),
  },
  guide_completed: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({ guideId: str.required(), totalSteps: num.min(0) }),
  },
  guide_dismissed: {
    category: "pms",
    sources: PMS,
    payload: Joi.object({
      guideId: str.required(),
      stepIndex: num.min(0),
      totalSteps: num.min(0),
    }),
  },
  site_published: {
    category: "builder",
    sources: PMS,
    payload: Joi.object({
      siteId: str,
      subSiteId: str,
      language: str.max(10),
    }),
  },
  builder_page_edited: {
    category: "builder",
    sources: PMS,
    payload: Joi.object({ siteId: str, subSiteId: str, pageId: str }),
  },
  builder_component_added: {
    category: "builder",
    sources: PMS,
    payload: Joi.object({ componentType: str.required() }),
  },

  // ── Usabilidad por app (ISO 9241-11 + HEART) ─────────────────────────────
  // Familia genérica: cualquier app del catálogo emite estos cuatro eventos con
  // su `appId` y un `taskId` propio. Así la usabilidad se mide igual en todas
  // (efectividad = completadas/iniciadas, eficiencia = duración y pasos,
  // errores = task_error) sin inventar una métrica distinta por pantalla.
  app_screen_viewed: {
    category: "usability",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      screenId: str.required(),
      /** Profundidad dentro de la app: cuántas pantallas lleva la sesión. */
      depth: num.min(0),
    }),
  },
  task_started: {
    category: "usability",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      taskId: str.required(),
    }),
  },
  task_completed: {
    category: "usability",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      taskId: str.required(),
      durationSeconds: num.min(0).required(),
      /** Pasos/pantallas que tomó completarla: la eficiencia del recorrido. */
      steps: num.min(0),
    }),
  },
  task_abandoned: {
    category: "usability",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      taskId: str.required(),
      /** En qué paso se cayó: sin esto sólo se sabe que falló, no dónde. */
      atStep: str,
      durationSeconds: num.min(0),
    }),
  },
  task_error: {
    category: "usability",
    sources: PMS,
    payload: Joi.object({
      appId: str.required(),
      taskId: str.required(),
      /** Código estable, no el mensaje: los mensajes cambian y rompen series. */
      code: str,
    }),
  },

  // ── Funnel del motor de reservas ─────────────────────────────────────────
  // Los 6 pasos van con `sessionId` real (no el centinela "server"): el funnel
  // se computa por sesión distinta, no contando documentos.
  engine_search_initiated: {
    category: "engine",
    sources: ENGINE_FRONTS,
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      checkIn: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
      checkOut: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()),
      nights: num.min(0),
      adults: num.min(0),
      children: num.min(0),
      hasAvailability: Joi.boolean().required(),
      resultsCount: num.min(0),
      engineSource: str,
    }),
  },
  engine_results_viewed: {
    category: "engine",
    sources: ENGINE_FRONTS,
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      resultsCount: num.min(0),
      engineSource: str,
    }),
  },
  engine_category_selected: {
    category: "engine",
    sources: ENGINE_FRONTS,
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      categoryId: str,
      engineSource: str,
    }),
  },
  engine_checkout_started: {
    category: "engine",
    sources: ENGINE_FRONTS,
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      categoryId: str,
      nights: num.min(0),
      engineSource: str,
    }),
  },
  engine_auth_completed: {
    category: "engine",
    sources: ENGINE_FRONTS,
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      mode: str.valid("guest", "logged", "new_account"),
      engineSource: str,
    }),
  },
  engine_reservation_created: {
    category: "engine",
    // Server-side desde booking-app: es el único paso que no puede depender de
    // que el browser siga vivo después de confirmar.
    sources: ["booking-app"],
    payload: Joi.object({
      propertyId: str,
      propertySlug: str,
      reservationCode: str,
      status: str,
      totalAmount: num.min(0),
      currency: str.max(10),
      servicesCount: num.min(0),
    }),
  },

  // ── Huésped (StayPass) — siempre server-side ─────────────────────────────
  staypass_guest_registered: {
    category: "guest",
    sources: ["staypass"],
    payload: Joi.object({
      method: str.valid("password", "auth0", "deferred", "silent").required(),
      propertyId: str,
      // true = la cuenta ya existía y sólo se le sumó esta compañía. Distingue
      // "huésped nuevo de la plataforma" de "huésped nuevo de este hotel".
      reused: Joi.boolean(),
    }),
  },
  staypass_login: {
    category: "guest",
    sources: ["staypass"],
    payload: Joi.object({ method: str.valid("password", "auth0") }),
  },
  guest_reservation_confirmed: {
    category: "guest",
    sources: ["staypass"],
    payload: Joi.object({
      reservationCode: str,
      viaToken: Joi.boolean(),
    }),
  },
  guest_reservation_cancelled: {
    category: "guest",
    sources: ["booking-app"],
    payload: Joi.object({ reservationCode: str }),
  },

  // ── Capa agéntica ────────────────────────────────────────────────────────
  // Piso, no total: `availability.json` va con Cache-Control max-age=300, así
  // que los hits servidos por el CDN nunca llegan al origen.
  agentic_endpoint_hit: {
    category: "agentic",
    sources: ["web-renderer"],
    payload: Joi.object({
      endpoint: str
        .valid("llms_txt", "availability_json", "engine_capabilities")
        .required(),
      propertyId: str,
      withDates: Joi.boolean(),
    }),
  },
};

export const KNOWN_EVENT_NAMES = Object.keys(EVENT_REGISTRY);

export function getEventDefinition(
  eventName: string,
): EventDefinition | undefined {
  return EVENT_REGISTRY[eventName];
}
