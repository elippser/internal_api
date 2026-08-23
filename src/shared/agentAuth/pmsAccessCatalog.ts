/**
 * Catálogo de ACCESO del PMS, espejado en el runtime del agente.
 *
 * pms-core es la fuente de verdad de dos catálogos que gobiernan qué puede
 * hacer un usuario (ver memoria `company-capabilities-model`):
 *
 *   - Apps de espacio operativo (`constants/appCatalog.ts` → OS_APP_IDS): dónde
 *     puede OPERAR. Cada usuario tiene, en su espacio activo, un nivel por app
 *     (`operate` | `write` | `none`) que viaja en `spacePermissions`.
 *   - Capacidades de company (`constants/companyCapabilities.ts`): qué puede
 *     ADMINISTRAR en el tenant. Viven en la membership; owner/admin las tienen
 *     todas.
 *
 * Se espejan acá por la misma razón por la que pms-core/app las espeja del
 * api: el agente tiene que hablar de "Tarifas" o "LinkHub" con los mismos
 * nombres que ve el usuario en el PMS y evaluar los mismos ids que exigen
 * `requireSpaceAccess` / `requireCapability`. Si se agrega una app o una
 * capability en pms-core, va acá también.
 */

export const OS_APP_IDS = [
  // Hub Reservas
  "panel-reservas",
  "todas-reservas",
  "carga-manual",
  "tarifas",
  "disponibilidad",
  "promociones",
  "configuracion",
  // Hub Habitaciones
  "estado-habitaciones",
  "plano-ocupacion",
  "gestion-categorias",
  // Builder
  "builder",
  "sitios",
  // Marketing
  "galerias",
  "resenas",
  "marca",
  "linkhub",
  "social-hub",
  // Analítica
  "informes",
  // Hub Revenue
  "revenue",
  // Assets
  "libreria-archivos",
  // Admin
  "propiedades",
] as const;

export type OSAppId = (typeof OS_APP_IDS)[number];

export const OS_APP_ACCESS_LEVELS = ["operate", "write", "none"] as const;
export type OSAppAccess = (typeof OS_APP_ACCESS_LEVELS)[number];

/** Nombre humano de cada app, tal como lo ve el usuario en el menú del PMS. */
export const OS_APP_LABELS: Record<OSAppId, string> = {
  "panel-reservas": "Panel del día (reservas)",
  "todas-reservas": "Reservas (lista y calendario)",
  "carga-manual": "Nueva reserva (carga manual)",
  tarifas: "Tarifas",
  disponibilidad: "Disponibilidad",
  promociones: "Promociones",
  configuracion: "Configuración del motor de reservas",
  "estado-habitaciones": "Estado de habitaciones",
  "plano-ocupacion": "Plano de ocupación",
  "gestion-categorias": "Gestión de categorías y unidades",
  builder: "Builder (editor de sitios web)",
  sitios: "Sitios web (proyectos)",
  galerias: "Galerías",
  resenas: "Reseñas",
  marca: "Identidad de marca",
  linkhub: "LinkHub",
  "social-hub": "Presencia online (redes, Google Business, OTAs)",
  informes: "Informes",
  revenue: "Revenue (RMS)",
  "libreria-archivos": "Librería de archivos",
  propiedades: "Propiedades",
};

export const COMPANY_CAPABILITIES = [
  "users.manage",
  "users.assign_spaces",
  "properties.create",
  "properties.edit",
  "properties.switch",
  "spaces.manage",
  "apps.toggle",
  "company.settings",
  "billing.manage",
  "sites.manage",
] as const;

export type CompanyCapability = (typeof COMPANY_CAPABILITIES)[number];

export const COMPANY_CAPABILITY_LABELS: Record<CompanyCapability, string> = {
  "users.manage": "Gestionar usuarios de la empresa",
  "users.assign_spaces": "Asignar usuarios a espacios operativos",
  "properties.create": "Crear propiedades",
  "properties.edit": "Editar propiedades",
  "properties.switch": "Cambiar de propiedad",
  "spaces.manage": "Gestionar espacios operativos",
  "apps.toggle": "Activar/desactivar apps de los espacios",
  "company.settings": "Ajustes de la empresa",
  "billing.manage": "Plan y facturación",
  "sites.manage": "Web builder (sitios, páginas y publicación)",
};

/** Roles del PMS (User.role / membership.role). */
export const PMS_ROLES = ["owner", "admin", "staff", "viewer", "editor"] as const;
export type PmsRole = (typeof PMS_ROLES)[number];

const APP_SET: ReadonlySet<string> = new Set(OS_APP_IDS);
const CAP_SET: ReadonlySet<string> = new Set(COMPANY_CAPABILITIES);

export const isOsAppId = (v: unknown): v is OSAppId =>
  typeof v === "string" && APP_SET.has(v);
export const isCompanyCapability = (v: unknown): v is CompanyCapability =>
  typeof v === "string" && CAP_SET.has(v);

/** owner/admin administran todo el tenant: bypass de apps y capabilities. */
export const roleIsAdmin = (role?: string | null): boolean =>
  role === "owner" || role === "admin";

export const osAppLabel = (appId: string): string =>
  isOsAppId(appId) ? OS_APP_LABELS[appId] : appId;

export const capabilityLabel = (cap: string): string =>
  isCompanyCapability(cap) ? COMPANY_CAPABILITY_LABELS[cap] : cap;
