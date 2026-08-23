import {
  coolify,
  isConfigured as coolifyConfigured,
  runState,
  type CoolifyApp,
} from "./coolify.client";
import {
  github,
  isConfigured as githubConfigured,
  owner as githubOwner,
  rateLimit as githubRateLimit,
  type GhComparison,
  type GhCommit,
  type GhPull,
  type GhRateLimit,
  type GhRepo,
} from "./github.client";
import {
  INFRA_SERVICES,
  SERVICES_BY_ID,
  hostsOf,
  normalizeName,
  normalizeRepo,
  type InfraService,
  type Provider,
} from "./infra.inventory";
import {
  isConfigured as vercelConfigured,
  normalizeDeployment,
  rateLimit,
  vercel,
  VercelError,
  type NormalizedDeployment,
  type RateLimitSnapshot,
  type VercelDeployment,
  type VercelProject,
  type VercelUser,
} from "./vercel.client";

/**
 * Cruza el inventario del stack con lo que dicen los proveedores.
 *
 * Todo lo que sale de aca es de SOLO LECTURA. El modulo contesta tres
 * preguntas y ninguna mas: que hay corriendo, con que deploy, y cuanto margen
 * queda del plan gratis.
 *
 * PRESUPUESTO DE LLAMADAS. La cuenta de Vercel es Hobby, asi que el cache no es
 * una optimizacion: es lo que hace que el modulo se pueda usar. Un tablero
 * completo cuesta 2 requests y se sirve cacheado durante `PROJECTS_TTL`. El
 * boton de refrescar saltea el TTL pero no el piso de `MIN_REFRESH_MS`, porque
 * el problema real no es el usuario impaciente sino la pestania abierta con
 * refetch automatico.
 */

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const PROJECTS_TTL = 90_000;
const DEPLOYMENTS_TTL = 60_000;
/** Los dominios de un proyecto no cambian nunca. Se piden una vez y listo. */
const DOMAINS_TTL = 15 * 60_000;
const USER_TTL = 10 * 60_000;
/** Piso entre dos refrescos forzados, por mas que se apriete el boton. */
const MIN_REFRESH_MS = 15_000;

interface Entry<T> {
  value: T;
  at: number;
}

/** Los repos cambian mas lento que los deploys y GitHub es mas generoso. */
const REPOS_TTL = 5 * 60_000;

const cache: {
  user: Entry<VercelUser> | null;
  projects: Entry<{ projects: VercelProject[]; truncated: boolean }> | null;
  deployments: Entry<VercelDeployment[]> | null;
  domains: Map<string, Entry<string[]>>;
  coolifyApps: Entry<CoolifyApp[]> | null;
  repos: Entry<GhRepo[]> | null;
} = {
  user: null,
  projects: null,
  deployments: null,
  domains: new Map(),
  coolifyApps: null,
  repos: null,
};

let lastForcedRefresh = 0;

function fresh<T>(entry: Entry<T> | null, ttl: number, force: boolean): T | null {
  if (!entry) return null;
  if (force) return null;
  return Date.now() - entry.at < ttl ? entry.value : null;
}

/**
 * Traduce el `?refresh=1` del panel a un "de verdad hay que salir a la red".
 * Devuelve false si el refresco anterior fue hace menos de MIN_REFRESH_MS.
 */
function shouldForce(requested: boolean): boolean {
  if (!requested) return false;
  if (Date.now() - lastForcedRefresh < MIN_REFRESH_MS) return false;
  lastForcedRefresh = Date.now();
  return true;
}

/** Vacia el cache. Lo usa el smoke para medir el costo real en llamadas. */
export function resetCache() {
  cache.user = null;
  cache.projects = null;
  cache.deployments = null;
  cache.domains.clear();
  cache.coolifyApps = null;
  cache.repos = null;
  lastForcedRefresh = 0;
}

// ---------------------------------------------------------------------------
// Tipos de salida
// ---------------------------------------------------------------------------

/**
 * Estado de un servicio, ya resuelto. Es lo que pinta el semaforo:
 *   ok           produccion en READY
 *   building     hay un build corriendo (BUILDING/QUEUED/INITIALIZING)
 *   error        el ultimo deploy de produccion fallo
 *   canceled     se cancelo el ultimo deploy de produccion
 *   no_deploy    el proyecto existe pero nunca se desplegó a produccion
 *   not_found    el inventario lo espera y no hay proyecto que le corresponda
 *   unlinked     esta en un proveedor que todavia no esta conectado (Coolify)
 */
export type ServiceStatus =
  | "ok"
  | "building"
  | "error"
  | "canceled"
  | "no_deploy"
  | "not_found"
  | "unlinked";

export interface ServiceIssue {
  kind: string;
  severity: "danger" | "warn" | "info";
  message: string;
}

/** Lo que GitHub sabe del repo de un servicio. Sale del listado, sin llamadas
 *  extra: `pushedAt` es lo que permite decir "el repo se movio y el deploy no". */
export interface GitInfo {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
  /** GitHub cuenta issues Y pull requests juntos en este numero. */
  openIssues: number;
  language: string | null;
}

export interface ServiceRow {
  id: string;
  label: string;
  repo: string;
  /** `owner/nombre` del repo, o null si el servicio todavia no tiene remoto. */
  githubRepo: string | null;
  /** Datos vivos del repo. `null` si GitHub no esta conectado o no se encontro. */
  git: GitInfo | null;
  provider: Provider;
  kind: InfraService["kind"];
  stack: string;
  host: string | null;
  extraHosts: string[];
  purpose: string;
  criticality: InfraService["criticality"];
  note?: string;

  status: ServiceStatus;
  /** Como se resolvio que este proyecto es este servicio. Sirve para debug. */
  matchedBy: "root" | "domain" | "name" | null;
  project: {
    id: string;
    name: string;
    framework: string | null;
    rootDirectory: string | null;
    gitRepo: string | null;
    productionBranch: string | null;
    dashboardUrl: string | null;
  } | null;
  production: NormalizedDeployment | null;
  /** Ultimo deploy de cualquier target: delata un push roto que no llego a prod. */
  latest: NormalizedDeployment | null;
  /** Dominios que sabemos que apuntan al proyecto. */
  domains: string[];
  /** `null` cuando no lo pudimos comprobar (Coolify sin conectar, sin deploy). */
  hostAssigned: boolean | null;
  issues: ServiceIssue[];
}

export interface UnmatchedProject {
  id: string;
  name: string;
  framework: string | null;
  rootDirectory: string | null;
  gitRepo: string | null;
  dashboardUrl: string | null;
  production: NormalizedDeployment | null;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Limites conocidos del plan gratis
// ---------------------------------------------------------------------------

/**
 * Los limites del plan Hobby que se sienten en el dia a dia. Estan escritos a
 * mano porque Vercel no los expone por API en Hobby: lo unico que medimos de
 * verdad son los deploys (los contamos del feed). El resto es referencia y esta
 * marcado como tal en la UI — Vercel cambia estos numeros cada tanto.
 */
export const HOBBY_LIMITS = [
  {
    key: "deploys",
    label: "Deploys por dia",
    value: "100",
    note: "Es el que se toca primero cuando se itera fuerte. Abajo esta el contado real.",
  },
  {
    key: "concurrent",
    label: "Builds en paralelo",
    value: "1",
    note: "Con 16 proyectos, un push que toque varios los encola de a uno.",
  },
  {
    key: "commercial",
    label: "Uso comercial",
    value: "No permitido",
    note: "Hobby es para proyectos personales. Cobrarle a un hotel desde aca es motivo de suspension: antes del primer cliente pago hay que pasar a Pro.",
  },
  {
    key: "members",
    label: "Miembros del equipo",
    value: "Solo vos",
    note: "No se puede invitar a nadie a la cuenta sin pasar a Pro.",
  },
] as const;

// ---------------------------------------------------------------------------
// Carga con cache
// ---------------------------------------------------------------------------

async function loadUser(force = false): Promise<VercelUser | null> {
  const hit = fresh(cache.user, USER_TTL, force);
  if (hit) return hit;
  try {
    const user = await vercel.me();
    cache.user = { value: user, at: Date.now() };
    return user;
  } catch {
    // No es fatal: sin el usuario perdemos el slug del inspector, nada mas.
    return cache.user?.value ?? null;
  }
}

async function loadProjects(force: boolean) {
  const hit = fresh(cache.projects, PROJECTS_TTL, force);
  if (hit) return { value: hit, cached: true, at: cache.projects!.at };
  const value = await vercel.listProjects();
  cache.projects = { value, at: Date.now() };
  return { value, cached: false, at: cache.projects.at };
}

async function loadDeployments(force: boolean) {
  const hit = fresh(cache.deployments, DEPLOYMENTS_TTL, force);
  if (hit) return { value: hit, cached: true, at: cache.deployments!.at };
  // 100 es el maximo de la ruta y alcanza para el feed y para contar el dia.
  const value = await vercel.listDeployments({ limit: 100 });
  cache.deployments = { value, at: Date.now() };
  return { value, cached: false, at: cache.deployments.at };
}

/**
 * Dominios de un proyecto. Solo se llama para desempatar proyectos que no
 * matchearon por Root Directory ni por nombre, y con tope: es UNA llamada por
 * proyecto y es exactamente el gasto que el resto del modulo evita.
 */
async function loadDomains(projectId: string): Promise<string[]> {
  const hit = fresh(cache.domains.get(projectId) ?? null, DOMAINS_TTL, false);
  if (hit) return hit;
  try {
    const domains = await vercel.listProjectDomains(projectId);
    const value = domains.map((d) => d.name.toLowerCase());
    cache.domains.set(projectId, { value, at: Date.now() });
    return value;
  } catch {
    // Un 403 sobre un proyecto suelto no puede tumbar el tablero entero.
    cache.domains.set(projectId, { value: [], at: Date.now() });
    return [];
  }
}

/**
 * Los repos del owner. UNA llamada para los 17 servicios, cacheada 5 minutos.
 * Nunca tira: si GitHub falla, el tablero se pinta igual sin la columna de git.
 */
async function loadRepos(force: boolean): Promise<GhRepo[] | null> {
  if (!githubConfigured()) return null;
  const hit = fresh(cache.repos, REPOS_TTL, force);
  if (hit) return hit;
  try {
    const value = await github.listRepos();
    cache.repos = { value, at: Date.now() };
    return value;
  } catch {
    return cache.repos?.value ?? null;
  }
}

/**
 * Indice de repos por nombre completo Y por nombre corto normalizado. El
 * segundo permite reconocer el repo de un servicio que todavia no tiene su
 * `githubRepo` escrito en el inventario.
 */
function indexRepos(repos: GhRepo[]) {
  const byFull = new Map<string, GhRepo>();
  const byName = new Map<string, GhRepo>();
  for (const r of repos) {
    byFull.set(r.fullName.toLowerCase(), r);
    const n = normalizeName(r.name);
    if (!byName.has(n)) byName.set(n, r);
  }
  return { byFull, byName };
}

function gitInfoOf(
  svc: InfraService,
  index: ReturnType<typeof indexRepos> | null,
): GitInfo | null {
  if (!index) return null;
  const r =
    (svc.githubRepo ? index.byFull.get(svc.githubRepo.toLowerCase()) : null) ??
    // Sin `githubRepo` escrito, se prueba por nombre: `rooms-app_api` y
    // `rooms-app-api` normalizan igual, asi que un repo creado despues se
    // reconoce solo.
    index.byName.get(normalizeName(svc.repo.replace(/\//g, "-"))) ??
    svc.nameHints.map((h) => index.byName.get(normalizeName(h))).find(Boolean) ??
    null;
  if (!r) return null;
  return {
    fullName: r.fullName,
    htmlUrl: r.htmlUrl,
    defaultBranch: r.defaultBranch,
    private: r.private,
    archived: r.archived,
    pushedAt: r.pushedAt,
    openIssues: r.openIssues,
    language: r.language,
  };
}

async function loadCoolifyApps(force: boolean): Promise<CoolifyApp[] | null> {
  if (!coolifyConfigured()) return null;
  const hit = fresh(cache.coolifyApps, PROJECTS_TTL, force);
  if (hit) return hit;
  try {
    const value = await coolify.listApplications();
    cache.coolifyApps = { value, at: Date.now() };
    return value;
  } catch {
    return cache.coolifyApps?.value ?? null;
  }
}

// ---------------------------------------------------------------------------
// Matcheo proyecto <-> servicio
// ---------------------------------------------------------------------------

/** Todos los dominios que se le conocen a un proyecto, en minuscula. */
function aliasesOf(p: VercelProject): string[] {
  const out = new Set<string>();
  const add = (d?: VercelDeployment | null) => {
    if (!d) return;
    for (const a of d.alias ?? []) out.add(a.toLowerCase());
  };
  add(p.targets?.production ?? null);
  for (const d of p.latestDeployments ?? []) {
    if (d.target === "production") add(d);
  }
  return [...out];
}

function ownerSlugOf(user: VercelUser | null): string | null {
  // Con equipo, el slug del inspector es el del equipo y no lo tenemos: mejor
  // no armar un link que da 404. Los deploys del feed traen el suyo propio.
  if (process.env.VERCEL_TEAM_ID?.trim()) return null;
  return user?.username ?? null;
}

function dashboardUrl(ownerSlug: string | null, projectName: string): string | null {
  return ownerSlug
    ? `https://vercel.com/${ownerSlug}/${encodeURIComponent(projectName)}`
    : null;
}

interface Match {
  project: VercelProject;
  by: "root" | "domain" | "name";
}

/**
 * Asigna a cada servicio del inventario su proyecto de Vercel.
 *
 * El orden de los criterios NO es arbitrario:
 *   1. Root Directory — es exacto y lo pone el que configura el proyecto.
 *   2. Dominio de produccion — tambien exacto, y es la definicion misma de
 *      "esto es lo que sirve app.bookfer.com".
 *   3. Nombre — ultimo recurso: lo elige una persona y cambia sin avisar.
 *
 * Un proyecto no se puede asignar a dos servicios: el primero que lo reclama se
 * lo queda. Si no, dos filas mostrarian el mismo deploy y una de las dos
 * mentiria.
 */
function matchServices(
  projects: VercelProject[],
  extraDomains: Map<string, string[]>,
): { matches: Map<string, Match>; usedProjectIds: Set<string> } {
  const used = new Set<string>();
  const matches = new Map<string, Match>();

  const byRoot = new Map<string, VercelProject>();
  const byDomain = new Map<string, VercelProject>();
  const byName = new Map<string, VercelProject>();

  for (const p of projects) {
    if (p.rootDirectory) {
      const key = normalizeRepo(p.rootDirectory);
      if (key && !byRoot.has(key)) byRoot.set(key, p);
    }
    for (const a of [...aliasesOf(p), ...(extraDomains.get(p.id) ?? [])]) {
      if (!byDomain.has(a)) byDomain.set(a, p);
    }
    const n = normalizeName(p.name);
    if (!byName.has(n)) byName.set(n, p);
  }

  const claim = (
    svc: InfraService,
    p: VercelProject | undefined,
    by: Match["by"],
  ): boolean => {
    if (!p || used.has(p.id) || matches.has(svc.id)) return false;
    used.add(p.id);
    matches.set(svc.id, { project: p, by });
    return true;
  };

  for (const svc of INFRA_SERVICES) {
    if (svc.provider !== "vercel") continue;
    if (claim(svc, byRoot.get(normalizeRepo(svc.repo)), "root")) continue;
    for (const h of hostsOf(svc)) {
      // Los wildcards no son un dominio que Vercel liste; no se buscan.
      if (h.includes("*")) continue;
      if (claim(svc, byDomain.get(h.toLowerCase()), "domain")) break;
    }
    if (matches.has(svc.id)) continue;
    for (const hint of svc.nameHints) {
      if (claim(svc, byName.get(normalizeName(hint)), "name")) break;
    }
  }

  return { matches, usedProjectIds: used };
}

// ---------------------------------------------------------------------------
// Armado de filas
// ---------------------------------------------------------------------------

const RUNNING_STATES = new Set(["BUILDING", "QUEUED", "INITIALIZING"]);

function statusFrom(prod: NormalizedDeployment | null): ServiceStatus {
  if (!prod) return "no_deploy";
  if (prod.state === "READY") return "ok";
  if (prod.state === "ERROR") return "error";
  if (prod.state === "CANCELED") return "canceled";
  if (RUNNING_STATES.has(prod.state)) return "building";
  return "no_deploy";
}

function buildVercelRow(
  svc: InfraService,
  match: Match | undefined,
  ownerSlug: string | null,
  extraDomains: Map<string, string[]>,
  git: GitInfo | null,
): ServiceRow {
  const base = {
    id: svc.id,
    label: svc.label,
    repo: svc.repo,
    githubRepo: svc.githubRepo,
    git,
    provider: svc.provider,
    kind: svc.kind,
    stack: svc.stack,
    host: svc.host,
    extraHosts: svc.extraHosts ?? [],
    purpose: svc.purpose,
    criticality: svc.criticality,
    ...(svc.note ? { note: svc.note } : {}),
  };

  if (!match) {
    return {
      ...base,
      status: "not_found",
      matchedBy: null,
      project: null,
      production: null,
      latest: null,
      domains: [],
      hostAssigned: null,
      issues: [
        {
          kind: "not_found",
          severity: svc.criticality === "core" ? "danger" : "warn",
          message: `No hay ningun proyecto en Vercel con Root Directory "${svc.repo}", con el dominio ${svc.host ?? "esperado"} ni con un nombre parecido. O falta desplegarlo, o el proyecto existe con otro nombre y hay que agregarlo a nameHints en infra.inventory.ts.`,
        },
      ],
    };
  }

  const p = match.project;
  const ctx = { projectName: p.name, ownerSlug };
  const production = normalizeDeployment(p.targets?.production ?? null, ctx);
  const latest = normalizeDeployment(
    (p.latestDeployments ?? [])[0] ?? p.targets?.production ?? null,
    ctx,
  );
  const domains = [
    ...new Set([...aliasesOf(p), ...(extraDomains.get(p.id) ?? [])]),
  ].sort();

  const issues: ServiceIssue[] = [];
  const status = statusFrom(production);

  if (status === "error") {
    issues.push({
      kind: "production_error",
      severity: "danger",
      message: "El ultimo deploy de produccion fallo. Lo que hay publicado es el anterior.",
    });
  }
  if (status === "no_deploy") {
    issues.push({
      kind: "no_production",
      severity: "warn",
      message: "El proyecto existe pero no tiene un deploy de produccion.",
    });
  }

  // Un build roto que ni siquiera llego a produccion no cambia el semaforo
  // (produccion sigue sana) pero es exactamente lo que hay que ver.
  if (
    latest &&
    production &&
    latest.id !== production.id &&
    latest.state === "ERROR"
  ) {
    issues.push({
      kind: "latest_failed",
      severity: "warn",
      message: `El ultimo build (${latest.target ?? "preview"}) fallo. Produccion sigue con el deploy anterior.`,
    });
  }

  let hostAssigned: boolean | null = null;
  if (svc.host && production) {
    hostAssigned = domains.includes(svc.host.toLowerCase());
    if (!hostAssigned) {
      issues.push({
        kind: "host_not_assigned",
        severity: "warn",
        message: `${svc.host} no figura entre los dominios de este proyecto. Puede ser que el dominio no este agregado en Vercel, o que el CNAME de Cloudflare apunte a otro lado.`,
      });
    }
  }

  // El repo se movio DESPUES del ultimo deploy de produccion: hay trabajo
  // mergeado que no esta publicado. Los 5 minutos de gracia son la ventana
  // normal entre el push y el build; sin ellos todo deploy recien hecho
  // aparecería como atrasado.
  if (
    git?.pushedAt &&
    production?.createdAt &&
    Date.parse(git.pushedAt) > Date.parse(production.createdAt) + 5 * 60_000
  ) {
    issues.push({
      kind: "stale_deploy",
      severity: "info",
      message: `El repo recibio push despues del ultimo deploy de produccion. Puede haber commits sin publicar (el detalle del servicio dice cuantos).`,
    });
  }

  if (git === null && svc.githubRepo === null) {
    issues.push({
      kind: "no_repo",
      severity: "warn",
      message:
        "Este servicio no tiene repositorio en GitHub. Sin repo no se despliega desde git: lo esta subiendo alguien a mano y no queda historial de que se publico.",
    });
  }

  if (match.by === "name") {
    issues.push({
      kind: "weak_match",
      severity: "info",
      message: `Se identifico por el NOMBRE del proyecto (${p.name}), no por su Root Directory ni por su dominio. Es el criterio mas fragil: si el Root Directory fuera "${svc.repo}" el match seria exacto.`,
    });
  }

  return {
    ...base,
    status,
    matchedBy: match.by,
    project: {
      id: p.id,
      name: p.name,
      framework: p.framework ?? null,
      rootDirectory: p.rootDirectory ?? null,
      gitRepo: p.link?.repo ? `${p.link.org ?? ""}/${p.link.repo}` : null,
      productionBranch: p.link?.productionBranch ?? null,
      dashboardUrl: dashboardUrl(ownerSlug, p.name),
    },
    production,
    latest,
    domains,
    hostAssigned,
    issues,
  };
}

function buildCoolifyRow(
  svc: InfraService,
  apps: CoolifyApp[] | null,
  git: GitInfo | null,
): ServiceRow {
  const base = {
    id: svc.id,
    label: svc.label,
    repo: svc.repo,
    githubRepo: svc.githubRepo,
    git,
    provider: svc.provider,
    kind: svc.kind,
    stack: svc.stack,
    host: svc.host,
    extraHosts: svc.extraHosts ?? [],
    purpose: svc.purpose,
    criticality: svc.criticality,
    ...(svc.note ? { note: svc.note } : {}),
  };

  // Sin instancia conectada la fila igual se muestra: el servicio EXISTE y
  // saberlo es la mitad del valor del tablero. Lo que no hacemos es inventarle
  // un estado verde.
  if (!apps) {
    return {
      ...base,
      status: "unlinked",
      matchedBy: null,
      project: null,
      production: null,
      latest: null,
      domains: hostsOf(svc),
      hostAssigned: null,
      issues: [
        {
          kind: "provider_unlinked",
          severity: "info",
          message:
            "Coolify todavia no esta conectado: falta COOLIFY_API_URL y COOLIFY_API_TOKEN en el .env del API. Lo que se ve de este servicio sale del inventario, no de la instancia.",
        },
      ],
    };
  }

  // Match por dominio primero (es lo unico exacto), despues por nombre.
  const hosts = hostsOf(svc).map((h) => h.toLowerCase());
  const app =
    apps.find((a) =>
      (a.fqdn ?? "")
        .toLowerCase()
        .split(",")
        .some((f) => hosts.some((h) => f.includes(h.replace("*.", "")))),
    ) ??
    apps.find((a) =>
      svc.nameHints.some((n) => normalizeName(a.name ?? "") === normalizeName(n)),
    );

  if (!app) {
    return {
      ...base,
      status: "not_found",
      matchedBy: null,
      project: null,
      production: null,
      latest: null,
      domains: hostsOf(svc),
      hostAssigned: null,
      issues: [
        {
          kind: "not_found",
          severity: svc.criticality === "core" ? "danger" : "warn",
          message: "Coolify esta conectado pero no aparece ninguna aplicacion con este dominio ni con este nombre.",
        },
      ],
    };
  }

  const run = runState(app.status);
  const ok = run === "running";

  return {
    ...base,
    status: ok ? "ok" : "error",
    matchedBy: "domain",
    project: {
      id: app.uuid,
      name: app.name ?? svc.label,
      framework: null,
      rootDirectory: null,
      gitRepo: app.gitRepository,
      productionBranch: app.gitBranch,
      dashboardUrl: null,
    },
    production: null,
    latest: null,
    domains: (app.fqdn ?? "").split(",").map((f) => f.trim()).filter(Boolean),
    hostAssigned: null,
    issues: ok
      ? []
      : [
          {
            kind: "container_down",
            severity: "danger",
            message: `El contenedor no esta corriendo (${app.status ?? "sin estado"}).`,
          },
        ],
  };
}

// ---------------------------------------------------------------------------
// API del modulo
// ---------------------------------------------------------------------------

function err(status: number, message: string, code?: string) {
  const e = new Error(message) as Error & { status: number; code?: string };
  e.status = status;
  if (code) e.code = code;
  return e;
}

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  /** `null` mientras no se haya intentado hablar con el (Coolify sin token). */
  ok: boolean | null;
  error: string | null;
  /** Cuenta / instancia, para saber contra que estamos mirando. */
  account: string | null;
  detail: string | null;
  envVars: string[];
  serviceCount: number;
}

export const infraService = {
  /**
   * Estado de los proveedores. NUNCA falla: "sin configurar" es una respuesta
   * valida y es la que se ve el primer dia.
   */
  async status(): Promise<{
    providers: ProviderStatus[];
    github: {
      configured: boolean;
      ok: boolean | null;
      error: string | null;
      account: string | null;
      owner: string;
      repoCount: number | null;
      /** Servicios del inventario sin repo declarado. Se despliegan a mano. */
      servicesWithoutRepo: number;
      envVars: string[];
      rateLimit: GhRateLimit;
    };
    rateLimit: RateLimitSnapshot;
    hobbyLimits: typeof HOBBY_LIMITS;
    serviceCount: number;
  }> {
    const vercelSvc = INFRA_SERVICES.filter((s) => s.provider === "vercel");
    const coolifySvc = INFRA_SERVICES.filter((s) => s.provider === "coolify");

    const v: ProviderStatus = {
      provider: "vercel",
      configured: vercelConfigured(),
      ok: null,
      error: null,
      account: null,
      detail: null,
      envVars: ["VERCEL_API_TOKEN", "VERCEL_TEAM_ID"],
      serviceCount: vercelSvc.length,
    };

    if (v.configured) {
      try {
        const user = await loadUser();
        if (user) {
          v.ok = true;
          v.account = user.username ?? user.email ?? user.id ?? null;
          const plan = user.billing?.plan;
          v.detail = plan ? `plan ${plan}` : "plan hobby (asumido)";
        } else {
          v.ok = false;
          v.error = "El token no fue aceptado por Vercel.";
        }
      } catch (e: any) {
        v.ok = false;
        v.error = e?.message ?? "No se pudo verificar el token";
      }
    }

    const c: ProviderStatus = {
      provider: "coolify",
      configured: coolifyConfigured(),
      ok: null,
      error: null,
      account: null,
      detail: null,
      envVars: ["COOLIFY_API_URL", "COOLIFY_API_TOKEN"],
      serviceCount: coolifySvc.length,
    };

    if (c.configured) {
      try {
        const version = await coolify.version();
        c.ok = true;
        c.account = process.env.COOLIFY_API_URL?.trim() ?? null;
        c.detail = `Coolify ${version}`;
      } catch (e: any) {
        c.ok = false;
        c.error = e?.message ?? "No se pudo hablar con Coolify";
      }
    }

    const g = {
      configured: githubConfigured(),
      ok: null as boolean | null,
      error: null as string | null,
      account: null as string | null,
      owner: githubOwner(),
      repoCount: null as number | null,
      servicesWithoutRepo: INFRA_SERVICES.filter((s) => !s.githubRepo).length,
      envVars: ["GITHUB_API_TOKEN", "GITHUB_OWNER"],
      rateLimit: githubRateLimit(),
    };

    if (g.configured) {
      try {
        const me = await github.me();
        g.ok = true;
        g.account = me.login;
        // Se aprovecha el cache: si el tablero ya corrio, esto no cuesta nada.
        const repos = await loadRepos(false);
        g.repoCount = repos?.length ?? null;
        g.rateLimit = githubRateLimit();
      } catch (e: any) {
        g.ok = false;
        g.error = e?.message ?? "No se pudo verificar el token de GitHub";
      }
    }

    return {
      providers: [v, c],
      github: g,
      rateLimit: rateLimit(),
      hobbyLimits: HOBBY_LIMITS,
      serviceCount: INFRA_SERVICES.length,
    };
  },

  /**
   * El tablero. Dos requests a Vercel (proyectos + deploys) y, solo si quedo
   * algun servicio sin identificar, hasta 6 llamadas mas para resolver
   * dominios. Todo cacheado.
   */
  async overview(opts: { refresh?: boolean } = {}) {
    if (!vercelConfigured()) {
      throw err(
        503,
        "VERCEL_API_TOKEN no esta configurado en el .env del API interno.",
        "not_configured",
      );
    }

    const force = shouldForce(Boolean(opts.refresh));

    const [projectsRes, deploymentsRes, user] = await Promise.all([
      loadProjects(force),
      loadDeployments(force).catch(() => ({
        value: [] as VercelDeployment[],
        cached: false,
        at: Date.now(),
      })),
      loadUser(),
    ]);

    const ownerSlug = ownerSlugOf(user);
    const projects = projectsRes.value.projects;
    const warnings: string[] = [];
    if (projectsRes.value.truncated) {
      warnings.push(
        "La cuenta tiene mas de 100 proyectos y solo se listaron los primeros 100.",
      );
    }

    // --- Pasada 1: Root Directory, dominio del deploy y nombre -------------
    const extraDomains = new Map<string, string[]>();
    // Los dominios ya cacheados de antes entran gratis a la primera pasada.
    for (const [pid, entry] of cache.domains) {
      if (Date.now() - entry.at < DOMAINS_TTL) extraDomains.set(pid, entry.value);
    }

    let { matches, usedProjectIds } = matchServices(projects, extraDomains);

    // --- Pasada 2: pedir dominios de los proyectos que quedaron sueltos ----
    // Solo si hay huerfanos de los dos lados: un servicio sin proyecto Y un
    // proyecto sin servicio. Sin eso no hay nada que desempatar y la llamada
    // seria gasto puro.
    const missingVercel = INFRA_SERVICES.filter(
      (s) => s.provider === "vercel" && !matches.has(s.id),
    );
    const orphanProjects = projects.filter(
      (p) => !usedProjectIds.has(p.id) && !extraDomains.has(p.id),
    );

    if (missingVercel.length > 0 && orphanProjects.length > 0) {
      // Tope duro: 6 llamadas. Es el techo de lo que este modulo esta
      // dispuesto a gastar de una cuenta gratis para resolver un empate.
      const budget = orphanProjects.slice(0, 6);
      if (orphanProjects.length > budget.length) {
        warnings.push(
          `Quedaron ${orphanProjects.length - budget.length} proyecto(s) sin revisar sus dominios para no gastar mas llamadas de la cuenta gratis.`,
        );
      }
      for (const p of budget) {
        extraDomains.set(p.id, await loadDomains(p.id));
      }
      ({ matches, usedProjectIds } = matchServices(projects, extraDomains));
    }

    // --- Filas --------------------------------------------------------------
    const [coolifyApps, repos] = await Promise.all([
      loadCoolifyApps(force),
      loadRepos(force),
    ]);
    const repoIndex = repos ? indexRepos(repos) : null;

    const services: ServiceRow[] = INFRA_SERVICES.map((svc) => {
      const git = gitInfoOf(svc, repoIndex);
      return svc.provider === "vercel"
        ? buildVercelRow(svc, matches.get(svc.id), ownerSlug, extraDomains, git)
        : buildCoolifyRow(svc, coolifyApps, git);
    });

    const unmatched: UnmatchedProject[] = projects
      .filter((p) => !usedProjectIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        framework: p.framework ?? null,
        rootDirectory: p.rootDirectory ?? null,
        gitRepo: p.link?.repo ? `${p.link.org ?? ""}/${p.link.repo}` : null,
        dashboardUrl: dashboardUrl(ownerSlug, p.name),
        production: normalizeDeployment(p.targets?.production ?? null, {
          projectName: p.name,
          ownerSlug,
        }),
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      }));

    // --- Consumo del plan ---------------------------------------------------
    const deployments = deploymentsRes.value;
    const dayAgo = Date.now() - 24 * 3600_000;
    const last24h = deployments.filter(
      (d) => (d.createdAt ?? d.created ?? 0) >= dayAgo,
    );
    const running = deployments.filter((d) =>
      RUNNING_STATES.has(String(d.readyState ?? d.state ?? "")),
    );

    const summary = {
      total: services.length,
      ok: services.filter((s) => s.status === "ok").length,
      error: services.filter((s) => s.status === "error").length,
      building: services.filter((s) => s.status === "building").length,
      notFound: services.filter((s) => s.status === "not_found").length,
      unlinked: services.filter((s) => s.status === "unlinked").length,
      unmatched: unmatched.length,
      withIssues: services.filter((s) => s.issues.length > 0).length,
    };

    return {
      fetchedAt: new Date(projectsRes.at).toISOString(),
      cached: projectsRes.cached,
      /** true cuando se pidio refrescar y el piso de MIN_REFRESH_MS lo freno. */
      refreshThrottled: Boolean(opts.refresh) && !force,
      summary,
      services,
      unmatched,
      quota: {
        deploysLast24h: last24h.length,
        /** Limite del plan Hobby. Escrito a mano: no lo expone la API. */
        deploysPerDayLimit: 100,
        /** `true` si el feed llego al tope: el contador es un piso, no exacto. */
        deployCountIsFloor: deployments.length >= 100,
        buildsRunning: running.length,
        failedLast24h: last24h.filter(
          (d) => (d.readyState ?? d.state) === "ERROR",
        ).length,
      },
      rateLimit: rateLimit(),
      githubRateLimit: githubConfigured() ? githubRateLimit() : null,
      warnings,
    };
  },

  /**
   * Detalle de un servicio: historial de deploys, dominios y estado del repo.
   *
   * Es la unica pantalla que paga llamadas extra (hasta 2 a Vercel y 3 a
   * GitHub), y por eso es una pagina que se abre a proposito, de a un servicio.
   */
  async detail(id: string, opts: { limit?: number } = {}) {
    const svc = SERVICES_BY_ID.get(id);
    if (!svc) throw err(404, `No existe el servicio "${id}" en el inventario`, "not_found");

    const overview = await this.overview();
    const row = overview.services.find((s) => s.id === id)!;

    // El repo se resuelve aunque el servicio no este en Vercel: web-renderer
    // vive en Coolify y su repo importa igual.
    const git = await this.repoDetail(row);

    if (!row.project || svc.provider !== "vercel") {
      return { service: row, deployments: [], domains: row.domains, git };
    }

    const ownerSlug = ownerSlugOf(await loadUser());
    const raw = await vercel.listDeployments({
      projectId: row.project.id,
      limit: Math.min(20, Math.max(1, opts.limit ?? 10)),
    });

    const deployments = raw
      .map((d) => normalizeDeployment(d, { projectName: row.project!.name, ownerSlug }))
      .filter((d): d is NormalizedDeployment => d !== null);

    // El detalle SI paga la llamada de dominios: es una pantalla que se abre a
    // proposito, de a un servicio, y es donde importa el dato exacto.
    const domains = await loadDomains(row.project.id);

    return { service: row, deployments, domains, git };
  },

  /**
   * Estado del repo de UN servicio: ultimos commits, PRs abiertos y cuantos
   * commits quedaron sin desplegar.
   *
   * La comparacion es la parte que vale: `compare(shaDesplegado, rama)` dice
   * exactamente cuanto trabajo hay mergeado y sin publicar. Si el commit
   * desplegado ya no existe (force-push) GitHub devuelve 404 y se informa como
   * "no comparable" en vez de romper la pantalla.
   */
  async repoDetail(row: ServiceRow): Promise<{
    configured: boolean;
    repo: GitInfo | null;
    commits: GhCommit[];
    pulls: GhPull[];
    comparison: (GhComparison & { deployedSha: string }) | null;
    error: string | null;
  }> {
    if (!githubConfigured() || !row.git) {
      return {
        configured: githubConfigured(),
        repo: row.git,
        commits: [],
        pulls: [],
        comparison: null,
        error: null,
      };
    }

    const full = row.git.fullName;
    const branch = row.git.defaultBranch;
    const deployedSha = row.production?.commit?.sha ?? null;

    try {
      const [commits, pulls, comparison] = await Promise.all([
        github.listCommits(full, { branch, limit: 10 }),
        github.listOpenPulls(full),
        deployedSha
          ? github
              .compare(full, deployedSha, branch)
              .then((c) => (c ? { ...c, deployedSha } : null))
          : Promise.resolve(null),
      ]);
      return {
        configured: true,
        repo: row.git,
        commits,
        pulls,
        comparison,
        error: null,
      };
    } catch (e: any) {
      // GitHub caido no puede tumbar el detalle: el resto de la pantalla
      // (deploys, dominios) sigue siendo util.
      return {
        configured: true,
        repo: row.git,
        commits: [],
        pulls: [],
        comparison: null,
        error: e?.message ?? "No se pudo leer el repositorio",
      };
    }
  },

  /**
   * Tablero de repositorios: los 17 del inventario cruzados con GitHub, mas los
   * repos de la organizacion que no corresponden a ningun servicio.
   *
   * Cuesta UNA llamada (el listado), cacheada 5 minutos.
   */
  async repos(opts: { refresh?: boolean } = {}) {
    if (!githubConfigured()) {
      throw err(
        503,
        "GITHUB_API_TOKEN no esta configurado en el .env del API interno.",
        "not_configured",
      );
    }

    const force = shouldForce(Boolean(opts.refresh));
    // Se mira el sello ANTES y DESPUES para saber si de verdad salio a la red:
    // decir "desde cache" cuando no lo fue es una mentira chica pero es una
    // mentira, y este panel se lee justamente para saber que tan fresco es.
    const stampBefore = cache.repos?.at ?? 0;
    const list = await loadRepos(force);
    if (!list) throw err(502, "No se pudo listar los repositorios de GitHub");
    const cached = (cache.repos?.at ?? 0) === stampBefore;

    const index = indexRepos(list);
    const claimed = new Set<string>();

    const services = INFRA_SERVICES.map((svc) => {
      const git = gitInfoOf(svc, index);
      if (git) claimed.add(git.fullName.toLowerCase());
      return {
        id: svc.id,
        label: svc.label,
        repo: svc.repo,
        provider: svc.provider,
        criticality: svc.criticality,
        /** Lo que dice el inventario, aunque GitHub no lo encuentre. */
        declared: svc.githubRepo,
        git,
        /** El inventario declara un repo que GitHub no tiene (o no ve). */
        missing: Boolean(svc.githubRepo) && git === null,
        /** No hay repo declarado ni encontrado: se despliega a mano. */
        unlinked: !svc.githubRepo && git === null,
      };
    });

    const orphans = list.filter((r) => !claimed.has(r.fullName.toLowerCase()));

    return {
      owner: githubOwner(),
      fetchedAt: new Date(cache.repos?.at ?? Date.now()).toISOString(),
      cached,
      refreshThrottled: Boolean(opts.refresh) && !force,
      summary: {
        total: list.length,
        linked: services.filter((s) => s.git).length,
        unlinked: services.filter((s) => s.unlinked).length,
        missing: services.filter((s) => s.missing).length,
        orphans: orphans.length,
        archived: list.filter((r) => r.archived).length,
        publicRepos: list.filter((r) => !r.private).length,
      },
      services,
      orphans,
      rateLimit: githubRateLimit(),
    };
  },

  /** Feed de deploys de toda la cuenta. Sale del mismo cache del tablero. */
  async activity(opts: { limit?: number; refresh?: boolean } = {}) {
    if (!vercelConfigured()) {
      throw err(503, "VERCEL_API_TOKEN no esta configurado.", "not_configured");
    }

    const force = shouldForce(Boolean(opts.refresh));
    const [{ value: raw, at, cached }, user, projectsRes] = await Promise.all([
      loadDeployments(force),
      loadUser(),
      loadProjects(false).catch(() => null),
    ]);

    const ownerSlug = ownerSlugOf(user);
    // El nombre del proyecto viene en el deploy, pero el id del inventario no:
    // se resuelve por nombre para que cada fila enlace a su servicio.
    const serviceByProjectName = new Map<string, string>();
    if (projectsRes) {
      const { matches } = matchServices(projectsRes.value.projects, new Map());
      for (const [serviceId, m] of matches) {
        serviceByProjectName.set(m.project.name, serviceId);
      }
    }

    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const items = raw.slice(0, limit).map((d) => {
      const n = normalizeDeployment(d, { projectName: d.name, ownerSlug })!;
      return {
        ...n,
        project: d.name ?? null,
        serviceId: d.name ? (serviceByProjectName.get(d.name) ?? null) : null,
      };
    });

    return {
      fetchedAt: new Date(at).toISOString(),
      cached,
      total: raw.length,
      items,
      rateLimit: rateLimit(),
    };
  },
};

export { VercelError };
