/**
 * Cliente de la API de Coolify, acotado a LECTURA.
 *
 * ESTADO: la conexion esta armada pero todavia NO se probo contra la instancia
 * real — hoy el unico servicio en Coolify es `public-side/web-renderer` (mas el
 * `trends-service`, que no se publica). Mientras `COOLIFY_API_URL` y
 * `COOLIFY_API_TOKEN` esten vacios, el modulo muestra esos servicios con lo que
 * dice el inventario y una etiqueta de "sin conectar": no inventa un estado.
 *
 * CREDENCIAL: un API Token de la instancia (Keys & Tokens > API tokens), con
 * permiso de lectura. Viaja como `Authorization: Bearer`.
 *
 * CUIDADO CON LA URL: va la RAIZ de la instancia, sin `/api/v1`
 * (`https://coolify.tu-server.com`). El path lo pone este archivo; si la env ya
 * lo trae, se lo saca — pegarlo dos veces da 404 y parece un token invalido.
 *
 * El mapeo de campos de `/applications` esta hecho contra la forma documentada
 * de la API v1 y es DEFENSIVO a proposito: cualquier campo que no venga queda
 * en null y la fila igual se pinta con lo del inventario. Cuando lo apuntemos a
 * la instancia real puede haber que ajustar nombres — que falte un dato no
 * puede tumbar la pantalla entera.
 */

const TIMEOUT_MS = 12_000;

export class CoolifyError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CoolifyError";
    this.status = status;
    this.code = "coolify_error";
  }
}

function baseUrl(): string | null {
  const raw = process.env.COOLIFY_API_URL?.trim();
  if (!raw) return null;
  // Sin barra final y sin `/api/v1`: el path lo agrega `request`.
  return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function token(): string | null {
  const t = process.env.COOLIFY_API_TOKEN?.trim();
  return t ? t : null;
}

/** Hacen falta las dos: una URL sin token no sirve para nada. */
export function isConfigured(): boolean {
  return baseUrl() !== null && token() !== null;
}

async function request<T>(path: string): Promise<T> {
  const base = baseUrl();
  const t = token();
  if (!base || !t) {
    throw new CoolifyError(
      503,
      "COOLIFY_API_URL o COOLIFY_API_TOKEN no estan configurados",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new CoolifyError(
      502,
      `No se pudo hablar con Coolify: ${err?.message ?? "error de red"}`,
    );
  }

  if (!res.ok) {
    const hint =
      res.status === 404
        ? " — revisa que COOLIFY_API_URL sea la raiz de la instancia, SIN /api/v1"
        : res.status === 401 || res.status === 403
          ? " — el token no tiene permiso de lectura o esta vencido"
          : "";
    throw new CoolifyError(res.status, `Coolify respondio ${res.status}${hint}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new CoolifyError(502, "Coolify devolvio una respuesta que no es JSON");
  }
}

/** Aplicacion de Coolify, con los campos que consumimos. */
export interface CoolifyApp {
  uuid: string;
  name: string | null;
  /** Dominio(s) publicados, separados por coma en la API. */
  fqdn: string | null;
  /** `running:healthy`, `exited:unhealthy`, `restarting`... */
  status: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  updatedAt: string | null;
}

/** El primer segmento de `running:healthy`. Es lo que se pinta como estado. */
export function runState(status: string | null): string {
  return (status ?? "").split(":")[0] || "desconocido";
}

export const coolify = {
  /** Ping barato: confirma URL + token sin listar nada. */
  async version(): Promise<string> {
    const r = await request<unknown>("/version");
    // Devuelve un string pelado en unas versiones y `{version}` en otras.
    if (typeof r === "string") return r;
    return (r as { version?: string })?.version ?? "desconocida";
  },

  async listApplications(): Promise<CoolifyApp[]> {
    const raw = await request<unknown>("/applications");
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { data?: unknown[] })?.data ?? []);
    return (list as Record<string, any>[]).map((a) => ({
      uuid: String(a.uuid ?? a.id ?? ""),
      name: a.name ?? null,
      fqdn: a.fqdn ?? a.domains ?? null,
      status: a.status ?? null,
      gitRepository: a.git_repository ?? a.gitRepository ?? null,
      gitBranch: a.git_branch ?? a.gitBranch ?? null,
      updatedAt: a.updated_at ?? a.updatedAt ?? null,
    }));
  },
};
