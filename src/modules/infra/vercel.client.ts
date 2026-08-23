/**
 * Cliente de la REST API de Vercel, acotado a LECTURA.
 *
 * CREDENCIAL: un Access Token de https://vercel.com/account/settings/tokens.
 * Viaja como `Authorization: Bearer`. Vercel no tiene tokens de solo lectura:
 * el mismo token que lista proyectos puede borrarlos. Por eso este archivo no
 * expone un solo metodo de escritura — ni redeploy, ni rollback, ni delete. Si
 * algun dia hace falta, que sea una decision explicita y con su propio piso de
 * rol, no algo que quedo disponible porque el token alcanzaba.
 *
 * LA CUENTA ES GRATIS (Hobby), asi que el presupuesto de llamadas importa:
 *
 *  - El tablero entero sale de DOS requests: `/v9/projects` (que ya trae el
 *    deploy de produccion de cada proyecto adentro, en `targets.production`) y
 *    `/v6/deployments` sin projectId (que trae la actividad de toda la cuenta).
 *    No se pide una llamada por proyecto: con 16 proyectos serian 16 requests
 *    por refresh y la cuenta se queda sin aire sola.
 *  - `infra.service.ts` cachea las respuestas y es el unico que decide cuando
 *    refrescar. Este archivo nunca cachea: pega y devuelve.
 *  - Los headers `x-ratelimit-*` de cada respuesta quedan guardados y se
 *    muestran en el panel. Un 429 activa un enfriamiento y las llamadas
 *    siguientes fallan sin salir a la red hasta que pase: sin eso, una pantalla
 *    con refetch automatico se come el limite y despues no entra nadie.
 */

const API_BASE = "https://api.vercel.com";
const TIMEOUT_MS = 15_000;

/** Error normalizado de Vercel. Conserva el `code` de ellos, que es util. */
export class VercelError extends Error {
  status: number;
  code: string;
  /** El codigo propio de Vercel: `forbidden`, `not_found`, `rate_limited`... */
  vercelCode?: string;

  constructor(status: number, message: string, vercelCode?: string) {
    super(message);
    this.name = "VercelError";
    this.status = status;
    this.code = "vercel_error";
    this.vercelCode = vercelCode;
  }
}

// ---------------------------------------------------------------------------
// Presupuesto de llamadas
// ---------------------------------------------------------------------------

export interface RateLimitSnapshot {
  /** Techo de la ventana, tal como lo declara Vercel en el header. */
  limit: number | null;
  remaining: number | null;
  /** Cuando se reinicia la ventana (ISO). */
  resetAt: string | null;
  /** Cuando se leyo esto (ISO). Sin esto, un `remaining` viejo confunde. */
  readAt: string | null;
  /** Si hay un 429 en curso, hasta cuando no se sale a la red (ISO). */
  cooldownUntil: string | null;
}

let rate: RateLimitSnapshot = {
  limit: null,
  remaining: null,
  resetAt: null,
  readAt: null,
  cooldownUntil: null,
};

export function rateLimit(): RateLimitSnapshot {
  // El enfriamiento vencido no se reporta: seria una alarma que ya no aplica.
  if (rate.cooldownUntil && Date.parse(rate.cooldownUntil) <= Date.now()) {
    rate = { ...rate, cooldownUntil: null };
  }
  return rate;
}

function readRateHeaders(res: Response) {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));

  rate = {
    ...rate,
    limit: Number.isFinite(limit) && limit > 0 ? limit : rate.limit,
    remaining: Number.isFinite(remaining) ? remaining : rate.remaining,
    // El reset viene en segundos epoch. Algunas rutas no lo mandan.
    resetAt:
      Number.isFinite(reset) && reset > 0
        ? new Date(reset * 1000).toISOString()
        : rate.resetAt,
    readAt: new Date().toISOString(),
  };
}

/** Arranca el enfriamiento tras un 429. Por defecto un minuto. */
function startCooldown(res: Response) {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  let until = Date.now() + 60_000;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    until = Date.now() + retryAfter * 1000;
  } else if (Number.isFinite(reset) && reset > 0) {
    until = reset * 1000;
  }
  // Tope de 15 min: un reset raro no puede dejar el modulo mudo media hora.
  until = Math.min(until, Date.now() + 15 * 60_000);
  rate = { ...rate, cooldownUntil: new Date(until).toISOString() };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function token(): string | null {
  const t = process.env.VERCEL_API_TOKEN?.trim();
  return t ? t : null;
}

/**
 * Scope de equipo. En una cuenta personal (Hobby) va vacio y NO se manda: con
 * un `teamId` de un equipo al que el token no pertenece, Vercel devuelve 403 en
 * todo y parece que el token esta mal.
 */
function teamId(): string | null {
  const t = process.env.VERCEL_TEAM_ID?.trim();
  return t ? t : null;
}

export function isConfigured(): boolean {
  return token() !== null;
}

/** Agrega `teamId` a la query sin pisar lo que ya trae el path. */
function withTeam(path: string): string {
  const t = teamId();
  if (!t) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(t)}`;
}

async function request<T>(path: string): Promise<T> {
  const t = token();
  if (!t) {
    throw new VercelError(503, "VERCEL_API_TOKEN no esta configurado");
  }

  const cooldown = rateLimit().cooldownUntil;
  if (cooldown) {
    throw new VercelError(
      429,
      `Vercel corto por limite de llamadas. Se reintenta despues de ${new Date(cooldown).toLocaleTimeString("es-AR")}.`,
      "rate_limited",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${withTeam(path)}`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    // 502 y no 500: el que fallo es el upstream, no nosotros.
    throw new VercelError(
      502,
      `No se pudo hablar con Vercel: ${err?.message ?? "error de red"}`,
    );
  }

  readRateHeaders(res);

  if (res.status === 429) {
    startCooldown(res);
    throw new VercelError(
      429,
      "Vercel rechazo la llamada por limite de tasa. La cuenta gratis tiene poco margen: evita refrescar en loop.",
      "rate_limited",
    );
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const e = body?.error ?? {};
    const hint =
      res.status === 401 || res.status === 403
        ? " — revisa que el token no haya vencido y que VERCEL_TEAM_ID corresponda al scope del token (vacio si la cuenta es personal)"
        : "";
    throw new VercelError(
      res.status,
      `${e.message ?? `Vercel respondio ${res.status}`}${hint}`,
      e.code,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Tipos (solo los campos que consumimos)
// ---------------------------------------------------------------------------

/** Estados de un deploy. `readyState` en unas rutas, `state` en otras. */
export type VercelState =
  | "BUILDING"
  | "ERROR"
  | "INITIALIZING"
  | "QUEUED"
  | "READY"
  | "CANCELED";

export interface VercelDeployment {
  uid?: string;
  id?: string;
  name?: string;
  /** Host del deploy, sin protocolo: `xxx-abc123.vercel.app`. */
  url?: string;
  /** Dominios apuntados a este deploy. Es como reconocemos un proyecto. */
  alias?: string[];
  aliasAssigned?: boolean | number;
  state?: VercelState;
  readyState?: VercelState;
  target?: string | null;
  created?: number;
  createdAt?: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string | null;
  creator?: { uid?: string; email?: string; username?: string };
  meta?: Record<string, string>;
}

export interface VercelProject {
  id: string;
  name: string;
  accountId?: string;
  framework?: string | null;
  nodeVersion?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Carpeta del monorepo. Es el match exacto contra el inventario. */
  rootDirectory?: string | null;
  link?: {
    type?: string;
    repo?: string;
    org?: string;
    repoId?: number;
    productionBranch?: string;
  } | null;
  targets?: { production?: VercelDeployment | null } | null;
  latestDeployments?: VercelDeployment[];
  live?: boolean;
}

export interface VercelDomain {
  name: string;
  apexName?: string;
  projectId?: string;
  verified?: boolean;
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
}

export interface VercelUser {
  id?: string;
  uid?: string;
  username?: string;
  email?: string;
  name?: string;
  /** "hobby" | "pro" | "enterprise". Es lo que dice si la cuenta es gratis. */
  billing?: { plan?: string } | null;
  version?: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const vercel = {
  /** Verifica el token y dice de quien es. Es la llamada mas barata que hay. */
  async me(): Promise<VercelUser> {
    const r = await request<{ user: VercelUser }>("/v2/user");
    return r.user;
  },

  /**
   * Todos los proyectos, con su deploy de produccion adentro.
   *
   * `limit=100` en una sola pagina: una cuenta Hobby no llega ni a 20 proyectos
   * y paginar de mas es gastar llamadas. Si algun dia pasa de 100, el panel
   * avisa en vez de mentir (`truncated`).
   */
  async listProjects(): Promise<{ projects: VercelProject[]; truncated: boolean }> {
    const r = await request<{
      projects: VercelProject[];
      pagination?: { next?: number | null; count?: number };
    }>("/v9/projects?limit=100");
    return {
      projects: r.projects ?? [],
      truncated: Boolean(r.pagination?.next),
    };
  },

  /**
   * Actividad de deploys de toda la cuenta.
   *
   * Sin `projectId` a proposito: una sola llamada da el feed completo y ademas
   * el contador de deploys del dia, que es el limite del plan gratis que
   * realmente molesta (100 por dia).
   */
  async listDeployments(opts: {
    limit?: number;
    /** Epoch ms. Solo deploys creados despues. */
    since?: number;
    projectId?: string;
    target?: "production" | "preview";
  } = {}): Promise<VercelDeployment[]> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(100, Math.max(1, opts.limit ?? 20))));
    if (opts.since) params.set("since", String(opts.since));
    if (opts.projectId) params.set("projectId", opts.projectId);
    if (opts.target) params.set("target", opts.target);
    const r = await request<{ deployments: VercelDeployment[] }>(
      `/v6/deployments?${params.toString()}`,
    );
    return r.deployments ?? [];
  },

  /** Dominios de un proyecto. Solo se pide cuando hace falta desempatar. */
  async listProjectDomains(projectId: string): Promise<VercelDomain[]> {
    const r = await request<{ domains: VercelDomain[] }>(
      `/v9/projects/${encodeURIComponent(projectId)}/domains?limit=50`,
    );
    return r.domains ?? [];
  },
};

// ---------------------------------------------------------------------------
// Normalizacion
// ---------------------------------------------------------------------------

/** Deploy ya masticado, con los nombres que usa el panel. */
export interface NormalizedDeployment {
  id: string;
  /** URL completa del deploy (`https://...vercel.app`). */
  url: string | null;
  state: VercelState | "UNKNOWN";
  target: string | null;
  createdAt: string | null;
  readyAt: string | null;
  /** Cuanto tardo el build, en segundos. `null` si sigue corriendo. */
  buildSeconds: number | null;
  aliases: string[];
  inspectorUrl: string | null;
  author: string | null;
  commit: {
    ref: string | null;
    sha: string | null;
    message: string | null;
    author: string | null;
  } | null;
}

function iso(ms?: number | null): string | null {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

export function normalizeDeployment(
  d: VercelDeployment | null | undefined,
  ctx: { projectName?: string; ownerSlug?: string | null } = {},
): NormalizedDeployment | null {
  if (!d) return null;

  const id = d.uid ?? d.id ?? "";
  const createdMs = d.createdAt ?? d.created ?? null;
  const startedMs = d.buildingAt ?? createdMs;
  const readyMs = d.ready ?? null;

  const meta = d.meta ?? {};
  // El prefijo depende del proveedor de git (github/gitlab/bitbucket). Se
  // buscan los tres: un proyecto conectado a GitLab no trae ni un campo
  // `github*` y quedaria sin commit por mirar el prefijo equivocado.
  const pick = (suffix: string): string | null =>
    meta[`github${suffix}`] ??
    meta[`gitlab${suffix}`] ??
    meta[`bitbucket${suffix}`] ??
    null;

  const commitSha = pick("CommitSha");
  const commit = commitSha
    ? {
        ref: pick("CommitRef"),
        sha: commitSha,
        message: pick("CommitMessage"),
        author: pick("CommitAuthorName") ?? pick("CommitAuthorLogin"),
      }
    : null;

  // El inspector no siempre viene (`/v9/projects` no lo manda). Se arma solo si
  // sabemos el duenio: sin eso el link daria 404 y es peor que no tenerlo.
  let inspectorUrl = d.inspectorUrl ?? null;
  if (!inspectorUrl && ctx.ownerSlug && ctx.projectName && id) {
    inspectorUrl = `https://vercel.com/${ctx.ownerSlug}/${ctx.projectName}/${id.replace(/^dpl_/, "")}`;
  }

  return {
    id,
    url: d.url ? `https://${d.url}` : null,
    state: d.readyState ?? d.state ?? "UNKNOWN",
    target: d.target ?? null,
    createdAt: iso(createdMs),
    readyAt: iso(readyMs),
    buildSeconds:
      readyMs && startedMs && readyMs > startedMs
        ? Math.round((readyMs - startedMs) / 1000)
        : null,
    aliases: d.alias ?? [],
    inspectorUrl,
    author: d.creator?.username ?? d.creator?.email ?? null,
    commit,
  };
}
