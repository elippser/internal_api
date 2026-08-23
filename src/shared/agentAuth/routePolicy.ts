import {
  capabilityLabel,
  osAppLabel,
  type CompanyCapability,
  type OSAppId,
  type PmsRole,
} from "./pmsAccessCatalog";
import {
  appAccessOf,
  canSeeProperty,
  hasAppAccess,
  hasCapability,
  type UserScope,
} from "./userScope";

/**
 * POLÍTICA DE ACCESO POR RUTA para las herramientas del agente.
 *
 * El agente puede pegarle a CUALQUIER endpoint de los microservicios del PMS
 * (tools específicas + `read_*_api` / `write_*_api` crudas). Cada uno de esos
 * servicios autoriza de forma distinta:
 *
 *   - booking-app / rooms-app / rms-app: `requireSpaceAccess(appId, level)` por
 *     ruta, contra `spacePermissions` del JWT (owner/admin bypass).
 *   - pms-core: `requireRole` por ruta y `requireCapability` sólo en equipo;
 *     NO valida apps del espacio, y varias familias (/site-data, /asset-library,
 *     /custom-catalog, PUT /company) sólo piden estar autenticado.
 *
 * Esta tabla espeja esas reglas (una por familia de rutas, con la misma app y
 * nivel que exige el servicio destino) y las COMPLETA donde el PMS es laxo:
 * las escrituras de pms-core quedan detrás de la app del espacio o de la
 * capability de company que la UI del PMS usa para mostrar esa pantalla. Así,
 * un usuario sin permiso sobre una app no puede modificarla desde el chat
 * aunque el endpoint del servicio lo dejara pasar.
 *
 * Se usa en dos momentos del runtime del chat:
 *   1) al armar las tools del turno: las que el usuario no puede usar NO se le
 *      ofrecen al modelo (y el prompt le explica por qué);
 *   2) en cada tool call (defensa en profundidad y única barrera para las tools
 *      crudas, cuyo path lo elige el modelo): se re-evalúa contra el path real,
 *      el propertyId objetivo y el alcance fresco del usuario.
 *
 * Fail-closed en escrituras: un path que ninguna regla reconoce se puede LEER
 * (el PMS aplica su propio authorize) pero NO ESCRIBIR salvo que el usuario sea
 * owner/admin. Cuando pms-core sume una ruta nueva, hay que agregarla acá para
 * que el staff la pueda usar desde el agente.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type PolicyService = "pms-core" | "booking-app" | "rooms-app" | "rms-app" | "staypass";

export type AccessKind =
  /** Endpoint público: sin identidad. */
  | "public"
  /** Cualquier usuario con membership activa en la company. */
  | "member"
  /** Sólo owner/admin de la company. */
  | "admin"
  /** Sólo owner. */
  | "owner"
  /** Nunca vía agente (auth, plataforma, flujos de huésped, internos). */
  | "deny";

export interface RouteRule {
  method: HttpMethod | HttpMethod[] | "*";
  /** Patrón: segmentos `:param` (uno) y sufijo `/*` (la colección y todo lo de abajo). Sin query. */
  path: string;
  access?: AccessKind;
  /** Rol PMS que la ruta exige (espejo de `requireRole`). */
  roles?: PmsRole[];
  /** App del espacio operativo + nivel (espejo de `requireSpaceAccess`). Alcanza con una. */
  app?: { ids: OSAppId[]; level: "operate" | "write" };
  /** Capability de company (espejo de `requireCapability`). Alcanza con una. */
  capability?: CompanyCapability[];
  /** Etiqueta humana de la familia (para el mensaje al usuario). */
  label: string;
}

/** Decisión de acceso para una llamada concreta. */
export interface AccessDecision {
  allowed: boolean;
  code?:
    | "scope_unavailable"
    | "password_change_required"
    | "not_member"
    | "endpoint_not_allowed"
    | "insufficient_role"
    | "missing_capability"
    | "no_active_space"
    | "insufficient_app_access"
    | "property_out_of_scope"
    | "space_property_mismatch"
    | "unknown_write";
  /** Mensaje en español, listo para que el modelo se lo diga al usuario. */
  message?: string;
  rule?: RouteRule;
  /** Cómo se resolvió (telemetría/logs). */
  reason: string;
}

// ── Helpers de definición ───────────────────────────────────────────────────

const READ_ROLES: PmsRole[] = ["owner", "admin", "staff", "viewer"];
const STAFF_ROLES: PmsRole[] = ["owner", "admin", "staff"];
const ADMIN_ROLES: PmsRole[] = ["owner", "admin"];
const WRITES: HttpMethod[] = ["POST", "PATCH", "PUT", "DELETE"];

const app = (ids: OSAppId | OSAppId[], level: "operate" | "write") => ({
  ids: Array.isArray(ids) ? ids : [ids],
  level,
});

// ── pms-core ────────────────────────────────────────────────────────────────
// Rutas legacy cuelgan de la raíz (/company, /user, /site-data, ...); el dominio
// hotelero va bajo /api/v1. El orden importa: primero lo específico.
const PMS_CORE_RULES: RouteRule[] = [
  // Público
  { method: "GET", path: "/api/v1/public/*", access: "public", label: "Datos públicos" },
  { method: "GET", path: "/site-data/custom-hostname/resolve", access: "public", label: "Resolución de dominio" },
  { method: "GET", path: "/site-data/first-available", access: "public", label: "Sitio público" },
  { method: "GET", path: "/site-data/get-site-for-client/:siteId", access: "public", label: "Sitio público" },
  { method: "GET", path: "/site-data/client-data-pages/:id", access: "public", label: "Sitio público" },
  // Acciones de UI (no pegan al backend; ver executeTool)
  { method: "*", path: "/ui/*", access: "public", label: "Acción de interfaz" },

  // Auth y plataforma: nunca desde el agente
  { method: "*", path: "/user/register", access: "deny", label: "Registro" },
  { method: "*", path: "/user/login", access: "deny", label: "Login" },
  { method: "*", path: "/user/auth0/*", access: "deny", label: "Auth0" },
  { method: "*", path: "/user/change-password", access: "deny", label: "Cambio de contraseña" },
  { method: "*", path: "/reset-password/*", access: "deny", label: "Reset de contraseña" },
  { method: "POST", path: "/company/create", access: "deny", label: "Alta de empresa" },
  { method: "*", path: "/api/v1/notifications/auth", access: "deny", label: "Notificaciones (interno)" },
  { method: "*", path: "/api/v1/notifications/ingest", access: "deny", label: "Notificaciones (interno)" },
  { method: "*", path: "/api/v1/notifications/debug-ping", access: "deny", label: "Notificaciones (interno)" },
  { method: "*", path: "/api/v1/ai/*", access: "deny", label: "IA de onboarding" },
  { method: WRITES, path: "/api/v1/site-templates/*", access: "deny", label: "Plantillas de sitio (plataforma)" },
  { method: "*", path: "/site-data/test/*", access: "deny", label: "Test" },

  // Usuario (self)
  { method: ["GET", "PUT"], path: "/user/profile", access: "member", label: "Perfil propio" },
  { method: "PUT", path: "/user/active-company", access: "member", label: "Empresa activa" },
  { method: "PATCH", path: "/user/active-operative-space", access: "member", label: "Espacio operativo activo" },
  { method: "GET", path: "/user/by-email", capability: ["users.manage"], label: "Buscar usuario por email" },
  { method: "*", path: "/user/guide-progress", access: "member", label: "Progreso de guías" },
  { method: "*", path: "/api/v1/induction/*", access: "member", label: "Inducción" },
  { method: "GET", path: "/api/v1/notifications", access: "member", label: "Notificaciones" },
  { method: "POST", path: "/api/v1/notifications/mark-read", access: "member", label: "Notificaciones" },
  { method: "GET", path: "/api/v1/search", access: "member", label: "Buscador global" },
  { method: "*", path: "/chat/*", access: "member", label: "Chat interno del equipo" },
  { method: "GET", path: "/project/*", access: "member", label: "Proyectos" },

  // Empresa y equipo
  { method: "GET", path: "/company/profile", access: "member", label: "Perfil de la empresa" },
  { method: "GET", path: "/company/my-companies", access: "member", label: "Mis empresas" },
  { method: "GET", path: "/company/associated", access: "member", label: "Empresas asociadas" },
  { method: "GET", path: "/company/:companyId/onboarding", access: "member", label: "Onboarding" },
  { method: "PATCH", path: "/company/:companyId/onboarding", capability: ["company.settings"], label: "Onboarding" },
  { method: "GET", path: "/company/:companyId/users", capability: ["users.manage"], label: "Equipo" },
  { method: "POST", path: "/company/:companyId/users", capability: ["users.manage"], label: "Equipo (agregar usuarios)" },
  { method: "POST", path: "/company/:companyId/invite", capability: ["users.manage"], label: "Equipo (invitar)" },
  { method: "*", path: "/company/:companyId/users/:userId/*", capability: ["users.manage"], label: "Equipo (rol/estado/accesos)" },
  { method: "DELETE", path: "/company/:companyId/users/:userId", capability: ["users.manage"], label: "Equipo (quitar usuario)" },
  { method: "PUT", path: "/company/:companyId", capability: ["company.settings"], label: "Ajustes de la empresa" },
  { method: "PUT", path: "/company", capability: ["company.settings"], label: "Ajustes de la empresa" },

  // Catálogos y librería
  { method: "GET", path: "/custom-catalog/*", access: "member", label: "Catálogos" },
  { method: WRITES, path: "/custom-catalog/*", capability: ["company.settings"], label: "Catálogos" },
  { method: "GET", path: "/asset-library/*", app: app("libreria-archivos", "operate"), label: "Librería de archivos" },
  { method: WRITES, path: "/asset-library/*", app: app("libreria-archivos", "write"), label: "Librería de archivos" },
  { method: "GET", path: "/api/v1/site-templates/*", access: "member", label: "Plantillas de sitio" },
  { method: "GET", path: "/api/v1/property-templates/*", access: "member", label: "Plantillas de propiedad" },
  { method: "GET", path: "/api/v1/service-categories", roles: READ_ROLES, label: "Categorías de servicios" },
  { method: WRITES, path: "/api/v1/service-categories/*", roles: ADMIN_ROLES, label: "Categorías de servicios" },

  // Web builder (sitios web). La capability `sites.manage` es el acceso al
  // builder según pms-core; las lecturas quedan abiertas a la company.
  { method: "GET", path: "/site-data/*", access: "member", label: "Sitios web" },
  { method: WRITES, path: "/site-data/*", capability: ["sites.manage"], label: "Sitios web (builder)" },

  // Propiedades
  { method: "GET", path: "/api/v1/properties", roles: READ_ROLES, label: "Propiedades" },
  { method: "POST", path: "/api/v1/properties", roles: ADMIN_ROLES, capability: ["properties.create"], label: "Crear propiedad" },
  { method: "GET", path: "/api/v1/properties/:propertyId", roles: READ_ROLES, label: "Propiedad" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId", roles: ADMIN_ROLES, capability: ["properties.edit"], label: "Editar propiedad" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/status", roles: ADMIN_ROLES, label: "Estado de la propiedad" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/reservation-defaults", roles: ADMIN_ROLES, label: "Defaults de reserva" },
  { method: "POST", path: "/api/v1/properties/:propertyId/apply-template", roles: ADMIN_ROLES, label: "Aplicar plantilla" },
  { method: "DELETE", path: "/api/v1/properties/:propertyId", access: "owner", label: "Eliminar propiedad" },

  // Unidades (espejo pms-core de rooms-app)
  { method: "GET", path: "/api/v1/properties/:propertyId/units/*", roles: READ_ROLES, label: "Unidades" },
  { method: "GET", path: "/api/v1/properties/:propertyId/units", roles: READ_ROLES, label: "Unidades" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/units/:unitId/status", roles: STAFF_ROLES, app: app("estado-habitaciones", "operate"), label: "Estado de habitación" },
  { method: "POST", path: "/api/v1/properties/:propertyId/units", roles: ADMIN_ROLES, label: "Unidades" },
  { method: ["PATCH", "DELETE"], path: "/api/v1/properties/:propertyId/units/:unitId", roles: ADMIN_ROLES, label: "Unidades" },

  // Espacios operativos
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/:spaceId/permissions/me", access: "member", label: "Mis permisos del espacio" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards/*", roles: READ_ROLES, label: "Dashboards (Inicio)" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards", roles: READ_ROLES, label: "Dashboards (Inicio)" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards/:dashboardId/widgets", roles: STAFF_ROLES, label: "Widgets del dashboard" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards/*", roles: ADMIN_ROLES, label: "Dashboards (Inicio)" },
  { method: "POST", path: "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards", roles: ADMIN_ROLES, label: "Dashboards (Inicio)" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/:spaceId/users", roles: STAFF_ROLES, label: "Usuarios del espacio" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/:spaceId/users/*", roles: STAFF_ROLES, label: "Usuarios del espacio" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/spaces/:spaceId/users/*", roles: STAFF_ROLES, capability: ["users.assign_spaces"], label: "Usuarios del espacio" },
  { method: "POST", path: "/api/v1/properties/:propertyId/spaces/:spaceId/users", roles: STAFF_ROLES, capability: ["users.assign_spaces"], label: "Usuarios del espacio" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/spaces/:spaceId/integrations", roles: ADMIN_ROLES, capability: ["apps.toggle"], label: "Apps del espacio" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/spaces/:spaceId/roles", roles: ADMIN_ROLES, capability: ["spaces.manage"], label: "Roles del espacio" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces/*", roles: READ_ROLES, label: "Espacios operativos" },
  { method: "GET", path: "/api/v1/properties/:propertyId/spaces", roles: READ_ROLES, label: "Espacios operativos" },
  { method: "POST", path: "/api/v1/properties/:propertyId/spaces", roles: ADMIN_ROLES, capability: ["spaces.manage"], label: "Espacios operativos" },
  { method: ["PATCH", "DELETE"], path: "/api/v1/properties/:propertyId/spaces/:spaceId", roles: ADMIN_ROLES, capability: ["spaces.manage"], label: "Espacios operativos" },

  // Servicios y amenities (Ajustes)
  { method: "GET", path: "/api/v1/properties/:propertyId/services/*", roles: READ_ROLES, label: "Servicios" },
  { method: "GET", path: "/api/v1/properties/:propertyId/services", roles: READ_ROLES, label: "Servicios" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/services/*", roles: ADMIN_ROLES, label: "Servicios" },
  { method: "POST", path: "/api/v1/properties/:propertyId/services", roles: ADMIN_ROLES, label: "Servicios" },
  { method: "GET", path: "/api/v1/properties/:propertyId/amenities", roles: READ_ROLES, label: "Amenities" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/amenities/*", roles: ADMIN_ROLES, label: "Amenities" },
  { method: "POST", path: "/api/v1/properties/:propertyId/amenities", roles: ADMIN_ROLES, label: "Amenities" },

  // Marketing por propiedad
  { method: "GET", path: "/api/v1/properties/:propertyId/galleries/*", roles: READ_ROLES, app: app("galerias", "operate"), label: "Galerías" },
  { method: "GET", path: "/api/v1/properties/:propertyId/galleries", roles: READ_ROLES, app: app("galerias", "operate"), label: "Galerías" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/galleries/*", roles: ADMIN_ROLES, app: app("galerias", "write"), label: "Galerías" },
  { method: "POST", path: "/api/v1/properties/:propertyId/galleries", roles: ADMIN_ROLES, app: app("galerias", "write"), label: "Galerías" },
  { method: "PUT", path: "/api/v1/properties/:propertyId/reviews/:reviewId/response", roles: STAFF_ROLES, app: app("resenas", "write"), label: "Responder reseña" },
  { method: "GET", path: "/api/v1/properties/:propertyId/reviews/*", roles: READ_ROLES, app: app("resenas", "operate"), label: "Reseñas" },
  { method: "GET", path: "/api/v1/properties/:propertyId/reviews", roles: READ_ROLES, app: app("resenas", "operate"), label: "Reseñas" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/reviews/*", roles: ADMIN_ROLES, app: app("resenas", "write"), label: "Reseñas" },
  { method: "POST", path: "/api/v1/properties/:propertyId/reviews", roles: ADMIN_ROLES, app: app("resenas", "write"), label: "Reseñas" },
  { method: "GET", path: "/api/v1/properties/:propertyId/linkhub/*", roles: READ_ROLES, app: app("linkhub", "operate"), label: "LinkHub" },
  { method: "GET", path: "/api/v1/properties/:propertyId/linkhub", roles: READ_ROLES, app: app("linkhub", "operate"), label: "LinkHub" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/linkhub/*", roles: ADMIN_ROLES, app: app("linkhub", "write"), label: "LinkHub" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/linkhub", roles: ADMIN_ROLES, app: app("linkhub", "write"), label: "LinkHub" },
  { method: "POST", path: "/api/v1/properties/:propertyId/social-hub/alerts/:alertId/read", roles: READ_ROLES, app: app("social-hub", "operate"), label: "Presencia online" },
  { method: "GET", path: "/api/v1/properties/:propertyId/social-hub/*", roles: READ_ROLES, app: app("social-hub", "operate"), label: "Presencia online" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/social-hub/*", roles: ADMIN_ROLES, app: app("social-hub", "write"), label: "Presencia online" },

  // Proxies de reservas e informes (espejo de booking-app)
  { method: "PATCH", path: "/api/v1/properties/:propertyId/reservations/:reservationId/status", roles: STAFF_ROLES, app: app("todas-reservas", "operate"), label: "Reservas" },
  { method: "GET", path: "/api/v1/properties/:propertyId/reservations/*", roles: READ_ROLES, app: app("todas-reservas", "operate"), label: "Reservas" },
  { method: "GET", path: "/api/v1/properties/:propertyId/reservations", roles: READ_ROLES, app: app("todas-reservas", "operate"), label: "Reservas" },
  { method: "GET", path: "/api/v1/properties/:propertyId/reports/*", roles: READ_ROLES, app: app("informes", "operate"), label: "Informes" },
];

// ── booking-app ─────────────────────────────────────────────────────────────
// Espejo 1:1 de los `requireSpaceAccess` de sus routers.
const BOOKING_RULES: RouteRule[] = [
  { method: "GET", path: "/api/v1/availability", access: "public", label: "Disponibilidad pública" },
  { method: "GET", path: "/api/v1/availability/public-calendar", access: "public", label: "Disponibilidad pública" },
  { method: "GET", path: "/api/v1/engine-settings/public", access: "public", label: "Motor (público)" },
  { method: "*", path: "/api/v1/public/*", access: "public", label: "Público" },
  { method: "*", path: "/api/v1/motor/*", access: "deny", label: "Flujo de huésped" },
  { method: "*", path: "/api/v1/internal/*", access: "deny", label: "Interno" },
  { method: "*", path: "/internal/*", access: "deny", label: "Interno" },

  { method: "GET", path: "/api/v1/availability/calendar", app: app("disponibilidad", "operate"), label: "Disponibilidad" },
  { method: "POST", path: "/api/v1/availability/initialize", app: app("disponibilidad", "write"), label: "Disponibilidad" },
  { method: "POST", path: "/api/v1/availability/sync/:propertyId", app: app("disponibilidad", "operate"), label: "Disponibilidad" },
  { method: "GET", path: "/api/v1/day-restrictions", app: app("disponibilidad", "operate"), label: "Restricciones por día" },
  { method: "PUT", path: "/api/v1/day-restrictions/bulk", app: app("disponibilidad", "write"), label: "Restricciones por día" },

  { method: "GET", path: "/api/v1/categories", app: app("carga-manual", "operate"), label: "Categorías (motor)" },
  { method: "GET", path: "/api/v1/categories/properties/:propertyId/model-audit", app: app("configuracion", "operate"), label: "Auditoría del modelo" },
  { method: "POST", path: "/api/v1/categories/properties/:propertyId/model-audit/auto-correct", app: app("configuracion", "write"), label: "Auditoría del modelo" },
  { method: "GET", path: "/api/v1/engine-settings", app: app("configuracion", "operate"), label: "Configuración del motor" },
  { method: "PUT", path: "/api/v1/engine-settings", app: app("configuracion", "write"), label: "Configuración del motor" },
  { method: "GET", path: "/api/v1/exchange-rates/*", app: app("configuracion", "operate"), label: "Tipo de cambio" },

  { method: "GET", path: "/api/v1/guests/*", app: app("carga-manual", "operate"), label: "Huéspedes" },
  { method: "*", path: "/api/v1/migrations/*", access: "admin", label: "Migración de reservas" },
  { method: "*", path: "/api/v1/unit-migrations/*", access: "admin", label: "Migración de unidades" },

  { method: "GET", path: "/api/v1/promos/*", app: app("promociones", "operate"), label: "Promociones" },
  { method: "GET", path: "/api/v1/promos", app: app("promociones", "operate"), label: "Promociones" },
  { method: WRITES, path: "/api/v1/promos/*", app: app("promociones", "write"), label: "Promociones" },
  { method: "POST", path: "/api/v1/promos", app: app("promociones", "write"), label: "Promociones" },

  { method: "GET", path: "/api/v1/rate-plans/*", app: app("tarifas", "operate"), label: "Tarifas" },
  { method: "GET", path: "/api/v1/rate-plans", app: app("tarifas", "operate"), label: "Tarifas" },
  { method: WRITES, path: "/api/v1/rate-plans/*", app: app("tarifas", "write"), label: "Tarifas" },
  { method: "POST", path: "/api/v1/rate-plans", app: app("tarifas", "write"), label: "Tarifas" },

  { method: "GET", path: "/api/v1/reports/*", app: app("informes", "operate"), label: "Informes" },
  { method: "*", path: "/api/v1/unit-blocks/*", app: app("todas-reservas", "operate"), label: "Bloqueos de habitación" },
  { method: "*", path: "/api/v1/unit-blocks", app: app("todas-reservas", "operate"), label: "Bloqueos de habitación" },
  { method: "GET", path: "/api/v1/units", app: app("todas-reservas", "operate"), label: "Unidades (motor)" },

  { method: "POST", path: "/api/v1/reservations", app: app("carga-manual", "operate"), label: "Nueva reserva" },
  { method: "PATCH", path: "/api/v1/reservations/:reservationId/charge", app: app("todas-reservas", "write"), label: "Cobro de la reserva" },
  { method: "*", path: "/api/v1/reservations/services/*", app: app("todas-reservas", "operate"), label: "Servicios de la reserva" },
  { method: "*", path: "/api/v1/reservations/*", app: app("todas-reservas", "operate"), label: "Reservas" },
  { method: "GET", path: "/api/v1/reservations", app: app("todas-reservas", "operate"), label: "Reservas" },
];

// ── rooms-app ───────────────────────────────────────────────────────────────
const ROOMS_RULES: RouteRule[] = [
  { method: "GET", path: "/api/v1/public/*", access: "public", label: "Público" },
  { method: "GET", path: "/api/v1/properties/:propertyId/units/*", access: "member", label: "Unidades" },
  { method: "GET", path: "/api/v1/properties/:propertyId/units", access: "member", label: "Unidades" },
  { method: "PATCH", path: "/api/v1/properties/:propertyId/units/:unitId/status", app: app("estado-habitaciones", "operate"), label: "Estado de habitación" },
  { method: "POST", path: "/api/v1/properties/:propertyId/units", app: app("gestion-categorias", "write"), label: "Unidades" },
  { method: ["PATCH", "DELETE"], path: "/api/v1/properties/:propertyId/units/:unitId", app: app("gestion-categorias", "write"), label: "Unidades" },
  { method: "GET", path: "/api/v1/properties/:propertyId/model-audit", app: app("gestion-categorias", "operate"), label: "Auditoría del modelo" },
  { method: "POST", path: "/api/v1/properties/:propertyId/model-audit/*", app: app("gestion-categorias", "write"), label: "Auditoría del modelo" },
  { method: "GET", path: "/api/v1/properties/:propertyId/categories/*", access: "member", label: "Categorías" },
  { method: "GET", path: "/api/v1/properties/:propertyId/categories", access: "member", label: "Categorías" },
  { method: WRITES, path: "/api/v1/properties/:propertyId/categories/*", app: app("gestion-categorias", "write"), label: "Categorías" },
  { method: "POST", path: "/api/v1/properties/:propertyId/categories", app: app("gestion-categorias", "write"), label: "Categorías" },
];

// ── rms-app ─────────────────────────────────────────────────────────────────
const RMS_RULES: RouteRule[] = [
  { method: "*", path: "/internal/*", access: "deny", label: "Interno" },
  { method: "POST", path: "/api/v1/rms/rules/dry-run", app: app("revenue", "operate"), label: "Revenue (simulación)" },
  { method: "GET", path: "/api/v1/rms/*", app: app("revenue", "operate"), label: "Revenue" },
  { method: WRITES, path: "/api/v1/rms/*", app: app("revenue", "write"), label: "Revenue" },
];

// ── staypass ────────────────────────────────────────────────────────────────
// Sólo tiene sentido para el hotelero reenviar emails de reserva; el resto es
// el flujo del huésped o alta de cuentas.
const STAYPASS_RULES: RouteRule[] = [
  { method: "POST", path: "/api/v1/internal/reservations/*", app: app("todas-reservas", "operate"), label: "Emails al huésped" },
  { method: "*", path: "/*", access: "deny", label: "Flujo de huésped" },
];

const RULES: Record<PolicyService, RouteRule[]> = {
  "pms-core": PMS_CORE_RULES,
  "booking-app": BOOKING_RULES,
  "rooms-app": ROOMS_RULES,
  "rms-app": RMS_RULES,
  staypass: STAYPASS_RULES,
};

/** Servicios cuyas rutas con app validan property vs espacio activo (SPACE_PROPERTY_MISMATCH). */
const SPACE_BOUND_SERVICES = new Set<PolicyService>(["booking-app", "rooms-app", "rms-app"]);

// ── Matching ────────────────────────────────────────────────────────────────

/** Normaliza un path/pathTemplate: sin query, sin barra final, `{x}` → `:x`. */
export function normalizePath(raw: string): string {
  let p = raw.trim();
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  p = p.replace(/\{(\w+)\}/g, ":$1");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function methodMatches(rule: RouteRule, method: HttpMethod): boolean {
  if (rule.method === "*") return true;
  if (Array.isArray(rule.method)) return rule.method.includes(method);
  return rule.method === method;
}

function pathMatches(pattern: string, path: string): boolean {
  const pSegs = pattern.split("/").filter(Boolean);
  const segs = path.split("/").filter(Boolean);
  const prefix = pSegs.length > 0 && pSegs[pSegs.length - 1] === "*";
  const fixed = prefix ? pSegs.slice(0, -1) : pSegs;
  if (prefix) {
    // `/a/b/*` = /a/b y cualquier cosa debajo (la colección y sus ítems).
    if (segs.length < fixed.length) return false;
  } else if (segs.length !== fixed.length) {
    return false;
  }
  for (let i = 0; i < fixed.length; i++) {
    const want = fixed[i];
    const got = segs[i];
    if (want.startsWith(":")) {
      // Un placeholder del propio path (`:x`, viene de un pathTemplate) también
      // matchea un placeholder de la regla: la política se evalúa sobre la
      // familia de rutas, no sobre el id concreto.
      if (!got) return false;
      continue;
    }
    if (want !== got) return false;
  }
  return true;
}

/** Primera regla que matchea (las tablas van de lo específico a lo genérico). */
export function findRouteRule(
  service: PolicyService,
  method: HttpMethod,
  path: string,
): RouteRule | undefined {
  const norm = normalizePath(path);
  const rules = RULES[service] ?? [];
  return rules.find((r) => methodMatches(r, method) && pathMatches(r.path, norm));
}

/** propertyId embebido en el path (`/properties/<id>/...`), si lo hay. */
export function propertyIdFromPath(path: string): string | undefined {
  const m = normalizePath(path).match(/\/properties\/([^/]+)/);
  const id = m?.[1];
  if (!id || id.startsWith(":")) return undefined;
  return id;
}

// ── Evaluación ──────────────────────────────────────────────────────────────

export interface AccessTarget {
  service: PolicyService;
  method: HttpMethod;
  path: string;
  /** Propiedad sobre la que opera la llamada (args, path o contexto de sesión). */
  propertyId?: string;
}

const deny = (
  code: NonNullable<AccessDecision["code"]>,
  message: string,
  reason: string,
  rule?: RouteRule,
): AccessDecision => ({ allowed: false, code, message, reason, rule });

const ADMIN_HINT =
  "Un owner/admin de la empresa puede otorgar ese acceso desde Ajustes > Equipo (accesos) o desde el espacio operativo (Usuarios y permisos por app).";

/**
 * Evalúa si el usuario puede ejecutar la llamada. Misma semántica que la
 * cadena authenticate → requireRole → requireCapability → requireSpaceAccess
 * del PMS, más el alcance de propiedades de la membership.
 */
export function evaluateAccess(scope: UserScope, target: AccessTarget): AccessDecision {
  const rule = findRouteRule(target.service, target.method, target.path);
  const isRead = target.method === "GET";
  const label = rule?.label ?? `${target.method} ${normalizePath(target.path)}`;

  if (rule?.access === "public") {
    return { allowed: true, reason: `public:${rule.label}`, rule };
  }
  if (rule?.access === "deny") {
    return deny(
      "endpoint_not_allowed",
      `"${label}" no se puede operar desde el asistente: es un flujo interno o de plataforma que se maneja fuera del chat.`,
      `deny:${rule.label}`,
      rule,
    );
  }

  // Sin perfil del PMS no hay forma de saber qué puede hacer el usuario:
  // no se ejecuta nada que requiera identidad.
  if (!scope.resolved) {
    return deny(
      "scope_unavailable",
      "No pude verificar tus permisos con el PMS en este momento (el servicio de usuarios no respondió). Reintentá en unos segundos; no ejecuto acciones sin poder validarlos.",
      "scope_unavailable",
      rule,
    );
  }
  if (scope.mustChangePassword) {
    return deny(
      "password_change_required",
      "Tu usuario tiene una contraseña temporal pendiente de cambio. Hasta que la cambies en el PMS no se pueden ejecutar acciones ni consultas en tu nombre.",
      "password_change_required",
      rule,
    );
  }
  if (!scope.role) {
    return deny(
      "not_member",
      "Tu usuario no tiene una membresía activa en esta empresa, así que no puedo operar el PMS en tu nombre.",
      "not_member",
      rule,
    );
  }

  // Ruta desconocida: lectura pasa (el PMS aplica su authorize), escritura sólo
  // para owner/admin. Fail-closed para el staff.
  if (!rule) {
    if (isRead || scope.isAdmin) {
      return { allowed: true, reason: isRead ? "unknown_read" : "unknown_write:admin" };
    }
    return deny(
      "unknown_write",
      `La acción "${target.method} ${normalizePath(target.path)}" no está dentro de las que tu usuario puede ejecutar desde el asistente (sólo owner/admin pueden usar escrituras crudas fuera de las apps mapeadas). ${ADMIN_HINT}`,
      "unknown_write:denied",
    );
  }

  if (rule.access === "owner" && scope.role !== "owner") {
    return deny(
      "insufficient_role",
      `"${rule.label}" requiere ser owner de la empresa; tu rol es ${scope.role}.`,
      `owner_only:${rule.label}`,
      rule,
    );
  }
  if (rule.access === "admin" && !scope.isAdmin) {
    return deny(
      "insufficient_role",
      `"${rule.label}" requiere rol owner o admin; tu rol es ${scope.role}. ${ADMIN_HINT}`,
      `admin_only:${rule.label}`,
      rule,
    );
  }
  if (rule.roles && !rule.roles.includes(scope.role as PmsRole)) {
    return deny(
      "insufficient_role",
      `"${rule.label}" requiere rol ${rule.roles.join(" o ")}; tu rol es ${scope.role}. ${ADMIN_HINT}`,
      `role:${rule.label}`,
      rule,
    );
  }
  if (rule.capability && !hasCapability(scope, ...rule.capability)) {
    const caps = rule.capability.map(capabilityLabel).join(" o ");
    return deny(
      "missing_capability",
      `Tu usuario no tiene la capacidad "${caps}" en esta empresa, necesaria para "${rule.label}". ${ADMIN_HINT}`,
      `capability:${rule.capability.join("|")}`,
      rule,
    );
  }
  if (rule.app && !scope.isAdmin) {
    if (!scope.space) {
      return deny(
        "no_active_space",
        `Para "${rule.label}" necesitás un espacio operativo activo con acceso a ${rule.app.ids.map(osAppLabel).join(" o ")}. Seleccioná un espacio operativo en el PMS (o pedile a un admin que te asigne uno).`,
        `no_active_space:${rule.label}`,
        rule,
      );
    }
    const ok = rule.app.ids.some((id) => hasAppAccess(scope, id, rule.app!.level));
    if (!ok) {
      const appNames = rule.app.ids.map(osAppLabel).join(" o ");
      const current = rule.app.ids
        .map((id) => `${osAppLabel(id)}: ${describeAccess(appAccessOf(scope, id))}`)
        .join("; ");
      const need = rule.app.level === "write" ? "permiso de escritura" : "acceso";
      return deny(
        "insufficient_app_access",
        `No tenés ${need} sobre "${appNames}" en tu espacio operativo activo (tu nivel actual: ${current}). ${ADMIN_HINT}`,
        `app:${rule.app.ids.join("|")}:${rule.app.level}`,
        rule,
      );
    }
  }

  // Alcance de propiedades: membership acotada y espacio activo.
  const targetProperty = target.propertyId ?? propertyIdFromPath(target.path);
  if (targetProperty) {
    if (!canSeeProperty(scope, targetProperty)) {
      return deny(
        "property_out_of_scope",
        `Tu usuario no tiene acceso a la propiedad ${targetProperty} (tu membresía está acotada a otras propiedades). ${ADMIN_HINT}`,
        "property_out_of_scope",
        rule,
      );
    }
    if (
      rule.app &&
      !scope.isAdmin &&
      scope.space &&
      SPACE_BOUND_SERVICES.has(target.service) &&
      scope.space.propertyId &&
      scope.space.propertyId !== targetProperty
    ) {
      return deny(
        "space_property_mismatch",
        `Tu espacio operativo activo pertenece a otra propiedad (${scope.space.propertyId}), y "${rule.label}" opera sobre ${targetProperty}. Cambiá de espacio operativo en el PMS para operar esa propiedad.`,
        "space_property_mismatch",
        rule,
      );
    }
  }

  return { allowed: true, reason: `ok:${rule.label}`, rule };
}

export function describeAccess(access: string): string {
  if (access === "write") return "escritura";
  if (access === "operate") return "operar (sin escritura)";
  return "sin acceso";
}

/** Descripción corta del requisito de una regla (para listar en el prompt / consola). */
export function describeRule(rule: RouteRule | undefined): string {
  if (!rule) return "lectura libre / escritura solo owner-admin";
  const parts: string[] = [];
  if (rule.access === "public") return "público";
  if (rule.access === "deny") return "no disponible vía agente";
  if (rule.access === "owner") parts.push("solo owner");
  if (rule.access === "admin") parts.push("solo owner/admin");
  if (rule.access === "member") parts.push("cualquier miembro");
  if (rule.roles) parts.push(`rol ${rule.roles.join("/")}`);
  if (rule.capability) parts.push(`capability ${rule.capability.join("|")}`);
  if (rule.app) parts.push(`app ${rule.app.ids.join("|")} (${rule.app.level})`);
  return parts.join(" + ") || "miembro";
}

/** Exposición de las tablas para tests/consola. */
export function listRouteRules(service?: PolicyService): Array<RouteRule & { service: PolicyService }> {
  const services = service ? [service] : (Object.keys(RULES) as PolicyService[]);
  return services.flatMap((s) => RULES[s].map((r) => ({ ...r, service: s })));
}
