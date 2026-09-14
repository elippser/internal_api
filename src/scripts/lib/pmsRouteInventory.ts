/**
 * Inventario de los endpoints REALES de los microservicios del PMS, leído de
 * los routers del checkout local (no es un monorepo: son repos hermanos).
 *
 * Lo comparten `verify:tool-coverage` (¿cada endpoint tiene tool y regla?) y
 * `test:tools-e2e` (¿el request que arma cada tool pega a una ruta que existe?).
 */
import fs from "fs";
import path from "path";

import {
  normalizePath,
  type HttpMethod,
  type PolicyService,
} from "../../shared/agentAuth/routePolicy";

export const REPO_ROOT =
  process.env.PMS_REPOS_ROOT ?? path.resolve(__dirname, "../../../../..");

export const SERVICES: Array<{ svc: PolicyService; dir: string }> = [
  { svc: "pms-core", dir: "pms-core/api/src" },
  { svc: "booking-app", dir: "booking-app/api/src" },
  { svc: "rooms-app", dir: "rooms-app/api/src" },
  { svc: "rms-app", dir: "rms-app/api/src" },
  { svc: "staypass", dir: "public-side/staypass-app/api/src" },
];

/**
 * Prefijo de montaje por archivo de router. Se escribe a mano porque los
 * `router.use(...)` viven en los index/server de cada servicio y anidan
 * (propertyRouter monta media docena de sub-routers). Si un router nuevo no
 * está acá, se reporta como "sin montaje conocido" en vez de ignorarlo.
 */
export const MOUNTS: Record<string, Record<string, string>> = {
  "pms-core": {
    "sitesRouter.ts": "/site-data",
    "companiesRouter.ts": "/company",
    "usersRouter.ts": "/user",
    "resetPasswordRouter.ts": "/reset-password",
    "chatRouter.ts": "/chat",
    "assetLibraryRouter.ts": "/asset-library",
    "customCatalogRouter.ts": "/custom-catalog",
    "projectRouter.ts": "/project",
    "propertyTemplateRouter.ts": "/api/v1/property-templates",
    "propertyRouter.ts": "/api/v1/properties",
    "serviceCategoryRouter.ts": "/api/v1/service-categories",
    "publicPropertyRouter.ts": "/api/v1/public/properties",
    "publicLinkhubRouter.ts": "/api/v1/public/linkhub",
    "publicSiteRouter.ts": "/api/v1/public/site",
    "siteTemplateRouter.ts": "/api/v1/site-templates",
    "notificationsRouter.ts": "/api/v1/notifications",
    "aiRouter.ts": "/api/v1/ai",
    "searchRouter.ts": "/api/v1/search",
    "inductionRouter.ts": "/api/v1/induction",
    "accessRouter.ts": "/api/v1/access",
    "plansRouter.ts": "/api/v1/plans",
    "inviteRouter.ts": "/api/v1/invite",
    // Anidados bajo propertyRouter
    "unitRouter.ts": "/api/v1/properties/:propertyId/units",
    "operativeSpaceRouter.ts": "/api/v1/properties/:propertyId/spaces",
    "serviceRouter.ts": "/api/v1/properties/:propertyId/services",
    "amenityRouter.ts": "/api/v1/properties/:propertyId/amenities",
    "galleryRouter.ts": "/api/v1/properties/:propertyId/galleries",
    "reviewRouter.ts": "/api/v1/properties/:propertyId/reviews",
    "linkhubRouter.ts": "/api/v1/properties/:propertyId/linkhub",
    "socialHubRouter.ts": "/api/v1/properties/:propertyId/social-hub",
    "reservationProxyRouter.ts": "/api/v1/properties/:propertyId/reservations",
    "reportProxyRouter.ts": "/api/v1/properties/:propertyId/reports",
    "dashboardRouter.ts":
      "/api/v1/properties/:propertyId/spaces/:spaceId/dashboards",
  },
  "booking-app": {
    "availabilityRouter.ts": "/api/v1/availability",
    "categoryRouter.ts": "/api/v1/categories",
    "dayRestrictionRouter.ts": "/api/v1/day-restrictions",
    "engineSettingsRouter.ts": "/api/v1/engine-settings",
    "exchangeRateRouter.ts": "/api/v1/exchange-rates",
    "guestRouter.ts": "/api/v1/guests",
    "migrationRouter.ts": "/api/v1/migrations",
    "promoRouter.ts": "/api/v1/promos",
    "publicPromoRouter.ts": "/api/v1/public",
    "ratePlanRouter.ts": "/api/v1/rate-plans",
    "reportRouter.ts": "/api/v1/reports",
    "rmsInternalRouter.ts": "/internal/rms",
    "unitBlockRouter.ts": "/api/v1/unit-blocks",
    "unitMigrationRouter.ts": "/api/v1/unit-migrations",
    "unitRouter.ts": "/api/v1/units",
    "reservationServicesRouter.ts": "/api/v1",
    "reservationRouter.ts": "/api/v1",
  },
  "rooms-app": {
    "publicRouter.ts": "/api/v1/public/properties",
    "unitRouter.ts": "/api/v1/properties",
    "categoryRouter.ts": "/api/v1/properties",
  },
  "rms-app": {
    "reportsRouter.ts": "/api/v1/rms",
    "configRouter.ts": "/api/v1/rms",
    "paceRouter.ts": "/api/v1/rms",
    "rulesRouter.ts": "/api/v1/rms",
    "eventsRouter.ts": "/api/v1/rms",
    "externalCompetitorsRouter.ts": "/api/v1/rms",
    "adminRouter.ts": "/internal/rms/admin",
  },
  // StayPass es la cuenta del HUÉSPED. Se inventaría igual para que una ruta
  // nueva pensada para el hotel no quede afuera sin que nadie lo decida.
  staypass: {
    "authRouter.ts": "/api/v1/auth",
    "guestRouter.ts": "/api/v1/guest",
    "internalRouter.ts": "/api/v1/internal",
    "reservationsRouter.ts": "/api/v1/reservations",
  },
};

export interface Endpoint {
  svc: PolicyService;
  method: HttpMethod;
  path: string;
  file: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "__tests__", ".next"].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

// No exige `);` de cierre: varias rutas del repo no llevan punto y coma y una
// regex con terminador se come la ruta SIGUIENTE — así se perdían endpoints
// reales (ej. el PUT que guarda los componentes de una página).
const CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)["'`]/g;

function extract(svc: PolicyService, srcDir: string): {
  endpoints: Endpoint[];
  unmounted: string[];
} {
  const endpoints: Endpoint[] = [];
  const unmounted = new Set<string>();
  const mounts = MOUNTS[svc] ?? {};
  for (const file of walk(srcDir)) {
    const base = path.basename(file);
    const text = fs.readFileSync(file, "utf8");
    const re = new RegExp(CALL_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const [, obj, method, routePath] = m;
      if (!/router$/i.test(obj) && obj !== "app") continue;
      const prefix = mounts[base];
      if (prefix === undefined) {
        // Los server.ts sólo definen health checks y el montaje raíz.
        if (base !== "server.ts" && base !== "index.ts") unmounted.add(base);
        continue;
      }
      endpoints.push({
        svc,
        method: method.toUpperCase() as HttpMethod,
        path: normalizePath(prefix + routePath),
        file: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      });
    }
  }
  return { endpoints, unmounted: [...unmounted] };
}

export interface RouteInventory {
  endpoints: Endpoint[];
  unmounted: string[];
  missing: PolicyService[];
}

/** Endpoints únicos de todos los servicios presentes en el checkout. */
export function loadRouteInventory(): RouteInventory {
  const endpoints: Endpoint[] = [];
  const unmounted: string[] = [];
  const missing: PolicyService[] = [];
  for (const { svc, dir } of SERVICES) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) {
      missing.push(svc);
      continue;
    }
    const r = extract(svc, full);
    endpoints.push(...r.endpoints);
    unmounted.push(...r.unmounted.map((f) => `${svc}/${f}`));
  }
  // Un mismo method+path puede aparecer dos veces (routers en el mismo prefijo).
  const seen = new Set<string>();
  const unique = endpoints.filter((e) => {
    const k = `${e.svc} ${e.method} ${e.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { endpoints: unique, unmounted, missing };
}

/** `{propertyId}` / `:propertyId` → `:p`, sin query: comparamos familias. */
export function familyKey(svc: string, method: string, rawPath: string): string {
  const p = normalizePath(rawPath).replace(/:[A-Za-z_]\w*/g, ":p");
  return `${svc} ${method} ${p}`;
}

/**
 * ¿Un path CONCRETO (con IDs reales, como lo arma el ejecutor) pega a una ruta
 * que existe? Un segmento `:param` de la ruta acepta cualquier valor; los
 * literales tienen que coincidir. Express resuelve en orden de declaración,
 * pero para "existe o no existe" alcanza con que alguna matchee.
 */
export function findRoute(
  inventory: RouteInventory,
  svc: string,
  method: string,
  concretePath: string,
): Endpoint | null {
  const clean = normalizePath(concretePath.split("?")[0]);
  const segs = clean.split("/").filter(Boolean);
  for (const e of inventory.endpoints) {
    if (e.svc !== svc || e.method !== method) continue;
    const routeSegs = e.path.split("/").filter(Boolean);
    if (routeSegs.length !== segs.length) continue;
    if (routeSegs.every((r, i) => r.startsWith(":") || r === segs[i])) return e;
  }
  return null;
}
