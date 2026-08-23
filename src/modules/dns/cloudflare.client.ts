/**
 * Cliente de la API v4 de Cloudflare, acotado a DNS de una zona.
 *
 * CREDENCIAL: un **API Token** (no la Global API Key). El token viaja como
 * `Authorization: Bearer`, esta acotado a la zona de bookfer.com y se puede
 * revocar solo. La Global API Key da acceso total a la cuenta con un header
 * distinto (`X-Auth-Key` + `X-Auth-Email`) y no la soportamos a proposito.
 *
 * Permisos que necesita el token (ver DNS-CLOUDFLARE-BOOKFER.md):
 *   Zone → DNS  → Edit    (leer y escribir registros)
 *   Zone → Zone → Read    (resolver el zoneId por nombre y leer el estado)
 * Zone Resources: Include → Specific zone → bookfer.com
 *
 * NO se reutiliza `CLOUDFLARE_API_TOKEN`: ese es el de Radar (`Account →
 * Radar → Read`) que consume /api/global. Un token de Radar no puede tocar
 * DNS y un token de DNS no deberia poder leer Radar; mezclarlos solo produce
 * 403 crypticos en runtime. Van en variables separadas.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;

/** Error normalizado de Cloudflare: conserva el codigo numerico de ellos. */
export class CloudflareError extends Error {
  status: number;
  code: string;
  cfCode?: number;

  constructor(status: number, message: string, cfCode?: number) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.code = "cloudflare_error";
    this.cfCode = cfCode;
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result_info?: {
    page?: number;
    per_page?: number;
    total_count?: number;
    total_pages?: number;
  };
}

/** Registro DNS tal como lo devuelve Cloudflare (los campos que consumimos). */
export interface CfDnsRecord {
  id: string;
  zone_id?: string;
  zone_name?: string;
  /** FQDN completo: `app.bookfer.com`, no `app`. */
  name: string;
  type: string;
  content: string;
  /** 1 = automatico. Con `proxied: true` Cloudflare lo fuerza a 1. */
  ttl: number;
  /** Solo aplica a A/AAAA/CNAME; en el resto viene `undefined`. */
  proxied?: boolean;
  proxiable?: boolean;
  priority?: number;
  comment?: string | null;
  tags?: string[];
  locked?: boolean;
  created_on?: string;
  modified_on?: string;
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused?: boolean;
  name_servers?: string[];
  original_name_servers?: string[] | null;
  plan?: { id?: string; name?: string };
  account?: { id?: string; name?: string };
}

export interface CfTokenStatus {
  id: string;
  status: string;
  /** `not_before` / `expires_on` vienen solo si el token tiene vigencia. */
  expires_on?: string | null;
}

function token(): string | null {
  const t = process.env.CLOUDFLARE_DNS_API_TOKEN?.trim();
  return t ? t : null;
}

/** Sin token el modulo entero queda deshabilitado (falla cerrado). */
export function isConfigured(): boolean {
  return token() !== null;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<CfEnvelope<T>> {
  const t = token();
  if (!t) {
    throw new CloudflareError(
      503,
      "CLOUDFLARE_DNS_API_TOKEN no esta configurado",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    // Timeout o DNS/red caida. 502 y no 500: el que fallo es el upstream.
    throw new CloudflareError(
      502,
      `No se pudo hablar con Cloudflare: ${err?.message ?? "error de red"}`,
    );
  }

  let body: CfEnvelope<T> | null = null;
  try {
    body = (await res.json()) as CfEnvelope<T>;
  } catch {
    body = null;
  }

  if (!res.ok || !body?.success) {
    const first = body?.errors?.[0];
    // 401/403 de Cloudflare casi siempre son el token: o esta mal copiado, o
    // le falta el permiso, o la zona no esta en su Zone Resources.
    const hint =
      res.status === 401 || res.status === 403
        ? " — revisa que el token tenga Zone:DNS:Edit + Zone:Zone:Read sobre la zona"
        : "";
    throw new CloudflareError(
      res.status === 401 || res.status === 403 ? res.status : (res.status ?? 502),
      `${first?.message ?? `Cloudflare respondio ${res.status}`}${hint}`,
      first?.code,
    );
  }

  return body;
}

export const cloudflare = {
  /** Verifica que el token sea valido y este activo. No consume permisos. */
  async verifyToken(): Promise<CfTokenStatus> {
    const r = await request<CfTokenStatus>("/user/tokens/verify");
    return r.result;
  },

  async getZone(zoneId: string): Promise<CfZone> {
    const r = await request<CfZone>(`/zones/${encodeURIComponent(zoneId)}`);
    return r.result;
  },

  /** Resuelve el zoneId por nombre. Requiere Zone:Zone:Read. */
  async findZoneByName(name: string): Promise<CfZone | null> {
    const r = await request<CfZone[]>(
      `/zones?name=${encodeURIComponent(name)}&per_page=50`,
    );
    return r.result?.find((z) => z.name === name) ?? null;
  },

  /**
   * Trae TODOS los registros de la zona, paginando.
   *
   * Sin filtros del lado de Cloudflare a proposito: la sintaxis de `name.*` y
   * `search` cambio entre versiones de la API y una zona de plataforma tiene
   * decenas de registros, no miles. Filtrar y ordenar en memoria es estable y
   * ademas es lo que necesita la auditoria, que compara contra el inventario
   * completo.
   */
  async listRecords(zoneId: string): Promise<CfDnsRecord[]> {
    const out: CfDnsRecord[] = [];
    let page = 1;
    // Tope duro: 20 paginas x 100 = 2000 registros. Mas que eso es un bug.
    while (page <= 20) {
      const r = await request<CfDnsRecord[]>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100&page=${page}&order=type&direction=asc`,
      );
      out.push(...(r.result ?? []));
      const totalPages = r.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return out;
  },

  /** null si el registro no existe (o es de otra zona). */
  async getRecord(zoneId: string, recordId: string): Promise<CfDnsRecord | null> {
    try {
      const r = await request<CfDnsRecord>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      );
      return r.result;
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return null;
      throw e;
    }
  },

  async createRecord(
    zoneId: string,
    input: Record<string, unknown>,
  ): Promise<CfDnsRecord> {
    const r = await request<CfDnsRecord>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      { method: "POST", body: input },
    );
    return r.result;
  },

  async updateRecord(
    zoneId: string,
    recordId: string,
    input: Record<string, unknown>,
  ): Promise<CfDnsRecord> {
    // PATCH y no PUT: PUT sobreescribe el registro entero y cualquier campo
    // que no mandemos (comment, tags) se pierde en silencio.
    const r = await request<CfDnsRecord>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      { method: "PATCH", body: input },
    );
    return r.result;
  },

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await request<{ id: string }>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      { method: "DELETE" },
    );
  },
};
