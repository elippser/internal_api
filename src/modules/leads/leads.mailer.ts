/**
 * El mail que ES la puerta de entrada.
 *
 * Todo el alta de Roombir pasa por este correo: sin el enlace que sale de aca
 * nadie puede crear una cuenta. Por eso el envio NO es fire-and-forget — si
 * falla, el lead queda con `invite.lastError` y el panel puede reintentarlo.
 *
 * Va por Resend con `fetch` y no con el SDK a proposito: `internal-laupser/api`
 * no tiene la dependencia y no vale la pena sumarla por un POST de tres campos.
 * El mismo criterio que `campaigns/providers.ts`, que ya manda asi.
 *
 * Sin `RESEND_API_KEY` el driver es `log`: escribe el enlace en la consola y
 * devuelve exito. En local eso es lo que permite probar el circuito entero sin
 * dominio verificado ni cuenta; en produccion, que falte la clave se ve en el
 * panel porque el lead queda `invited` con el error del envio.
 */

import type { Locale } from "./leads.i18n";
import { emailCopy, resolveLocale } from "./leads.i18n";

export interface InviteMailInput {
  to: string;
  contactName?: string;
  hotelName: string;
  locale: string;
  /** URL completa, con el token y las UTM ya puestas. */
  url: string;
  expiresAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fromAddress(): string {
  return (
    process.env.LEADS_EMAIL_FROM ||
    process.env.EMAIL_FROM ||
    "Roombir <hola@roombir.com>"
  );
}

/** Cuantos dias faltan para que venza, redondeado hacia arriba. */
function daysLeft(expiresAt: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Plantilla
// ---------------------------------------------------------------------------

/**
 * HTML de correo, no de pagina: tablas, estilos en linea y nada de CSS externo.
 * Gmail y Outlook descartan `<style>` y `class` sin avisar.
 *
 * El enlace va ademas como texto plano debajo del boton: hay clientes que no
 * pintan el boton, y un alta que depende de un enlace no puede quedarse sin el.
 */
function renderInvite(input: InviteMailInput, locale: Locale) {
  const copy = emailCopy(locale).invite;
  const days = daysLeft(input.expiresAt);
  const greet = input.contactName
    ? copy.greetNamed(escapeHtml(input.contactName.split(" ")[0]))
    : copy.greet;
  const hotel = escapeHtml(input.hotelName);
  const url = input.url;

  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<div style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;color:#f6f7f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f7f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
<tr><td style="padding:26px 32px 0 32px;">
<p style="margin:0;font-size:19px;font-weight:600;letter-spacing:-0.01em;color:#18181b;">roombir</p>
<p style="margin:2px 0 0 0;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#71717a;">${escapeHtml(copy.eyebrow)}</p>
</td></tr>
<tr><td style="padding:22px 32px 0 32px;">
<h1 style="margin:0 0 14px 0;font-size:22px;line-height:1.3;font-weight:600;color:#09090b;">${escapeHtml(copy.title)}</h1>
<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(greet)}</p>
<p style="margin:0 0 22px 0;font-size:15px;line-height:1.6;color:#3f3f46;">${copy.body(`<strong>${hotel}</strong>`)}</p>
</td></tr>
<tr><td style="padding:0 32px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:10px;background:#18181b;">
<a href="${url}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(copy.cta)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:18px 32px 0 32px;">
<p style="margin:0 0 6px 0;font-size:12.5px;line-height:1.5;color:#71717a;">${escapeHtml(copy.fallback)}</p>
<p style="margin:0;font-size:12.5px;line-height:1.5;word-break:break-all;"><a href="${url}" style="color:#4f46e5;text-decoration:underline;">${escapeHtml(url)}</a></p>
</td></tr>
<tr><td style="padding:22px 32px 28px 32px;">
<div style="border-top:1px solid #e4e4e7;padding-top:16px;">
<p style="margin:0 0 6px 0;font-size:12.5px;line-height:1.6;color:#71717a;">${escapeHtml(copy.expires(days))}</p>
<p style="margin:0;font-size:12.5px;line-height:1.6;color:#a1a1aa;">${escapeHtml(copy.ignore)}</p>
</div>
</td></tr>
</table>
<p style="margin:16px 0 0 0;font-size:11.5px;color:#a1a1aa;">${escapeHtml(copy.footer)}</p>
</td></tr></table></body></html>`;

  const text = [
    greet,
    "",
    copy.bodyText(input.hotelName),
    "",
    url,
    "",
    copy.expires(days),
    copy.ignore,
  ].join("\n");

  return { subject: copy.subject, html, text };
}

/**
 * El otro correo: alguien que YA tiene cuenta vuelve a pedir acceso.
 *
 * Existe para no tener que contestarle al formulario "ese email ya existe": eso
 * convierte el alta en un oraculo para saber que hoteles ya son clientes. El
 * sitio siempre dice lo mismo ("mira tu correo") y la diferencia viaja en el
 * mail, que solo puede leer el dueno de la casilla.
 */
function renderExisting(input: { hotelName: string; loginUrl: string }, locale: Locale) {
  const copy = emailCopy(locale).existing;
  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<div style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;color:#f6f7f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f7f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;">
<tr><td style="padding:26px 32px 0 32px;">
<p style="margin:0;font-size:19px;font-weight:600;color:#18181b;">roombir</p>
</td></tr>
<tr><td style="padding:18px 32px 26px 32px;">
<h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.3;font-weight:600;color:#09090b;">${escapeHtml(copy.title)}</h1>
<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#3f3f46;">${escapeHtml(copy.body)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:10px;background:#18181b;">
<a href="${input.loginUrl}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(copy.cta)}</a>
</td></tr></table>
<p style="margin:18px 0 0 0;font-size:12.5px;line-height:1.6;color:#71717a;">${escapeHtml(copy.forgot)}</p>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [copy.title, "", copy.body, "", input.loginUrl, "", copy.forgot].join("\n");
  return { subject: copy.subject, html, text };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function send(to: string, mail: { subject: string; html: string; text: string }) {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();

  if (!apiKey) {
    // Driver `log`. No es un fallback silencioso: lo unico que evita es que en
    // local haya que tener una cuenta de Resend para probar el alta entera.
    console.warn(
      `[leads:mail:log] sin RESEND_API_KEY -> ${to} :: ${mail.subject}\n${mail.text}`,
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      // Un alta no es una campana: que un autoresponder no conteste ni lo mande
      // a la carpeta de promociones.
      headers: { "X-Auto-Response-Suppress": "OOF, AutoReply" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

export const leadsMailer = {
  async sendInvite(input: InviteMailInput): Promise<void> {
    const locale = resolveLocale(input.locale);
    await send(input.to, renderInvite(input, locale));
  },

  async sendAlreadyRegistered(input: {
    to: string;
    hotelName: string;
    locale: string;
    loginUrl: string;
  }): Promise<void> {
    const locale = resolveLocale(input.locale);
    await send(input.to, renderExisting(input, locale));
  },
};
