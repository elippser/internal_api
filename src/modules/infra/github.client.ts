/**
 * Cliente de la REST API de GitHub, acotado a LECTURA.
 *
 * Cada app del stack es su PROPIO repositorio en la organizacion `Bookfer`
 * (no es un monorepo con submodulos: son 17 repos sueltos). Eso hace que la
 * pregunta "que hay desplegado" no se pueda contestar sin GitHub: Vercel dice
 * que commit publico, y GitHub dice cuantos commits quedaron atras.
 *
 * CREDENCIAL: un Personal Access Token en https://github.com/settings/tokens.
 *   - Fine-grained: acceso a los repos de la org `Bookfer`, permisos
 *     `Contents: Read-only`, `Metadata: Read-only`, `Pull requests: Read-only`.
 *   - Classic: alcanza con el scope `repo` (los repos son privados).
 *
 * Igual que con Vercel, aca no hay un solo metodo de escritura. Crear repos,
 * abrir PRs o mover ramas desde un panel interno es una decision aparte, con su
 * propio piso de rol; que el token lo permita no es razon para exponerlo.
 *
 * PRESUPUESTO: 5.000 llamadas por hora con token (60 sin el). Es diez veces mas
 * holgado que Vercel, pero el modulo igual cachea: el tablero de repos cuesta
 * UNA llamada y el detalle de un servicio dos mas.
 */

const API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;

export class GithubError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.code = "github_error";
  }
}

export interface GhRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  readAt: string | null;
}

let rate: GhRateLimit = {
  limit: null,
  remaining: null,
  resetAt: null,
  readAt: null,
};

export function rateLimit(): GhRateLimit {
  return rate;
}

function token(): string | null {
  const t = process.env.GITHUB_API_TOKEN?.trim();
  return t ? t : null;
}

/** La organizacion (o usuario) duenio de los repos del stack. */
export function owner(): string {
  return process.env.GITHUB_OWNER?.trim() || "Bookfer";
}

export function isConfigured(): boolean {
  return token() !== null;
}

async function request<T>(path: string): Promise<T> {
  const t = token();
  if (!t) throw new GithubError(503, "GITHUB_API_TOKEN no esta configurado");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        // Sin esto GitHub puede cambiar la forma de la respuesta sin avisar.
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "internal-laupser",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new GithubError(
      502,
      `No se pudo hablar con GitHub: ${err?.message ?? "error de red"}`,
    );
  }

  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  rate = {
    limit: Number.isFinite(limit) ? limit : rate.limit,
    remaining: Number.isFinite(remaining) ? remaining : rate.remaining,
    resetAt:
      Number.isFinite(reset) && reset > 0
        ? new Date(reset * 1000).toISOString()
        : rate.resetAt,
    readAt: new Date().toISOString(),
  };

  if (!res.ok) {
    let message = `GitHub respondio ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Sin cuerpo util: queda el status pelado.
    }
    // El 403 de GitHub es casi siempre limite de tasa, no permisos: lo dice el
    // header, no el status. Confundirlos manda a rotar un token que esta bien.
    if (res.status === 403 && rate.remaining === 0) {
      throw new GithubError(
        429,
        `Se agoto el limite de llamadas de GitHub. Se renueva ${rate.resetAt ? new Date(rate.resetAt).toLocaleTimeString("es-AR") : "en una hora"}.`,
      );
    }
    const hint =
      res.status === 401
        ? " — el token esta vencido o mal copiado"
        : res.status === 403
          ? " — al token le falta permiso sobre este repo (Contents/Metadata: Read-only)"
          : res.status === 404
            ? " — el repo no existe o el token no lo ve (si es privado, revisa que la org este en el alcance del token)"
            : "";
    throw new GithubError(res.status, `${message}${hint}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new GithubError(502, "GitHub devolvio una respuesta que no es JSON");
  }
}

// ---------------------------------------------------------------------------
// Tipos (solo lo que consumimos)
// ---------------------------------------------------------------------------

export interface GhRepo {
  /** `Bookfer/core-app-app`. Es la clave con la que se cruza el inventario. */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  /** Ultimo push a CUALQUIER rama. Es gratis: viene en el listado. */
  pushedAt: string | null;
  updatedAt: string | null;
  /** OJO: GitHub cuenta issues Y pull requests juntos en este campo. */
  openIssues: number;
  language: string | null;
  sizeKb: number;
}

export interface GhCommit {
  sha: string;
  message: string;
  author: string | null;
  authoredAt: string | null;
  htmlUrl: string;
}

export interface GhPull {
  number: number;
  title: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  htmlUrl: string;
  base: string;
  head: string;
}

/** Resultado de comparar el commit desplegado contra la cabeza de la rama. */
export interface GhComparison {
  /** Commits que la rama tiene y el deploy no. */
  ahead: number;
  /** Commits que el deploy tiene y la rama no (deploy de otra rama, rebase). */
  behind: number;
  status: string;
  commits: GhCommit[];
  htmlUrl: string;
}

function mapRepo(r: any): GhRepo {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? "",
    private: Boolean(r.private),
    archived: Boolean(r.archived),
    defaultBranch: r.default_branch ?? "main",
    htmlUrl: r.html_url,
    description: r.description ?? null,
    pushedAt: r.pushed_at ?? null,
    updatedAt: r.updated_at ?? null,
    openIssues: r.open_issues_count ?? 0,
    language: r.language ?? null,
    sizeKb: r.size ?? 0,
  };
}

function mapCommit(c: any): GhCommit {
  return {
    sha: c.sha,
    message: (c.commit?.message ?? "").split("\n")[0],
    author: c.commit?.author?.name ?? c.author?.login ?? null,
    authoredAt: c.commit?.author?.date ?? null,
    htmlUrl: c.html_url,
  };
}

export const github = {
  /** Verifica el token y dice de quien es. Es la llamada mas barata. */
  async me(): Promise<{ login: string; name: string | null }> {
    const u = await request<any>("/user");
    return { login: u.login, name: u.name ?? null };
  },

  /**
   * Los repos del owner.
   *
   * Se usa `/orgs/{owner}/repos` y se cae a `/users/{owner}/repos` si el owner
   * resulta ser una cuenta personal: los dos paths existen y devuelven 404 el
   * uno por el otro, asi que probar los dos es mas barato que pedirle al que
   * configura que sepa cual es.
   */
  async listRepos(): Promise<GhRepo[]> {
    const o = encodeURIComponent(owner());
    const out: GhRepo[] = [];
    // 3 paginas = 300 repos. Mas que eso no es este stack.
    for (const base of [`/orgs/${o}/repos`, `/users/${o}/repos`]) {
      try {
        for (let page = 1; page <= 3; page++) {
          const chunk = await request<any[]>(
            `${base}?per_page=100&page=${page}&sort=pushed&direction=desc`,
          );
          out.push(...chunk.map(mapRepo));
          if (chunk.length < 100) break;
        }
        return out;
      } catch (e) {
        if (e instanceof GithubError && e.status === 404) continue;
        throw e;
      }
    }
    throw new GithubError(
      404,
      `No se encontro la organizacion ni el usuario "${owner()}". Revisa GITHUB_OWNER.`,
    );
  },

  async listCommits(
    fullName: string,
    opts: { branch?: string; limit?: number } = {},
  ): Promise<GhCommit[]> {
    const params = new URLSearchParams();
    params.set("per_page", String(Math.min(30, Math.max(1, opts.limit ?? 10))));
    if (opts.branch) params.set("sha", opts.branch);
    const list = await request<any[]>(
      `/repos/${fullName}/commits?${params.toString()}`,
    );
    return list.map(mapCommit);
  },

  async listOpenPulls(fullName: string): Promise<GhPull[]> {
    const list = await request<any[]>(
      `/repos/${fullName}/pulls?state=open&per_page=20&sort=updated&direction=desc`,
    );
    return list.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      draft: Boolean(p.draft),
      htmlUrl: p.html_url,
      base: p.base?.ref ?? "",
      head: p.head?.ref ?? "",
    }));
  },

  /**
   * Cuanto se movio la rama desde el commit desplegado.
   *
   * `base` es el commit que esta en produccion y `head` la rama: `ahead_by` es
   * entonces "cuantos commits estan sin desplegar". null si GitHub no puede
   * comparar (commit borrado por un force-push, o de otra rama).
   */
  async compare(
    fullName: string,
    base: string,
    head: string,
  ): Promise<GhComparison | null> {
    try {
      const c = await request<any>(
        `/repos/${fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      );
      return {
        ahead: c.ahead_by ?? 0,
        behind: c.behind_by ?? 0,
        status: c.status ?? "unknown",
        commits: (c.commits ?? []).slice(-10).reverse().map(mapCommit),
        htmlUrl: c.html_url,
      };
    } catch (e) {
      if (e instanceof GithubError && (e.status === 404 || e.status === 422)) {
        return null;
      }
      throw e;
    }
  },
};
