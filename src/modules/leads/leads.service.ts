import crypto from "crypto";

import { makeId } from "../../shared/utils/ids";
import { getPmsUserModel } from "../access/pmsAccessModels";
import { leadsMailer } from "./leads.mailer";
import {
  Lead,
  LeadInvite,
  type LeadRiskFlag,
  type LeadStatus,
} from "./leads.model";
import { screen, type ScreeningInput } from "./leads.screening";

/**
 * El circuito completo del alta.
 *
 *   formulario del sitio -> lead -> invite -> mail -> /register del PMS
 *
 * Dos invariantes que sostienen todo lo demas y conviene no romper:
 *
 * 1. **El token vale para UN email.** Se emite contra el correo del lead y el
 *    PMS solo puede canjearlo registrando ESA direccion. Un token filtrado no
 *    sirve para darse de alta con otro correo.
 * 2. **El canje es atomico y de un solo uso.** `consume` marca `usedAt` con un
 *    `findOneAndUpdate` condicionado a que siga en null: dos POST simultaneos
 *    con el mismo token producen exactamente una cuenta.
 *
 * Lo que este servicio NO hace: decidir si el alta es valida por otros motivos
 * (pais bloqueado, email en uso). Eso ya lo resuelve el PMS y duplicarlo aca
 * seria tener dos verdades.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Vida del invite. Una semana: entra el fin de semana largo del que lo pidio. */
const ttlHours = () => num(process.env.LEADS_INVITE_TTL_HOURS, 168);

/**
 * Espera minima entre dos mails al mismo lead.
 *
 * No es una comodidad: sin esto, el formulario es un boton de "mandale otro
 * correo a esta direccion" que cualquiera puede apretar en loop contra una
 * casilla ajena. El techo por email del rate limit acota el dia; esto acota el
 * minuto.
 */
const resendCooldownMs = () => num(process.env.LEADS_RESEND_COOLDOWN_MIN, 5) * 60_000;

/** Base del PMS. De aca sale el enlace del correo, que es TODO el mecanismo. */
const appUrl = () =>
  (process.env.LEADS_APP_URL ?? process.env.PMS_APP_URL ?? "http://localhost:9000").replace(
    /\/+$/,
    "",
  );

/**
 * El enlace del mail.
 *
 * `inv` es el porton (lo valida el PMS contra este servicio). Las `utm_*` son
 * atribucion: dejan ver en las metricas que el alta entro por el correo y no
 * por otro lado, y no participan de la autorizacion — quien borre las UTM sigue
 * pudiendo registrarse, quien borre el `inv` no.
 */
function inviteUrl(token: string, locale: string, channel: InviteChannel = "email"): string {
  const params = new URLSearchParams({
    inv: token,
    // El idioma en que la persona completo el formulario del sitio. El PMS lo
    // lee en su middleware y abre el alta en ese idioma, en vez de adivinarlo
    // por el pais de la IP.
    lang: locale,
    utm_source: channel === "direct" ? "panel" : "email",
    utm_medium: channel === "direct" ? "direct_link" : "invite",
    utm_campaign: "lead_access",
  });
  return `${appUrl()}/register?${params.toString()}`;
}

type InviteChannel = "email" | "direct";

/** Operador del panel que genera un enlace directo (queda en el invite). */
export interface InviteActor {
  userId?: string;
  email?: string;
}

/**
 * El enlace LIBRE: `/register/direct/<token>`. El PMS lo redirige al alta de
 * siempre (`/register?inv=`), asi que el corte sigue siendo el mismo token.
 */
function openLinkUrl(token: string, locale: string): string {
  return `${appUrl()}/register/direct/${token}?lang=${encodeURIComponent(locale)}`;
}

const loginUrl = (locale: string) => `${appUrl()}/login?lang=${encodeURIComponent(locale)}`;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** 32 bytes de aleatoriedad criptografica -> 43 caracteres url-safe. */
function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

export interface CaptureInput {
  hotelName: string;
  lodgingType: string;
  units?: number | null;
  countryCode: string;
  city?: string;
  contactName?: string;
  email: string;
  phone?: string;
  locale?: string;
  siteId?: string;
  utm?: Record<string, string>;
  referer?: string;
  honeypot?: string;
  elapsedMs?: number | null;
  interacted?: boolean;
  captchaOk?: boolean | null;
}

/** Lo que carga el operador para generar un enlace directo. Solo el email es obligatorio. */
export interface DirectLinkInput {
  email: string;
  hotelName?: string;
  contactName?: string;
  lodgingType?: string;
  countryCode?: string;
  city?: string;
  phone?: string;
  locale?: string;
  notes?: string;
}

export interface CaptureMeta {
  ip: string;
  userAgent: string;
  /** Banderas que ya trajo el borde (hoy: el techo por IP del proxy del sitio). */
  preFlags?: LeadRiskFlag[];
}

export type CaptureOutcome =
  | "invited"
  | "resent"
  | "throttled"
  | "already_registered"
  | "dropped";

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

async function emailHasPmsAccount(email: string): Promise<boolean> {
  try {
    const User = await getPmsUserModel();
    const found = await User.findOne({ email }).select("userId").lean();
    return Boolean(found);
  } catch (err) {
    // Falla ABIERTO y solo esta consulta: sin la DB del PMS no sabemos si ya
    // tiene cuenta, y negarle el invite a alguien por eso lo dejaria sin
    // manera de entrar. Si la tenia, el /register se lo va a decir.
    console.warn("[leads] no se pudo consultar la DB del PMS:", err);
    return false;
  }
}

export const leadsService = {
  // -------------------------------------------------------------- captura ---

  /**
   * El formulario publico.
   *
   * Devuelve SIEMPRE un outcome y nunca lanza por motivos de negocio: al
   * visitante se le contesta lo mismo pase lo que pase (ver el controller).
   * La unica excepcion es el correo descartable, que se rechaza con un mensaje
   * util porque es algo que la persona puede corregir en dos segundos.
   */
  async capture(input: CaptureInput, meta: CaptureMeta): Promise<CaptureOutcome> {
    const email = input.email.trim().toLowerCase();
    const hotelName = input.hotelName.trim();

    const verdict = screen({
      honeypot: input.honeypot,
      elapsedMs: input.elapsedMs,
      interacted: input.interacted,
      email,
      hotelName,
      city: input.city,
      contactName: input.contactName,
      captchaOk: input.captchaOk,
    } satisfies ScreeningInput);

    const flags = [...new Set([...(meta.preFlags ?? []), ...verdict.flags])];

    const base = {
      hotelName,
      lodgingType: input.lodgingType,
      units: input.units ?? null,
      countryCode: (input.countryCode ?? "").toUpperCase(),
      city: (input.city ?? "").trim(),
      contactName: (input.contactName ?? "").trim(),
      email,
      phone: (input.phone ?? "").trim(),
      locale: input.locale ?? "es",
      siteId: input.siteId ?? "",
      utm: input.utm ?? {},
      referer: input.referer ?? "",
      capture: {
        ip: meta.ip,
        userAgent: meta.userAgent.slice(0, 400),
        elapsedMs: input.elapsedMs ?? null,
      },
      screening: { score: verdict.score, flags },
    };

    const existing = await Lead.findOne({ email }).sort({ createdAt: -1 });

    // ---- Basura: se guarda para poder medirla, pero no dispara nada ----
    if (verdict.drop) {
      if (existing) {
        existing.set({ ...base, status: "spam" as LeadStatus, statusChangedAt: new Date() });
        existing.submissions = (existing.submissions ?? 0) + 1;
        await existing.save();
      } else {
        await Lead.create({ ...base, leadId: makeId("lead"), status: "spam" });
      }
      console.warn(`[leads] descartado por el filtro: ${email} flags=${flags.join(",")}`);
      return "dropped";
    }

    // ---- Ya es cliente: se lo mandamos al login, no al alta ----
    const alreadyRegistered =
      existing?.status === "registered" || (await emailHasPmsAccount(email));

    if (alreadyRegistered) {
      if (existing) {
        existing.submissions = (existing.submissions ?? 0) + 1;
        await existing.save();
      } else {
        await Lead.create({
          ...base,
          leadId: makeId("lead"),
          status: "registered",
          registeredAt: new Date(),
        });
      }
      try {
        await leadsMailer.sendAlreadyRegistered({
          to: email,
          hotelName,
          locale: base.locale,
          loginUrl: loginUrl(base.locale ?? "es"),
        });
      } catch (err) {
        console.error("[leads] no se pudo avisar que ya tenia cuenta:", err);
      }
      return "already_registered";
    }

    // ---- Lead nuevo o repetido ----
    let lead = existing;
    if (lead) {
      const lastSent = lead.invite?.lastSentAt?.getTime() ?? 0;
      const cooling = Date.now() - lastSent < resendCooldownMs();
      lead.set({ ...base, status: lead.status === "spam" ? "new" : lead.status });
      lead.submissions = (lead.submissions ?? 0) + 1;
      await lead.save();
      // Dentro de la ventana no sale otro mail. El anterior sigue siendo valido,
      // asi que el visitante no queda sin acceso: solo no recibe dos correos.
      if (cooling) return "throttled";
    } else {
      lead = await Lead.create({ ...base, leadId: makeId("lead") });
    }

    await leadsService.issueInvite(lead.leadId);
    return existing ? "resent" : "invited";
  },

  // --------------------------------------------------------------- invite ---

  /**
   * Emite un invite nuevo, revoca los anteriores y manda el correo.
   *
   * Revocar primero y no despues importa: si el mail falla, el lead queda sin
   * ningun token valido y el panel lo muestra con el error. Es preferible a
   * dejar vivo un token que la persona no recibio y no puede usar.
   */
  async issueInvite(leadId: string) {
    const { lead, token, expiresAt } = await leadsService.mintInvite(leadId, "email");

    try {
      await leadsMailer.sendInvite({
        to: lead.email,
        contactName: lead.contactName ?? undefined,
        hotelName: lead.hotelName,
        locale: lead.locale ?? "es",
        url: inviteUrl(token, lead.locale ?? "es"),
        expiresAt,
      });
    } catch (err: any) {
      // El invite ya existe y es valido; lo que fallo es el transporte. Se deja
      // asentado para que el panel ofrezca reintentar en vez de crear otro.
      await Lead.updateOne(
        { leadId },
        { $set: { "invite.lastError": String(err?.message ?? err).slice(0, 300) } },
      );
      console.error(`[leads] fallo el envio del invite a ${lead.email}:`, err);
      throw Object.assign(new Error("No se pudo enviar el correo de acceso"), {
        status: 502,
        code: "mail_failed",
      });
    }

    return { expiresAt };
  },

  /**
   * Emite el token: revoca los vivos del lead, crea el nuevo y actualiza el
   * resumen. No manda nada — eso lo decide quien llama (correo o enlace directo).
   * El token en claro sale de aca y en ningun otro lado.
   */
  async mintInvite(leadId: string, channel: InviteChannel, actor?: InviteActor) {
    const lead = await Lead.findOne({ leadId });
    if (!lead) throw Object.assign(new Error("Lead no encontrado"), { status: 404 });
    if (lead.status === "registered") {
      throw Object.assign(new Error("El lead ya creo su cuenta"), {
        status: 409,
        code: "already_registered",
      });
    }

    await LeadInvite.updateMany(
      { leadId, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "resend" } },
    );

    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlHours() * 3_600_000);
    const now = new Date();

    await LeadInvite.create({
      inviteId: makeId("inv"),
      leadId,
      email: lead.email,
      tokenHash: hashToken(token),
      expiresAt,
      sentAt: now,
      channel,
      createdBy: { userId: actor?.userId ?? "", email: actor?.email ?? "" },
    });

    lead.invite = {
      ...(lead.invite ?? {}),
      sentCount: (lead.invite?.sentCount ?? 0) + 1,
      firstSentAt: lead.invite?.firstSentAt ?? now,
      lastSentAt: now,
      expiresAt,
      openedAt: null,
      usedAt: null,
      revokedAt: null,
      lastError: "",
      lastChannel: channel,
    } as typeof lead.invite;
    lead.status = "invited";
    lead.statusChangedAt = now;
    await lead.save();

    return { lead, token, expiresAt };
  },

  /**
   * Enlace directo de alta para un lead que ya existe: mismo token de un solo
   * uso y atado a su email, pero sin correo. Revoca el acceso anterior, asi que
   * el ultimo enlace (o el ultimo mail) es el unico que abre el alta.
   */
  async directLinkForLead(leadId: string, actor: InviteActor) {
    const { lead, token, expiresAt } = await leadsService.mintInvite(leadId, "direct", actor);
    const locale = lead.locale ?? "es";
    return { leadId, email: lead.email, url: inviteUrl(token, locale, "direct"), expiresAt };
  },

  /**
   * Enlace directo para alguien contactado a mano.
   *
   * Saltea el formulario del sitio, el filtro anti-bots y el correo: lo usa un
   * operador para una persona que conoce. Lo que NO saltea son las invariantes
   * del token — un solo uso, vence, y solo registra ESE email —, asi que si el
   * enlace se reenvia o se filtra no sirve para abrir otra cuenta.
   */
  async createDirectLink(input: DirectLinkInput, actor: InviteActor) {
    const email = input.email.trim().toLowerCase();

    let lead = await Lead.findOne({ email }).sort({ createdAt: -1 });
    if (lead?.status === "registered" || (await emailHasPmsAccount(email))) {
      throw Object.assign(new Error("Ese email ya tiene una cuenta en Roombir"), {
        status: 409,
        code: "already_registered",
      });
    }

    // Lo que cargo el operador completa la ficha; lo vacio no pisa lo que ya habia.
    const patch: Record<string, unknown> = {};
    const setIf = (key: string, value: string | undefined) => {
      const v = (value ?? "").trim();
      if (v) patch[key] = v;
    };
    setIf("hotelName", input.hotelName);
    setIf("contactName", input.contactName);
    setIf("lodgingType", input.lodgingType);
    setIf("city", input.city);
    setIf("phone", input.phone);
    setIf("locale", input.locale);
    if (input.countryCode?.trim()) patch.countryCode = input.countryCode.trim().toUpperCase();

    if (lead) {
      // Un lead que el filtro mando a spam o que se descarto vuelve a la cola:
      // el operador acaba de decir que es una persona real.
      lead.set(patch);
      if (input.notes?.trim()) {
        lead.notes = [lead.notes, input.notes.trim()].filter(Boolean).join("\n\n");
      }
      await lead.save();
    } else {
      lead = await Lead.create({
        leadId: makeId("lead"),
        hotelName: input.hotelName?.trim() || email,
        email,
        source: "manual",
        ownerUserId: actor.userId ?? null,
        notes: input.notes?.trim() ?? "",
        ...patch,
      });
    }

    return leadsService.directLinkForLead(lead.leadId, actor);
  },

  // ------------------------------------------------------- enlace libre ---

  /**
   * Enlace LIBRE de alta: sin correo atado, para alguien que el operador
   * contacto a mano. Lo que conserva del invite normal es lo que acota el
   * dano si se filtra: **un solo uso**, vence, y se puede revocar. El lead
   * no existe hasta el canje: ahi se crea con el correo con el que se registro.
   */
  async createOpenLink(input: { label?: string; locale?: string }, actor: InviteActor) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlHours() * 3_600_000);
    const locale = input.locale || "es";
    const invite = await LeadInvite.create({
      inviteId: makeId("inv"),
      open: true,
      label: (input.label ?? "").trim().slice(0, 160),
      locale,
      tokenHash: hashToken(token),
      expiresAt,
      sentAt: new Date(),
      channel: "direct",
      createdBy: { userId: actor.userId ?? "", email: actor.email ?? "" },
    });
    return {
      inviteId: invite.inviteId,
      url: openLinkUrl(token, locale),
      label: invite.label,
      expiresAt,
    };
  },

  /** Los enlaces libres emitidos, mas nuevos primero. Nunca el token. */
  async listOpenLinks(limit = 30) {
    const rows = await LeadInvite.find({ open: true })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-tokenHash")
      .lean();
    const now = Date.now();
    return rows.map((r) => ({
      inviteId: r.inviteId,
      label: r.label ?? "",
      locale: r.locale ?? "es",
      createdAt: (r as { createdAt?: Date }).createdAt ?? r.sentAt,
      createdBy: r.createdBy?.email ?? "",
      expiresAt: r.expiresAt,
      openedAt: r.openedAt,
      usedAt: r.usedAt,
      usedBy: r.usedAt ? r.email : "",
      leadId: r.leadId || null,
      revokedAt: r.revokedAt,
      state: r.usedAt
        ? "used"
        : r.revokedAt
          ? "revoked"
          : r.expiresAt.getTime() < now
            ? "expired"
            : "active",
    }));
  },

  async revokeOpenLink(inviteId: string) {
    const res = await LeadInvite.updateOne(
      { inviteId, open: true, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "manual" } },
    );
    if (!res.modifiedCount) {
      throw Object.assign(new Error("El enlace no existe o ya no esta vigente"), {
        status: 404,
        code: "not_active",
      });
    }
    return { revoked: true };
  },

  /** Corta el acceso a mano, sin borrar el lead. */
  async revokeInvites(leadId: string, reason = "manual") {
    const res = await LeadInvite.updateMany(
      { leadId, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    await Lead.updateOne(
      { leadId },
      { $set: { "invite.revokedAt": new Date(), "invite.expiresAt": null } },
    );
    return { revoked: res.modifiedCount };
  },

  // ---------------------------------------------------- canje (desde el PMS) ---

  /**
   * "Este token, ¿abre el alta?" — lo pregunta el PMS al pintar `/register`.
   *
   * Devuelve los datos del lead para prellenar el formulario. El email va
   * incluido porque el PMS lo muestra bloqueado: el invite vale para ESA
   * direccion y dejar el campo editable seria prometer algo que el canje
   * despues rechaza.
   */
  async verifyInvite(token: string) {
    if (!token || token.length < 20) return { valid: false as const, reason: "invalid" };

    const invite = await LeadInvite.findOne({ tokenHash: hashToken(token) });
    if (!invite) return { valid: false as const, reason: "invalid" };
    if (invite.usedAt) return { valid: false as const, reason: "used" };
    if (invite.revokedAt) return { valid: false as const, reason: "revoked" };
    if (invite.expiresAt.getTime() < Date.now()) {
      return { valid: false as const, reason: "expired" };
    }

    // Enlace libre: no hay lead todavia. Se devuelve uno vacio (el PMS deja el
    // correo editable cuando viene vacio) con el idioma del enlace.
    if (invite.open) {
      if (!invite.openedAt) {
        invite.openedAt = new Date();
        await invite.save();
      }
      return {
        valid: true as const,
        open: true,
        lead: {
          leadId: "",
          email: "",
          contactName: "",
          hotelName: "",
          lodgingType: "",
          units: null,
          countryCode: "",
          city: "",
          phone: "",
          locale: invite.locale ?? "es",
        },
        expiresAt: invite.expiresAt,
      };
    }

    const lead = await Lead.findOne({ leadId: invite.leadId }).lean();
    if (!lead) return { valid: false as const, reason: "invalid" };

    // Primera apertura: mueve el lead a `opened`. Sirve para ver cuantos de los
    // que reciben el mail llegan a la pantalla y cuantos se caen antes.
    if (!invite.openedAt) {
      invite.openedAt = new Date();
      await invite.save();
      await Lead.updateOne(
        { leadId: lead.leadId, status: { $in: ["new", "invited"] } },
        { $set: { status: "opened", statusChangedAt: new Date(), "invite.openedAt": new Date() } },
      );
    }

    return {
      valid: true as const,
      lead: {
        leadId: lead.leadId,
        email: lead.email,
        contactName: lead.contactName ?? "",
        hotelName: lead.hotelName,
        lodgingType: lead.lodgingType,
        units: lead.units ?? null,
        countryCode: lead.countryCode ?? "",
        city: lead.city ?? "",
        phone: lead.phone ?? "",
        locale: lead.locale ?? "es",
      },
      expiresAt: invite.expiresAt,
    };
  },

  /**
   * Quema el token. Lo llama el PMS DESPUES de crear el usuario.
   *
   * El `findOneAndUpdate` condicionado a `usedAt: null` es lo que hace que dos
   * registros simultaneos con el mismo token no puedan crear dos cuentas: el
   * segundo no encuentra documento y el PMS lo rechaza.
   *
   * El email tiene que coincidir con el del invite. Sin eso, un token robado
   * serviria para abrir una cuenta a nombre de cualquier direccion.
   */
  async consumeInvite(
    token: string,
    ctx: { email: string; userId?: string; ip?: string; userAgent?: string },
  ) {
    const tokenHash = hashToken(token || "");
    const email = ctx.email.trim().toLowerCase();

    const invite = await LeadInvite.findOne({ tokenHash });
    if (!invite) return { ok: false as const, reason: "invalid" };
    if (invite.usedAt) return { ok: false as const, reason: "used" };
    if (invite.revokedAt) return { ok: false as const, reason: "revoked" };
    if (invite.expiresAt.getTime() < Date.now()) {
      return { ok: false as const, reason: "expired" };
    }
    if (invite.open) return leadsService.consumeOpenLink(tokenHash, email, ctx);
    if (invite.email !== email) {
      invite.failedAttempts = (invite.failedAttempts ?? 0) + 1;
      await invite.save();
      console.warn(
        `[leads] canje rechazado: el invite es para ${invite.email} y se intento con ${email}`,
      );
      return { ok: false as const, reason: "email_mismatch" };
    }

    const claimed = await LeadInvite.findOneAndUpdate(
      { tokenHash, usedAt: null, revokedAt: null },
      {
        $set: {
          usedAt: new Date(),
          usedFrom: { ip: ctx.ip ?? "", userAgent: (ctx.userAgent ?? "").slice(0, 400) },
        },
      },
      { new: true },
    );
    if (!claimed) return { ok: false as const, reason: "used" };

    const now = new Date();
    await Lead.updateOne(
      { leadId: claimed.leadId },
      {
        $set: {
          status: "registered",
          statusChangedAt: now,
          registeredAt: now,
          registeredUserId: ctx.userId ?? null,
          "invite.usedAt": now,
        },
      },
    );

    return { ok: true as const, leadId: claimed.leadId };
  },

  /**
   * Canje de un enlace libre. Mismo candado atomico que el normal (dos altas
   * simultaneas con el mismo enlace dan UNA cuenta), y ademas deja asentado
   * con que correo se uso y crea (o cierra) el lead de esa persona, para que
   * el embudo y la ficha la muestren como cualquier otra alta.
   */
  async consumeOpenLink(
    tokenHash: string,
    email: string,
    ctx: { userId?: string; ip?: string; userAgent?: string },
  ) {
    const claimed = await LeadInvite.findOneAndUpdate(
      { tokenHash, open: true, usedAt: null, revokedAt: null },
      {
        $set: {
          usedAt: new Date(),
          email,
          usedFrom: { ip: ctx.ip ?? "", userAgent: (ctx.userAgent ?? "").slice(0, 400) },
        },
      },
      { new: true },
    );
    if (!claimed) return { ok: false as const, reason: "used" };

    const now = new Date();
    const registered = {
      status: "registered" as LeadStatus,
      statusChangedAt: now,
      registeredAt: now,
      registeredUserId: ctx.userId ?? null,
      "invite.usedAt": now,
      "invite.lastChannel": "direct",
    };
    let lead = await Lead.findOne({ email }).sort({ createdAt: -1 });
    if (lead) {
      await Lead.updateOne({ leadId: lead.leadId }, { $set: registered });
    } else {
      lead = await Lead.create({
        leadId: makeId("lead"),
        hotelName: claimed.label || email,
        email,
        source: "manual",
        locale: claimed.locale ?? "es",
        ownerUserId: claimed.createdBy?.userId || null,
        notes: claimed.label ? `Enlace libre: ${claimed.label}` : "Enlace libre",
        invite: { sentCount: 1, firstSentAt: claimed.sentAt, lastSentAt: claimed.sentAt },
        ...registered,
      });
    }
    await LeadInvite.updateOne({ tokenHash }, { $set: { leadId: lead.leadId } });

    return { ok: true as const, leadId: lead.leadId };
  },

  // ---------------------------------------------------------------- panel ---

  async list(params: {
    status?: LeadStatus;
    lodgingType?: string;
    country?: string;
    search?: string;
    sort?: "recent" | "units" | "name";
    page: number;
    limit: number;
    skip: number;
  }) {
    const query: Record<string, unknown> = {};
    if (params.status) query.status = params.status;
    if (params.lodgingType) query.lodgingType = params.lodgingType;
    if (params.country) query.countryCode = params.country.toUpperCase();
    if (params.search) {
      // Escapado: el buscador del panel recibe texto de una persona, no un
      // patron. Sin esto un `(` cuelga la query con una regex invalida.
      const safe = params.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [{ hotelName: rx }, { email: rx }, { contactName: rx }, { city: rx }];
    }

    const sort: Record<string, 1 | -1> =
      params.sort === "units"
        ? { units: -1, createdAt: -1 }
        : params.sort === "name"
          ? { hotelName: 1 }
          : { createdAt: -1 };

    const [data, total] = await Promise.all([
      Lead.find(query).sort(sort).skip(params.skip).limit(params.limit).lean(),
      Lead.countDocuments(query),
    ]);

    return { data, total, page: params.page, limit: params.limit };
  },

  async get(leadId: string) {
    const lead = await Lead.findOne({ leadId }).lean();
    if (!lead) throw Object.assign(new Error("Lead no encontrado"), { status: 404 });
    const invites = await LeadInvite.find({ leadId })
      .sort({ createdAt: -1 })
      .limit(20)
      // El hash tampoco sale del API: no sirve para entrar, pero es material
      // para un ataque de diccionario offline si la base se filtra dos veces.
      .select("-tokenHash")
      .lean();
    return { lead, invites };
  },

  async update(leadId: string, patch: { status?: LeadStatus; notes?: string; ownerUserId?: string | null }) {
    const lead = await Lead.findOne({ leadId });
    if (!lead) throw Object.assign(new Error("Lead no encontrado"), { status: 404 });

    if (patch.status && patch.status !== lead.status) {
      // `registered` lo pone el canje del invite, no una persona: ponerlo a mano
      // dejaria un lead marcado como cliente sin ninguna cuenta detras.
      if (patch.status === "registered") {
        throw Object.assign(new Error("El estado registrado lo pone el alta, no el panel"), {
          status: 400,
          code: "readonly_status",
        });
      }
      lead.status = patch.status;
      lead.statusChangedAt = new Date();
      // Descartar corta el acceso: si no, el invite que ya salio sigue abriendo
      // el alta de alguien que decidimos no aceptar.
      if (patch.status === "discarded" || patch.status === "spam") {
        await leadsService.revokeInvites(leadId, "manual");
      }
    }
    if (patch.notes !== undefined) lead.notes = patch.notes;
    if (patch.ownerUserId !== undefined) lead.ownerUserId = patch.ownerUserId;

    await lead.save();
    return lead.toObject();
  },

  /** El resumen de arriba de la lista: volumen, embudo y cortes. */
  async stats(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);

    const [byStatus, byType, byCountry, recent, totals] = await Promise.all([
      Lead.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      Lead.aggregate([
        { $match: { status: { $nin: ["spam"] } } },
        { $group: { _id: "$lodgingType", n: { $sum: 1 }, units: { $sum: "$units" } } },
        { $sort: { n: -1 } },
      ]),
      Lead.aggregate([
        { $match: { status: { $nin: ["spam"] } } },
        { $group: { _id: "$countryCode", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 12 },
      ]),
      Lead.aggregate([
        { $match: { createdAt: { $gte: since }, status: { $nin: ["spam"] } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            n: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Lead.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            units: { $sum: "$units" },
            registered: {
              $sum: { $cond: [{ $eq: ["$status", "registered"] }, 1, 0] },
            },
            spam: { $sum: { $cond: [{ $eq: ["$status", "spam"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) statusMap[row._id ?? "new"] = row.n;

    const t = totals[0] ?? { total: 0, units: 0, registered: 0, spam: 0 };
    const real = t.total - t.spam;

    return {
      totals: {
        total: t.total,
        real,
        spam: t.spam,
        registered: t.registered,
        units: t.units ?? 0,
        // De los que recibieron el mail, cuantos terminaron creando la cuenta.
        conversion: real > 0 ? t.registered / real : 0,
      },
      byStatus: statusMap,
      byType: byType.map((r) => ({ key: r._id ?? "other", count: r.n, units: r.units ?? 0 })),
      byCountry: byCountry.map((r) => ({ key: r._id ?? "", count: r.n })),
      series: recent.map((r) => ({ date: r._id as string, count: r.n as number })),
    };
  },
};
