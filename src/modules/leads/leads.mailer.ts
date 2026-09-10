/**
 * El mail que ES la puerta de entrada.
 *
 * Todo el alta de Roombir pasa por este correo: sin el enlace que sale de aca
 * nadie puede crear una cuenta. Por eso el envio NO es fire-and-forget — si
 * falla, el lead queda con `invite.lastError` y el panel puede reintentarlo.
 *
 * Este archivo es SOLO el transporte. El HTML vive en `leads.template.ts`.
 *
 * ---------------------------------------------------------------------------
 * Por que hay tres drivers y en que orden se eligen
 * ---------------------------------------------------------------------------
 *
 *   1. `smtp`   — nodemailer contra las `SMTP_*`. Es el camino normal.
 *   2. `resend` — la API HTTP, si quedo una `RESEND_API_KEY` y no hay SMTP.
 *                 Se mantiene porque hay hostings que bloquean los puertos de
 *                 salida 465/587: si eso pasa en el VPS, esto sigue mandando.
 *   3. `log`    — escribe el enlace en consola. SOLO fuera de produccion.
 *
 * El punto 3 es el que hay que mirar con cuidado, porque su version anterior
 * fue exactamente el bug que dejo el alta muda durante semanas: el driver `log`
 * se activaba por la sola ausencia de `RESEND_API_KEY`, tambien en produccion,
 * y devolvia EXITO. El lead quedaba `invited`, sin `lastError`, con el panel
 * mostrando todo en verde y ningun correo enviado. Ahora en produccion la falta
 * de configuracion tira: es preferible un lead con error visible y un boton de
 * reintentar que uno que miente.
 */

import nodemailer, { type Transporter } from "nodemailer";

import { resolveLocale } from "./leads.i18n";
import { renderExisting, renderInvite, type RenderedMail } from "./leads.template";

export interface InviteMailInput {
  to: string;
  contactName?: string;
  hotelName: string;
  locale: string;
  /** URL completa, con el token y las UTM ya puestas. */
  url: string;
  expiresAt: Date;
}

type Driver = "smtp" | "resend" | "log";

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------

/**
 * El remitente.
 *
 * `SMTP_FROM` va primero y es el mismo nombre en los cuatro servicios: con
 * Gmail el From tiene que ser la casilla autenticada (o un alias verificado en
 * esa cuenta), asi que la direccion del camino SMTP se declara aparte de la que
 * usaria Resend. Si no coincide, Google reescribe la cabecera sin avisar.
 */
function fromAddress(): string {
  return (
    process.env.SMTP_FROM ||
    process.env.LEADS_EMAIL_FROM ||
    process.env.EMAIL_FROM ||
    "Roombir <team@roombir.com>"
  );
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Las `SMTP_*`, o `null` si falta alguna.
 *
 * Se exige host + user + pass juntos a proposito: un host sin credenciales no
 * es "SMTP a medio configurar", es una configuracion que va a fallar en el
 * primer envio. Mejor que ni siquiera se elija ese driver.
 */
function smtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  if (!host || !user || !pass) return null;

  const port = Number((process.env.SMTP_PORT ?? "587").trim()) || 587;
  // 465 es TLS implicito; 587 y 2587 son STARTTLS, que nodemailer negocia con
  // `secure:false`. Se puede forzar con SMTP_SECURE para puertos raros.
  const secure = (process.env.SMTP_SECURE ?? "").trim()
    ? process.env.SMTP_SECURE!.trim() === "true"
    : port === 465;

  return { host, port, secure, user, pass };
}

function pickDriver(): Driver {
  if (smtpConfig()) return "smtp";
  if ((process.env.RESEND_API_KEY ?? "").trim()) return "resend";
  return "log";
}

// ---------------------------------------------------------------------------
// Transporte SMTP
// ---------------------------------------------------------------------------

let cached: Transporter | null = null;

/**
 * El transporter, una sola vez.
 *
 * `pool` mantiene la conexion abierta entre envios: sin eso cada invite paga un
 * handshake TLS completo, que contra Gmail son ~400 ms de nada.
 */
function transporter(cfg: SmtpConfig): Transporter {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3,
    // Un alta que tarda mas de 20 s ya fallo para quien esta esperando en el
    // formulario; que corte y quede el error asentado.
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return cached;
}

/**
 * Prueba la conexion sin mandar nada.
 *
 * La usa el script de diagnostico: distingue "la credencial esta mal" de "el
 * puerto esta bloqueado", que desde el lado del lead se ven igual.
 */
export async function verifySmtp(): Promise<{ ok: boolean; detail: string }> {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, detail: "sin SMTP_HOST / SMTP_USER / SMTP_PASS" };
  try {
    await transporter(cfg).verify();
    return { ok: true, detail: `${cfg.host}:${cfg.port} (secure=${cfg.secure})` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function sendSmtp(cfg: SmtpConfig, to: string, mail: RenderedMail) {
  const info = await transporter(cfg).sendMail({
    from: fromAddress(),
    to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    // Un alta no es una campaña: que un autoresponder no conteste ni lo mande a
    // la carpeta de promociones.
    headers: { "X-Auto-Response-Suppress": "OOF, AutoReply" },
  });

  // `rejected` no tira excepcion: el servidor acepta el mensaje y descarta ese
  // destinatario. Sin este chequeo seria otro exito falso.
  if (info.rejected?.length) {
    throw new Error(`smtp rechazo el destinatario: ${info.rejected.join(", ")}`);
  }
  console.info(`[leads:mail:smtp] enviado a=${to} id=${info.messageId ?? "?"}`);
}

async function sendResend(to: string, mail: RenderedMail) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(process.env.RESEND_API_KEY ?? "").trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "X-Auto-Response-Suppress": "OOF, AutoReply" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  console.info(`[leads:mail:resend] enviado a=${to}`);
}

async function send(to: string, mail: RenderedMail): Promise<void> {
  const driver = pickDriver();

  if (driver === "smtp") {
    await sendSmtp(smtpConfig()!, to, mail);
    return;
  }

  if (driver === "resend") {
    await sendResend(to, mail);
    return;
  }

  // driver === "log"
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "no hay transporte de correo configurado (faltan SMTP_HOST/SMTP_USER/SMTP_PASS)",
    );
  }
  console.warn(
    `[leads:mail:log] sin SMTP configurado -> ${to} :: ${mail.subject}\n${mail.text}`,
  );
}

export const leadsMailer = {
  async sendInvite(input: InviteMailInput): Promise<void> {
    const locale = resolveLocale(input.locale);
    await send(
      input.to,
      renderInvite(
        {
          contactName: input.contactName,
          hotelName: input.hotelName,
          url: input.url,
          expiresAt: input.expiresAt,
        },
        locale,
      ),
    );
  },

  async sendAlreadyRegistered(input: {
    to: string;
    hotelName: string;
    locale: string;
    loginUrl: string;
  }): Promise<void> {
    const locale = resolveLocale(input.locale);
    await send(
      input.to,
      renderExisting({ hotelName: input.hotelName, loginUrl: input.loginUrl }, locale),
    );
  },
};
