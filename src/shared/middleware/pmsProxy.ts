type TargetService =
  | "pms-core"
  | "booking-app"
  | "rooms-app"
  | "staypass"
  | "rms-app";

const SERVICE_ENV: Record<TargetService, string> = {
  "pms-core": "PMS_CORE_API_URL",
  "booking-app": "BOOKING_API_URL",
  "rooms-app": "ROOMS_API_URL",
  // staypass: hospeda la base de huespedes y las confirmaciones de reserva por
  // email. Sus rutas internas van con X-Internal-Secret; ya no expone endpoints
  // de staff (la config SMTP por hotel se elimino).
  staypass: "STAYPASS_API_URL",
  // rms-app: Hub Revenue (DB propia bookfer_rms). Su authenticateStaff ya acepta
  // AGENT_JWT_SECRET, asi que el JWT delegado funciona igual que en los otros 3.
  "rms-app": "RMS_API_URL",
};

interface PmsRequest {
  service: TargetService;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  // JWT delegado firmado por internal-laupser con AGENT_JWT_SECRET.
  // Si esta presente, va como Authorization: Bearer al PMS y dispara
  // el pipeline authenticate -> authorize -> membership real del usuario.
  // Si no, la request solo pasa para endpoints publicos del PMS.
  agentJwt?: string;
}

export class PmsProxyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly upstream?: unknown,
  ) {
    super(message);
    this.name = "PmsProxyError";
  }
}

/**
 * El secret que hay que MANDAR a cada servicio.
 *
 * Ojo con esto, que es la trampa más fácil de este archivo: cada servicio
 * guarda en su propio `PMS_INTERNAL_SECRET` el secret que le exige a lo que
 * ENTRA, y son valores distintos entre servicios. Mandar el `PMS_INTERNAL_SECRET`
 * de internal-laupser —que es el que internal le exige a los demás— hace que
 * pms-core lo rechace, porque pms-core espera el suyo.
 *
 * Mientras la cabecera fue sólo un tag de tráfico (`agentTrafficTag`), la
 * diferencia pasaba desapercibida: no autorizaba nada, así que fallar sólo
 * significaba no marcar el request. Desde que hay endpoints con un portón real
 * detrás (las reglas de bloqueo, USERS-ACTIONS-SPEC §20) ya no da igual.
 *
 * `PMS_CORE_INTERNAL_SECRET` es el secret QUE ESPERA pms-core. Si no está
 * configurado se cae al comportamiento anterior, así que nada de lo que ya
 * funcionaba cambia.
 */
function outgoingSecret(service: TargetService): string {
  if (service === "pms-core") {
    const own = process.env.PMS_CORE_INTERNAL_SECRET?.trim();
    if (own) return own;
  }
  return process.env.PMS_INTERNAL_SECRET ?? "";
}

function buildUrl(base: string, path: string, query?: PmsRequest["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function pmsRequest<T = unknown>(req: PmsRequest): Promise<T> {
  const baseEnv = SERVICE_ENV[req.service];
  const base = process.env[baseEnv];
  if (!base) {
    throw new PmsProxyError(500, `${baseEnv} no esta configurado`);
  }

  const url = buildUrl(base, req.path, req.query);
  const secret = outgoingSecret(req.service);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? 10000,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Tag de trafico: el PMS lo usa para marcar req.isAgentRequest = true en
    // analytics/logging. No es mecanismo de autorizacion.
    "X-Internal-Secret": secret,
  };
  if (req.agentJwt) {
    // Identidad delegada: el PMS verifica este JWT con AGENT_JWT_SECRET
    // (incluido en su lista de secrets) y carga el User real para autorizar.
    headers["Authorization"] = `Bearer ${req.agentJwt}`;
  }

  try {
    const res = await fetch(url, {
      method: req.method ?? "GET",
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) {
      throw new PmsProxyError(
        res.status,
        `Upstream ${req.service} respondio ${res.status}`,
        json ?? text,
      );
    }

    return json as T;
  } catch (err) {
    if (err instanceof PmsProxyError) throw err;
    const message =
      err instanceof Error ? err.message : "Error desconocido upstream";
    throw new PmsProxyError(502, `Fallo llamada a ${req.service}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
