import type { Request, Response } from "express";
import { fail, ok } from "../../shared/utils/http";
import { PmsProxyError, pmsRequest } from "../../shared/middleware/pmsProxy";

/**
 * Escudo anti-bot (ANTIBOT-SPEC §7): lo que detectó pms-core y quién está
 * vigilado, frenado o bloqueado.
 *
 * Igual que las reglas de bloqueo, el estado vive en pms-core, que es el único
 * que lo aplica. Acá sólo se lee y se libera.
 */

const SIGNAL = /^[a-z_]{3,40}$/;
const SUBJECT = /^(u|ip):.{1,80}$/;
const STATUS = new Set(["ok", "watch", "throttled", "blocked"]);

function handle(res: Response, err: unknown) {
  if (err instanceof PmsProxyError) {
    const upstream = err.upstream as { error?: string } | undefined;
    return res.status(err.status === 401 ? 502 : err.status).json(upstream ?? { error: err.message });
  }
  console.error("[access/shield] error:", err);
  const msg = err instanceof Error ? err.message : "Error interno";
  return fail(res, 502, `Fallo comunicación con el PMS: ${msg}`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const shieldController = {
  async overview(_req: Request, res: Response) {
    try {
      return ok(res, await pmsRequest({ service: "pms-core", path: "/api/v1/shield/overview" }));
    } catch (err) {
      return handle(res, err);
    }
  },

  async events(req: Request, res: Response) {
    const subject = str(req.query.subject);
    const signal = str(req.query.signal);
    if (subject && !SUBJECT.test(subject)) return fail(res, 400, "Sujeto inválido", "invalid_query");
    if (signal && !SIGNAL.test(signal)) return fail(res, 400, "Señal inválida", "invalid_query");
    try {
      const data = await pmsRequest({
        service: "pms-core",
        path: "/api/v1/shield/events",
        query: { subject, signal, limit: str(req.query.limit) ?? "150" },
      });
      return ok(res, data);
    } catch (err) {
      return handle(res, err);
    }
  },

  async subjects(req: Request, res: Response) {
    const status = str(req.query.status);
    if (status && !STATUS.has(status)) return fail(res, 400, "Estado inválido", "invalid_query");
    try {
      const data = await pmsRequest({
        service: "pms-core",
        path: "/api/v1/shield/subjects",
        query: { status, limit: "200" },
      });
      return ok(res, data);
    } catch (err) {
      return handle(res, err);
    }
  },

  /** De un código de rastreo (`rb…`, visto en un clon o una captura) a la cuenta. */
  async trace(req: Request, res: Response) {
    const code = String(req.params.code || "").trim().toLowerCase();
    if (!/^rb[a-z0-9]{10}$/.test(code)) return fail(res, 400, "Código inválido", "invalid_code");
    try {
      const data = await pmsRequest({ service: "pms-core", path: `/api/v1/shield/trace/${code}` });
      console.info(`[access/shield] ${req.internalUser?.email ?? "?"} resolvió el código ${code}`);
      return ok(res, data);
    } catch (err) {
      return handle(res, err);
    }
  },

  /** Levanta un bloqueo. Es una decisión, no una consulta: piso `admin`. */
  async release(req: Request, res: Response) {
    const subject = str((req.body as { subject?: unknown } | undefined)?.subject);
    if (!subject || !SUBJECT.test(subject)) return fail(res, 400, "Falta el sujeto", "invalid_body");
    try {
      const data = await pmsRequest({
        service: "pms-core",
        method: "POST",
        path: "/api/v1/shield/subjects/release",
        body: { subject },
      });
      console.info(`[access/shield] ${req.internalUser?.email ?? "?"} liberó ${subject}`);
      return ok(res, data);
    } catch (err) {
      return handle(res, err);
    }
  },
};
