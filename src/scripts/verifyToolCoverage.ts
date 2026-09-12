/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verifica que Roombir IA llegue a TODA la plataforma.
 *
 * Enumera los routers reales de los cuatro microservicios del PMS y cruza cada
 * endpoint contra dos tablas del runtime del agente:
 *
 *   1) el catálogo de tools (`modules/tools/tools.model.ts`) — ¿hay una tool
 *      dedicada que pegue a ese method+path?
 *   2) la política de acceso (`shared/agentAuth/routePolicy.ts`) — ¿hay una
 *      regla que lo reconozca? Sin regla, la escritura es `unknown_write` y
 *      SOLO la puede hacer un owner/admin: el staff se queda afuera sin que
 *      nada falle ni loguee.
 *
 * Un endpoint que no está en ninguna de las dos y tampoco figura en `EXCLUDED`
 * es un hueco: el agente no puede hacer algo que la app sí hace. Sale con
 * código 1 para que se note.
 *
 * Por qué existe: el catálogo y la política se escriben a mano y se desfasan en
 * silencio. Cuando pms-core suma una ruta, nadie se entera hasta que un
 * hotelero le pide algo al chat y el agente contesta que "no está disponible".
 *
 *   npm run verify:tool-coverage           # resumen + huecos
 *   npm run verify:tool-coverage -- --all  # además lista lo ya cubierto
 *
 * Lee los repos hermanos desde el checkout local (no es un monorepo). Si no
 * están, avisa y sale 0: en CI del propio internal-roombir no hay nada que
 * verificar.
 */
import fs from "fs";
import path from "path";

import { INITIAL_TOOLS } from "../modules/tools/tools.model";
import {
  findRouteRule,
  normalizePath,
  type HttpMethod,
  type PolicyService,
} from "../shared/agentAuth/routePolicy";

// ── Dónde viven los servicios ────────────────────────────────────────────────

const REPO_ROOT =
  process.env.PMS_REPOS_ROOT ?? path.resolve(__dirname, "../../../..");

const SERVICES: Array<{ svc: PolicyService; dir: string }> = [
  { svc: "pms-core", dir: "pms-core/api/src" },
  { svc: "booking-app", dir: "booking-app/api/src" },
  { svc: "rooms-app", dir: "rooms-app/api/src" },
  { svc: "rms-app", dir: "rms-app/api/src" },
];

/**
 * Prefijo de montaje por archivo de router. Se escribe a mano porque los
 * `router.use(...)` viven en los index/server de cada servicio y anidan
 * (propertyRouter monta media docena de sub-routers). Si un router nuevo no
 * está acá, el script lo reporta como "sin montaje conocido" en vez de
 * ignorarlo.
 */
const MOUNTS: Record<string, Record<string, string>> = {
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
};

/**
 * Endpoints que el agente NO debe cubrir, con el motivo. Son cuatro familias:
 * el flujo del huésped (no es el usuario del chat), lo público (no necesita
 * agente), la autenticación (nunca vía agente) y lo server-to-server (lo llaman
 * los servicios entre sí con secret interno, no un hotelero).
 *
 * Es una lista de patrones sobre `<servicio> <METHOD> <path>`; un endpoint
 * nuevo que caiga acá tiene que entrar a propósito, no por olvido.
 */
const EXCLUDED: Array<{ re: RegExp; why: string }> = [
  { re: /^\S+ \S+ \/api\/v1\/public\//, why: "endpoint público" },
  { re: /^pms-core \S+ \/site-data\/(first-available|get-site-for-client|client-data-pages|subsite\/:subSiteId$|custom-hostname\/resolve)/, why: "render público del sitio" },
  { re: /^booking-app \S+ \/api\/v1\/(availability\/public-calendar|engine-settings\/public)/, why: "endpoint público del motor" },
  { re: /^booking-app \S+ \/api\/v1\/motor\//, why: "flujo del huésped" },
  { re: /^\S+ \S+ \/internal\//, why: "server-to-server (secret interno)" },
  { re: /^\S+ \S+ \/api\/v1\/internal\//, why: "server-to-server (secret interno)" },
  { re: /^pms-core \S+ \/api\/v1\/access\/blocks/, why: "lo administra internal-roombir con secret interno" },
  { re: /^pms-core \S+ \/api\/v1\/access\/(session-started|events\/:eventId\/geo)/, why: "telemetría que emite el front" },
  { re: /^pms-core \S+ \/api\/v1\/induction\/(hub|space|app)-/, why: "telemetría de avance que emite el front" },
  { re: /^pms-core \S+ \/api\/v1\/invite\//, why: "alta por invitación (sin sesión)" },
  { re: /^pms-core \S+ \/api\/v1\/notifications\/(auth|ingest|debug-ping)/, why: "transporte de notificaciones" },
  { re: /^pms-core \S+ \/api\/v1\/ai\//, why: "IA del alta (otro agente)" },
  { re: /^pms-core \S+ \/(user\/(login|register|auth0)|reset-password\/)/, why: "autenticación" },
  { re: /^pms-core POST \/user\/change-password/, why: "la contraseña la cambia la persona, nunca el agente" },
  { re: /^pms-core POST \/company\/create/, why: "alta de empresa: va por invitación, fuera del PMS" },
  { re: /^pms-core \S+ \/site-data\/test\//, why: "endpoint de prueba" },
  { re: /^pms-core (POST|PUT|DELETE) \/api\/v1\/site-templates/, why: "plantillas de plataforma (las administra Roombir, no el hotelero)" },
  { re: /^\S+ GET \/(health|healthz|status)$/, why: "health check" },

  // ── Duplicados: la misma acción ya está cubierta por otra ruta ────────────
  { re: /^pms-core PUT \/company$/, why: "duplicado de PUT /company/:companyId (update_company)" },
  { re: /^pms-core PUT \/company\/language$/, why: "duplicado de PUT /company/:companyId/language (set_company_language)" },
  {
    re: /^pms-core \S+ \/api\/v1\/properties\/:propertyId\/units/,
    why: "mismo recurso que rooms-app (misma colección `units`): el agente opera habitaciones con list_units/create_unit/update_unit/change_room_status",
  },
  {
    re: /^pms-core \S+ \/api\/v1\/properties\/:propertyId\/(reservations|reports)/,
    why: "proxy de booking-app: el agente usa las tools de reservas e informes del motor",
  },

  // ── Escrituras que reciben el ÁRBOL ENTERO de componentes ────────────────
  // No se exponen a propósito: pedirle al modelo que reproduzca cientos de KB
  // de JSON sin perder una clave es la forma segura de vaciar una página. El
  // agente edita con las tools quirúrgicas de `builderEditor.ts`, que hacen
  // read-modify-write acá dentro y sólo tocan hojas existentes.
  {
    re: /^pms-core PUT \/site-data\/update\/:subSiteId\/to-page/,
    why: "reemplaza el árbol completo de la página: el agente edita con edit_page_content / move_page_component / remove_page_component",
  },
  {
    re: /^pms-core PUT \/site-data\/update-global\/(top|bottom)-global/,
    why: "reemplaza el árbol completo del encabezado/pie: el agente edita con edit_site_global_content",
  },
  {
    re: /^pms-core PUT \/site-data\/set-template-in-newsite/,
    why: "aplicar una plantilla exige el árbol de componentes de la plantilla: se hace desde el builder",
  },
];

// ── Extracción de rutas ──────────────────────────────────────────────────────

interface Endpoint {
  svc: PolicyService;
  method: HttpMethod;
  path: string;
  file: string;
}

const HTTP: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

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

// ── Cobertura de tools ───────────────────────────────────────────────────────

/** `{propertyId}` / `:propertyId` → `:p`, sin query: comparamos familias. */
function familyKey(svc: string, method: string, rawPath: string): string {
  const p = normalizePath(rawPath).replace(/:[A-Za-z_]\w*/g, ":p");
  return `${svc} ${method} ${p}`;
}

function buildToolIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const t of INITIAL_TOOLS as any[]) {
    const exec = t.execution;
    if (!exec?.pathTemplate || exec.pathTemplate === "{path}") continue;
    const key = familyKey(exec.targetService, exec.method, exec.pathTemplate);
    const list = index.get(key);
    if (list) list.push(t.name);
    else index.set(key, [t.name]);
  }
  return index;
}

// ── Reporte ──────────────────────────────────────────────────────────────────

function excludedReason(key: string): string | null {
  for (const { re, why } of EXCLUDED) if (re.test(key)) return why;
  return null;
}

function main(): void {
  const showAll = process.argv.includes("--all");

  const missingRepos = SERVICES.filter(
    (s) => !fs.existsSync(path.join(REPO_ROOT, s.dir)),
  );
  if (missingRepos.length === SERVICES.length) {
    console.log(
      `⚠ No se encontraron los repos del PMS bajo ${REPO_ROOT}. ` +
        `Definí PMS_REPOS_ROOT para verificar la cobertura. Nada que hacer.`,
    );
    process.exit(0);
  }

  const toolIndex = buildToolIndex();
  const endpoints: Endpoint[] = [];
  const unmounted: string[] = [];
  for (const { svc, dir } of SERVICES) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) {
      console.log(`⚠ ${svc}: no está en el checkout (${dir}) — se saltea`);
      continue;
    }
    const r = extract(svc, full);
    endpoints.push(...r.endpoints);
    unmounted.push(...r.unmounted.map((f) => `${svc}/${f}`));
  }

  // Deduplicar: un mismo method+path puede aparecer dos veces (routers montados
  // en el mismo prefijo).
  const seen = new Set<string>();
  const unique = endpoints.filter((e) => {
    const k = `${e.svc} ${e.method} ${e.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const noTool: Endpoint[] = [];
  const noRule: Endpoint[] = [];
  const excluded: Array<Endpoint & { why: string }> = [];
  const covered: Array<Endpoint & { tools: string[] }> = [];

  for (const ep of unique) {
    const key = `${ep.svc} ${ep.method} ${ep.path}`;
    const why = excludedReason(key);
    if (why) {
      excluded.push({ ...ep, why });
      continue;
    }
    const tools = toolIndex.get(familyKey(ep.svc, ep.method, ep.path));
    if (tools) covered.push({ ...ep, tools });
    else noTool.push(ep);
    if (!findRouteRule(ep.svc, ep.method, ep.path)) noRule.push(ep);
  }

  const line = (e: Endpoint) =>
    `  ${e.svc.padEnd(12)} ${e.method.padEnd(6)} ${e.path}`;

  console.log(
    `\n${unique.length} endpoints · ${covered.length} con tool · ` +
      `${noTool.length} sin tool · ${excluded.length} excluidos a propósito\n`,
  );

  if (unmounted.length) {
    console.log("⚠ Routers sin prefijo de montaje conocido (agregalos a MOUNTS):");
    for (const f of [...new Set(unmounted)]) console.log(`  ${f}`);
    console.log("");
  }

  if (noTool.length) {
    console.log(`✗ SIN TOOL DEDICADA (${noTool.length}) — el agente no llega:`);
    for (const e of noTool) console.log(line(e));
    console.log("");
  }

  if (noRule.length) {
    const writes = noRule.filter((e) => e.method !== "GET");
    console.log(
      `✗ SIN REGLA EN routePolicy (${noRule.length}; ${writes.length} escrituras) — ` +
        `las escrituras sólo las puede hacer owner/admin:`,
    );
    for (const e of noRule) console.log(line(e));
    console.log("");
  }

  if (showAll) {
    console.log(`✓ CUBIERTOS (${covered.length}):`);
    for (const e of covered) console.log(`${line(e)}  → ${e.tools.join(", ")}`);
    console.log(`\n· EXCLUIDOS (${excluded.length}):`);
    for (const e of excluded) console.log(`${line(e)}  — ${e.why}`);
    console.log("");
  }

  // Tools que apuntan a un endpoint que ya no existe: el otro lado del desfase.
  const endpointKeys = new Set(
    unique.map((e) => familyKey(e.svc, e.method, e.path)),
  );
  const stale = (INITIAL_TOOLS as any[]).filter((t) => {
    const exec = t.execution;
    if (!exec?.pathTemplate || exec.pathTemplate === "{path}") return false;
    if (exec.targetService === "staypass") return false; // repo aparte
    if (exec.pathTemplate.startsWith("/ui/")) return false; // acción de cliente
    return !endpointKeys.has(
      familyKey(exec.targetService, exec.method, exec.pathTemplate),
    );
  });
  if (stale.length) {
    console.log(`✗ TOOLS HUÉRFANAS (${stale.length}) — apuntan a rutas que no existen:`);
    for (const t of stale) {
      console.log(
        `  ${t.name.padEnd(38)} ${t.execution.targetService} ${t.execution.method} ${t.execution.pathTemplate}`,
      );
    }
    console.log("");
  }

  const ok = noTool.length === 0 && noRule.length === 0 && stale.length === 0 && unmounted.length === 0;
  console.log(ok ? "✓ Cobertura completa." : "✗ Hay huecos (ver arriba).");
  process.exit(ok ? 0 : 1);
}

main();
