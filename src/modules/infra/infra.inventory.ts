/**
 * Inventario de los servicios desplegados del stack.
 *
 * Es la lista de lo que TIENE que estar corriendo, escrita a mano. El proveedor
 * (Vercel, Coolify) es la fuente de verdad de COMO esta cada uno; este archivo
 * es la fuente de verdad de CUALES son y de quien es cada uno.
 *
 * Sale de tres lugares que ya existian y que ahora quedan cruzados aca:
 *   - el mapa de dominios de DNS-CLOUDFLARE-BOOKFER.md (y dns.inventory.ts),
 *   - los .env.production de cada repo,
 *   - URLS_LOCAL.md en la raiz del monorepo.
 *
 * Si sumas un servicio al stack va ACA, ademas del registro DNS. Un proyecto en
 * Vercel que no matchee ninguna fila de esta lista aparece en el panel como
 * "sin identificar", que es exactamente lo que queremos ver: o falta la fila, o
 * es un proyecto viejo que hay que borrar.
 */

export type Provider = "vercel" | "coolify";

/** Que es la pieza. Cambia el icono y como se lee la fila, nada mas. */
export type ServiceKind = "web" | "api" | "service";

export interface InfraService {
  /** Id estable del panel. NO es el id del proyecto en Vercel. */
  id: string;
  label: string;
  /** Ruta dentro del checkout local. En Vercel es el "Root Directory". */
  repo: string;
  /**
   * Repositorio en GitHub, `owner/nombre`.
   *
   * Cada app es su PROPIO repo, no un directorio de un monorepo, y los nombres
   * no siguen una sola convencion (`core-app-app`, `rooms-app_app`,
   * `public-side_web-renderer`): salen del `remote.origin.url` real de cada
   * checkout, por eso estan escritos a mano.
   *
   * `null` = todavia no tiene remoto. No es un detalle menor: sin repo en
   * GitHub, ese servicio NO se puede desplegar desde git y alguien lo esta
   * subiendo a mano.
   */
  githubRepo: string | null;
  provider: Provider;
  kind: ServiceKind;
  /** Runtime, para saber que se rompe cuando se rompe. */
  stack: string;
  /** Hostname productivo. `null` = no se publica (red interna). */
  host: string | null;
  /** Otros hostnames que sirve el mismo deploy (wildcards de preview, etc). */
  extraHosts?: string[];
  purpose: string;
  /**
   * Nombres candidatos del proyecto en Vercel, en orden de preferencia. Se usan
   * como ULTIMO recurso: primero se matchea por Root Directory y por dominio,
   * que son exactos. Los nombres los elige quien crea el proyecto y cambian.
   */
  nameHints: string[];
  /**
   * `core` = si esto esta caido, la plataforma esta caida.
   * `support` = duele pero el hotelero sigue trabajando.
   */
  criticality: "core" | "support";
  note?: string;
}

/**
 * Los 17 deploys del stack. El orden es el de lectura del panel: primero lo que
 * ve el hotelero (PMS), despues los verticales, despues lo publico, al final lo
 * interno. No es alfabetico a proposito.
 */
export const INFRA_SERVICES: InfraService[] = [
  // --- PMS ---------------------------------------------------------------
  {
    id: "pms-app",
    label: "PMS",
    repo: "pms-core/app",
    githubRepo: "Bookfer/core-app-app",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "app.bookfer.com",
    purpose: "El PMS que usa el staff del hotel",
    nameHints: ["pms-core-app", "pms-app", "pms-core", "app"],
    criticality: "core",
  },
  {
    id: "pms-api",
    label: "API del PMS",
    repo: "pms-core/api",
    githubRepo: "Bookfer/core-app-api",
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api.bookfer.com",
    purpose: "API principal: cuentas, propiedades, huespedes, tarifas",
    nameHints: ["pms-core-api", "pms-api", "api"],
    criticality: "core",
  },

  // --- Reservas ----------------------------------------------------------
  {
    id: "booking-web",
    label: "Reservas (staff)",
    repo: "booking-app/web",
    githubRepo: "Bookfer/booking-app-app",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "booking.bookfer.com",
    purpose: "El hub de reservas embebido en el PMS, basePath /reservas",
    nameHints: ["booking-app-web", "booking-web", "booking"],
    criticality: "core",
    note: "Se sirve dentro del PMS en un iframe cross-origin: si cae, el PMS abre pero /reservas queda en blanco.",
  },
  {
    id: "booking-engine",
    label: "Motor de reservas",
    repo: "booking-app/web-engine-public",
    githubRepo: "Bookfer/app-booking-public",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "web-booking.bookfer.com",
    purpose: "El motor publico donde reserva el huesped",
    nameHints: [
      "booking-app-web-engine-public",
      "web-engine-public",
      "web-booking",
    ],
    criticality: "core",
    note: "Es lo unico del stack que factura solo. Caido = reservas perdidas.",
  },
  {
    id: "booking-api",
    label: "API de reservas",
    repo: "booking-app/api",
    githubRepo: "Bookfer/booking-app-api",
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api-booking.bookfer.com",
    purpose: "Disponibilidad, locks y reservas",
    nameHints: ["booking-app-api", "booking-api", "api-booking"],
    criticality: "core",
  },

  // --- Habitaciones ------------------------------------------------------
  {
    id: "rooms-web",
    label: "Habitaciones",
    repo: "rooms-app/web",
    githubRepo: "Bookfer/rooms-app_app",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "rooms.bookfer.com",
    purpose: "Hub de habitaciones embebido en el PMS, basePath /habitaciones",
    nameHints: ["rooms-app-web", "rooms-web", "rooms"],
    criticality: "core",
  },
  {
    id: "rooms-api",
    label: "API de habitaciones",
    repo: "rooms-app/api",
    githubRepo: "Bookfer/rooms-app_api",
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api-rooms.bookfer.com",
    purpose: "Inventario, tipos de unidad y housekeeping",
    nameHints: ["rooms-app-api", "rooms-api", "api-rooms"],
    criticality: "core",
  },

  // --- Revenue -----------------------------------------------------------
  {
    id: "rms-web",
    label: "Revenue (RMS)",
    repo: "rms-app/web",
    githubRepo: null,
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "revenue.bookfer.com",
    purpose: "Hub de revenue management, basePath /revenue",
    nameHints: ["rms-app-web", "rms-web", "revenue"],
    criticality: "support",
  },
  {
    id: "rms-api",
    label: "API del RMS",
    repo: "rms-app/api",
    githubRepo: null,
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api-revenue.bookfer.com",
    purpose: "Pickup, pace, compset y recomendaciones de precio",
    nameHints: ["rms-app-api", "rms-api", "api-revenue"],
    criticality: "support",
  },

  // --- Huesped -----------------------------------------------------------
  {
    id: "staypass-web",
    label: "StayPass",
    repo: "public-side/staypass-app/web",
    githubRepo: "Bookfer/public-side_staypass-app_app",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "staypass.bookfer.com",
    purpose: "Portal del huesped: su reserva, su estadia, sus extras",
    nameHints: ["staypass-app-web", "staypass-web", "staypass"],
    criticality: "support",
  },
  {
    id: "staypass-api",
    label: "API de StayPass",
    repo: "public-side/staypass-app/api",
    githubRepo: "Bookfer/public-side_staypass-app_api",
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api-staypass.bookfer.com",
    purpose: "Autenticacion del huesped y datos de su estadia",
    nameHints: ["staypass-app-api", "staypass-api", "api-staypass"],
    criticality: "support",
  },

  // --- Publico -----------------------------------------------------------
  {
    id: "mkt-renderer",
    label: "Sitio de bookfer",
    repo: "public-side/mkt-renderer",
    githubRepo: null,
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "bookfer.com",
    extraHosts: ["www.bookfer.com"],
    purpose: "El sitio comercial. Se edita desde Marketing > Sitio",
    nameHints: ["mkt-renderer", "bookfer", "mkt"],
    criticality: "support",
    note: "El panel edita este repo por filesystem: publicar un cambio dispara un deploy real aca.",
  },
  {
    id: "linkhub-renderer",
    label: "LinkHub",
    repo: "public-side/linkhub-renderer",
    githubRepo: "Bookfer/public-side_linkhub-renderer",
    provider: "vercel",
    kind: "web",
    stack: "Next.js",
    host: "links.bookfer.com",
    purpose: "El link-in-bio publico de cada hotel",
    nameHints: ["linkhub-renderer", "linkhub", "links"],
    criticality: "support",
  },
  {
    id: "web-renderer",
    label: "Sitios de hoteles",
    repo: "public-side/web-renderer",
    githubRepo: "Bookfer/public-side_web-renderer",
    provider: "coolify",
    kind: "web",
    stack: "Next.js (Docker)",
    host: "sites.bookfer.com",
    extraHosts: ["*.sites.bookfer.com"],
    purpose: "Renderer multi-tenant de los sitios web de cada hotel",
    nameHints: ["web-renderer"],
    criticality: "core",
    note: "El unico que NO esta en Vercel. Necesita el wildcard *.sites y ser el target CNAME de los dominios propios de los hoteles: las dos cosas piden DNS en gris y certificado propio (Traefik), que en Vercel no sale gratis.",
  },

  // --- Interno -----------------------------------------------------------
  {
    id: "internal-web",
    label: "Panel interno",
    repo: "internal-laupser/web",
    githubRepo: null,
    provider: "vercel",
    kind: "web",
    stack: "Vite (SPA)",
    host: "internal.bookfer.com",
    purpose: "Este panel",
    nameHints: ["internal-laupser-web", "internal-web", "internal"],
    criticality: "support",
  },
  {
    id: "internal-api",
    label: "API interna",
    repo: "internal-laupser/api",
    githubRepo: null,
    provider: "vercel",
    kind: "api",
    stack: "Express",
    host: "api-internal.bookfer.com",
    purpose: "API de este panel + motor agentico",
    nameHints: ["internal-laupser-api", "internal-api", "api-internal"],
    criticality: "support",
    note: "Es quien responde esta misma pantalla. Si lo ves caido aca, no lo esta.",
  },
  {
    id: "trends-service",
    label: "Trends",
    repo: "internal-laupser/trends-service",
    githubRepo: null,
    provider: "coolify",
    kind: "service",
    stack: "Python (Docker)",
    host: null,
    purpose: "Scraping de Google Trends para el radar de demanda",
    nameHints: ["trends-service", "trends"],
    criticality: "support",
    note: "Sin hostname publico A PROPOSITO: no tiene autenticacion y solo lo consume api-internal. Va por red interna (http://trends-service:8700). Ver FORBIDDEN_HOSTS en dns.inventory.",
  },
];

export const SERVICES_BY_ID = new Map(INFRA_SERVICES.map((s) => [s.id, s]));

/** Todos los hostnames que sirve un servicio, sin los null. */
export function hostsOf(s: InfraService): string[] {
  return [s.host, ...(s.extraHosts ?? [])].filter((h): h is string => !!h);
}

/**
 * Normaliza un nombre para comparar: minusculas y sin separadores. Asi
 * `pms-core-app`, `pms_core_app` y `PmsCoreApp` son el mismo nombre.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Root Directory tal como lo guarda Vercel: sin `./` ni barra final. */
export function normalizeRepo(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
}
