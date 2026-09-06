import type { Request, Response } from "express";

import { fail, ok, paginated, parsePagination } from "../../shared/utils/http";
import type { LeadRiskFlag } from "./leads.model";
import { checkRate, clientIp, isDisposableEmail, verifyTurnstile } from "./leads.screening";
import { leadsService } from "./leads.service";
import {
  captureLeadSchema,
  consumeInviteSchema,
  listLeadsSchema,
  statsSchema,
  updateLeadSchema,
  verifyInviteSchema,
} from "./leads.validation";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[leads]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

/**
 * La respuesta del formulario publico. SIEMPRE la misma.
 *
 * Da igual si el lead se creo, si se descarto por bot, si estaba en cooldown o
 * si esa direccion ya tiene cuenta: el sitio dice "revisa tu correo" y listo.
 *
 * No es pereza, es lo unico que evita tres filtraciones distintas:
 * - **Enumeracion de clientes.** Con una respuesta distinta para "ya tiene
 *   cuenta", el formulario se convierte en una API para saber que hoteles usan
 *   roombir, probando direcciones.
 * - **Afinado del filtro.** Si el bot supiera cuando lo descartamos, ajusta el
 *   payload hasta pasar. Descartado en silencio, su operador cree que funciona.
 * - **Sondeo del rate limit.** Un 429 explicito le dice al script cuando volver;
 *   un 202 no le dice nada.
 *
 * Lo que si se contesta distinto es el error de validacion y el correo
 * descartable: eso lo puede corregir una persona real, y callarlo la deja sin
 * poder darse de alta sin entender por que.
 */
const ACCEPTED = { status: "accepted" as const };

export const leadsController = {
  // ------------------------------------------------------- publico ---------

  /** POST /public/leads — el formulario de /crear-cuenta del sitio. */
  async capture(req: Request, res: Response) {
    const { error, value } = captureLeadSchema.validate(req.body, {
      stripUnknown: true,
      abortEarly: true,
    });
    if (error) return fail(res, 400, error.message, "invalid_body");

    const ip = clientIp(req);
    const email: string = value.email;

    // El descartable se contesta ANTES de tocar la base: es el unico rechazo
    // que el visitante puede resolver, y no vale la pena guardar la ficha.
    if (isDisposableEmail(email)) {
      return fail(
        res,
        400,
        "Usa una direccion de correo permanente: el acceso se manda ahi",
        "disposable_email",
      );
    }

    const preFlags: LeadRiskFlag[] = [];
    const rate = checkRate(ip, email);
    if (rate.limited) {
      // 202 igual, con la ficha sin escribir. El que insiste no aprende nada y
      // el que se equivoco de boton no ve un error que no entiende.
      console.warn(`[leads] rate limit (${rate.scope}) ip=${ip} email=${email}`);
      return ok(res, ACCEPTED, 202);
    }

    const captchaOk = await verifyTurnstile(value.captchaToken || undefined, ip);
    if (captchaOk === false) preFlags.push("captcha_failed");

    try {
      const outcome = await leadsService.capture(
        {
          hotelName: value.hotelName,
          lodgingType: value.lodgingType,
          units: value.units,
          countryCode: value.countryCode,
          city: value.city,
          contactName: value.contactName,
          email,
          phone: value.phone,
          locale: value.locale,
          siteId: value.siteId,
          utm: value.utm,
          referer: value.referer,
          honeypot: value.website,
          elapsedMs: value.elapsedMs,
          interacted: value.interacted,
          captchaOk,
        },
        {
          ip,
          userAgent: String(req.headers["user-agent"] ?? ""),
          preFlags,
        },
      );

      console.log(`[leads] captura ${outcome} email=${email} ip=${ip}`);
      return ok(res, ACCEPTED, 202);
    } catch (err: any) {
      // Que falle el correo SI se cuenta: el lead quedo guardado pero la
      // persona no tiene como seguir, y decirle "revisa tu mail" seria mentir.
      if (err?.code === "mail_failed") {
        return fail(
          res,
          502,
          "No pudimos enviarte el correo de acceso. Probá de nuevo en unos minutos.",
          "mail_failed",
        );
      }
      return handleErr(res, err);
    }
  },

  // ------------------------------- server-to-server (X-Internal-Secret) ----

  /** POST /leads/internal/invite/verify — lo llama el /register del PMS. */
  async verifyInvite(req: Request, res: Response) {
    const { error, value } = verifyInviteSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await leadsService.verifyInvite(value.token));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  /** POST /leads/internal/invite/consume — despues de crear el usuario. */
  async consumeInvite(req: Request, res: Response) {
    const { error, value } = consumeInviteSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      const result = await leadsService.consumeInvite(value.token, {
        email: value.email,
        userId: value.userId ?? undefined,
        ip: value.ip,
        userAgent: value.userAgent,
      });
      // 409 y no 400: el token existe, lo que no se puede es volver a usarlo.
      if (!result.ok) return fail(res, 409, "El acceso no es valido", result.reason);
      return ok(res, result);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  // ------------------------------------------------------------- panel ----

  async list(req: Request, res: Response) {
    const { error, value } = listLeadsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      const { page, limit, skip } = parsePagination(value);
      const r = await leadsService.list({ ...value, page, limit, skip });
      return paginated(res, r.data, r.total, r.page, r.limit);
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async stats(req: Request, res: Response) {
    const { error, value } = statsSchema.validate(req.query);
    if (error) return fail(res, 400, error.message, "invalid_query");
    try {
      return ok(res, await leadsService.stats(value.days));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async get(req: Request, res: Response) {
    try {
      return ok(res, await leadsService.get(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  async update(req: Request, res: Response) {
    const { error, value } = updateLeadSchema.validate(req.body, { stripUnknown: true });
    if (error) return fail(res, 400, error.message, "invalid_body");
    try {
      return ok(res, await leadsService.update(req.params.id, value));
    } catch (err) {
      return handleErr(res, err);
    }
  },

  /** POST /leads/:id/resend — reemite el acceso y revoca el anterior. */
  async resend(req: Request, res: Response) {
    try {
      const r = await leadsService.issueInvite(req.params.id);
      return ok(res, { sent: true, expiresAt: r.expiresAt });
    } catch (err) {
      return handleErr(res, err);
    }
  },

  /** POST /leads/:id/revoke — corta el acceso sin borrar la ficha. */
  async revoke(req: Request, res: Response) {
    try {
      return ok(res, await leadsService.revokeInvites(req.params.id));
    } catch (err) {
      return handleErr(res, err);
    }
  },
};
