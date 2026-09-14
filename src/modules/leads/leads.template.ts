/**
 * La plantilla de los correos del alta.
 *
 * Vive aparte de `leads.mailer.ts` a proposito: ese archivo es el transporte
 * (a quien y por donde sale) y este es la presentacion (que se ve). Cambiar de
 * SMTP no deberia obligar a tocar una tabla de HTML, y rediseniar el correo no
 * deberia obligar a mirar credenciales.
 *
 * Es HTML de correo, no de pagina: tablas anidadas, estilos en linea y ancho
 * fijo de 600. El `<style>` del head existe solo para el breakpoint de telefono
 * — es progresivo, y si un cliente lo descarta el correo sigue leyendose igual.
 *
 * La paleta sale del manual de marca (§14) y no de la nada:
 *   papel #f2efe8 · tarjeta #fbfaf7 · tinta #14150f · musgo #4e6b28
 *   pistacho #c8e293 · gris #63665a · linea #ddd8ca
 * La regla de la marca es que el color aparece en UNA palabra, UN punto o UN
 * boton — nunca como bloque de fondo, salvo las bandas de tinta. Por eso la
 * cabecera es tinta, el boton es tinta y lo unico verde es el circulo del
 * isotipo, el punto del eyebrow y los numeros de los pasos.
 */

import type { Locale } from "./leads.i18n";
import { emailCopy } from "./leads.i18n";

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Paleta (manual de marca §14)
// ---------------------------------------------------------------------------

const C = {
  paper: "#f2efe8",
  paper2: "#e9e5db",
  card: "#fbfaf7",
  ink: "#14150f",
  brand: "#4e6b28",
  bright: "#c8e293",
  text: "#2b2e25",
  muted: "#63665a",
  line: "#ddd8ca",
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * La fecha de vencimiento en el idioma del correo.
 *
 * Se manda ademas de "vence en N dias" porque los dias relativos obligan a
 * saber cuando llego el mail: quien lo abre el jueves no sabe si "3 dias" se
 * cuentan desde hoy o desde el martes.
 */
function formatDate(date: Date, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

/**
 * El logotipo, sin imagenes.
 *
 * No va como imagen a proposito: Gmail y Outlook bloquean las imagenes remotas
 * por defecto, y la cabecera del correo que ES la puerta de entrada no puede
 * depender de que alguien apriete "mostrar imagenes".
 *
 * El isotipo se arma con cuatro celdas de tabla y border-radius: cupula, hoja
 * (la curva arriba a la izquierda), cuadrado y el circulo, que es lo unico en
 * pistacho sobre la banda de tinta (§13). Mide lo que el alto de la palabra,
 * con la separacion de la version reducida. Outlook de escritorio ignora
 * border-radius y lo muestra como cuatro cuadrados: se degrada, no se rompe.
 */
function wordmark(): string {
  const cell = (radius: string, color: string) =>
    `<td width="9" height="9" style="width:9px;height:9px;padding:0;font-size:0;line-height:0;background:${color};border-radius:${radius};">&nbsp;</td>`;
  const gapX = `<td width="2" style="width:2px;padding:0;font-size:0;line-height:0;">&nbsp;</td>`;
  const gapY = `<tr><td colspan="3" height="2" style="height:2px;padding:0;font-size:0;line-height:0;">&nbsp;</td></tr>`;
  const isotype =
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;">` +
    `<tr>${cell("5px 5px 2px 2px", C.paper)}${gapX}${cell("7px 2px 2px 2px", C.paper)}</tr>` +
    gapY +
    `<tr>${cell("2px", C.paper)}${gapX}${cell("50%", C.bright)}</tr>` +
    `</table>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td valign="middle" style="padding:0 10px 0 0;">${isotype}</td>
<td valign="middle" style="font-family:${FONT};font-size:20px;font-weight:600;letter-spacing:-0.02em;line-height:1;color:${C.paper};">roombir</td>
</tr></table>`;
}

/** Boton a prueba de Outlook: VML para MSO, ancla con padding para el resto. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="border-radius:10px;background:${C.ink};">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="21%" stroke="f" fillcolor="${C.ink}"><w:anchorlock/><center style="color:${C.paper};font-family:${FONT};font-size:15px;font-weight:600;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!-- --><a href="${url}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:${C.paper};text-decoration:none;border-radius:10px;background:${C.ink};">${label}</a><!--<![endif]-->
</td></tr></table>`;
}

/** Los tres pasos, numerados en musgo. Es el unico verde del cuerpo. */
function steps(items: readonly string[]): string {
  const rows = items
    .map(
      (item, i) => `<tr>
<td width="26" valign="top" style="padding:0 0 10px 0;font-family:${FONT};font-size:13px;font-weight:700;color:${C.brand};line-height:1.6;">${i + 1}</td>
<td valign="top" style="padding:0 0 10px 0;font-family:${FONT};font-size:14px;color:${C.text};line-height:1.6;">${escapeHtml(item)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>`;
}

/**
 * El armazon comun a los dos correos.
 *
 * `lang` va en el `<html>` y no es decorativo: es lo que hace que el lector de
 * pantalla lo pronuncie bien y que Gmail no ofrezca traducir un correo que ya
 * esta en el idioma de quien lo lee.
 */
function shell(args: {
  locale: Locale;
  title: string;
  preheader: string;
  body: string;
  footer?: string;
}): string {
  return `<!doctype html>
<html lang="${args.locale}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(args.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
@media only screen and (max-width:620px){
  .sm-pad{padding-left:24px!important;padding-right:24px!important}
  .sm-shell{padding:20px 12px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.paper};font-family:${FONT};color:${C.text};-webkit-font-smoothing:antialiased;">
<div style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;color:${C.paper};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(args.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.paper};"><tr>
<td align="center" class="sm-shell" style="padding:36px 16px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:16px;overflow:hidden;">
<tr><td style="padding:22px 34px;background:${C.ink};" class="sm-pad">${wordmark()}</td></tr>
${args.body}
</table>
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;"><tr>
<td align="center" style="padding:18px 24px 0 24px;font-family:${FONT};font-size:11.5px;line-height:1.6;color:${C.muted};">${escapeHtml(args.footer ?? "")}</td>
</tr></table>
</td></tr></table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Correo 1: el invite
// ---------------------------------------------------------------------------

export interface InviteView {
  contactName?: string;
  hotelName: string;
  url: string;
  expiresAt: Date;
}

export function renderInvite(view: InviteView, locale: Locale): RenderedMail {
  const copy = emailCopy(locale).invite;
  const days = Math.max(
    1,
    Math.ceil((view.expiresAt.getTime() - Date.now()) / 86_400_000),
  );
  const greet = view.contactName
    ? copy.greetNamed(view.contactName.split(" ")[0])
    : copy.greet;
  const hotel = escapeHtml(view.hotelName);
  const url = view.url;

  const body = `<tr><td style="padding:32px 34px 0 34px;" class="sm-pad">
<p style="margin:0 0 18px 0;font-size:11.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${C.muted};">
<span style="color:${C.brand};">&bull;</span>&nbsp;${escapeHtml(copy.eyebrow)}</p>
<h1 style="margin:0 0 18px 0;font-size:25px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${escapeHtml(copy.title)}</h1>
<p style="margin:0 0 14px 0;font-size:15px;line-height:1.65;color:${C.text};">${escapeHtml(greet)}</p>
<p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:${C.text};">${copy.body(`<strong style="font-weight:600;color:${C.ink};">${hotel}</strong>`)}</p>
</td></tr>
<tr><td style="padding:0 34px;" class="sm-pad">${button(url, escapeHtml(copy.cta))}</td></tr>
<tr><td style="padding:20px 34px 0 34px;" class="sm-pad">
<p style="margin:0 0 6px 0;font-size:12.5px;line-height:1.55;color:${C.muted};">${escapeHtml(copy.fallback)}</p>
<p style="margin:0;font-size:12.5px;line-height:1.55;word-break:break-all;"><a href="${url}" style="color:${C.brand};text-decoration:underline;">${escapeHtml(url)}</a></p>
</td></tr>
<tr><td style="padding:26px 34px 0 34px;" class="sm-pad">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.paper2};border-radius:12px;"><tr><td style="padding:20px 22px;">
<p style="margin:0 0 12px 0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">${escapeHtml(copy.stepsTitle)}</p>
${steps(copy.steps)}
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 34px 32px 34px;" class="sm-pad">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:18px;">
<p style="margin:0 0 6px 0;font-size:12.5px;line-height:1.6;color:${C.muted};">${escapeHtml(copy.expiry(days, formatDate(view.expiresAt, locale)))}</p>
<p style="margin:0;font-size:12.5px;line-height:1.6;color:${C.muted};">${escapeHtml(copy.ignore)}</p>
</td></tr></table>
</td></tr>`;

  const html = shell({
    locale,
    title: copy.subject,
    preheader: copy.preheader,
    body,
    footer: copy.footer,
  });

  const text = [
    greet,
    "",
    copy.bodyText(view.hotelName),
    "",
    url,
    "",
    `${copy.stepsTitle}:`,
    ...copy.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    copy.expiry(days, formatDate(view.expiresAt, locale)),
    copy.ignore,
    "",
    copy.footer,
  ].join("\n");

  return { subject: copy.subject, html, text };
}

// ---------------------------------------------------------------------------
// Correo 2: ya tenia cuenta
// ---------------------------------------------------------------------------

/**
 * El correo que evita el oraculo.
 *
 * El formulario contesta lo mismo exista o no la cuenta; la diferencia viaja
 * aca, donde solo llega quien tiene la casilla. Por eso este correo NO dice
 * nada que el sitio no diria: confirma que hay cuenta a quien ya la tiene.
 */
export function renderExisting(
  view: { hotelName: string; loginUrl: string },
  locale: Locale,
): RenderedMail {
  const copy = emailCopy(locale).existing;

  const body = `<tr><td style="padding:32px 34px 0 34px;" class="sm-pad">
<h1 style="margin:0 0 18px 0;font-size:23px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${escapeHtml(copy.title)}</h1>
<p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:${C.text};">${escapeHtml(copy.body)}</p>
</td></tr>
<tr><td style="padding:0 34px;" class="sm-pad">${button(view.loginUrl, escapeHtml(copy.cta))}</td></tr>
<tr><td style="padding:22px 34px 32px 34px;" class="sm-pad">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid ${C.line};padding-top:18px;">
<p style="margin:0;font-size:12.5px;line-height:1.6;color:${C.muted};">${escapeHtml(copy.forgot)}</p>
</td></tr></table>
</td></tr>`;

  const html = shell({
    locale,
    title: copy.subject,
    preheader: copy.preheader,
    body,
    footer: emailCopy(locale).invite.footer,
  });

  const text = [
    copy.title,
    "",
    copy.body,
    "",
    view.loginUrl,
    "",
    copy.forgot,
  ].join("\n");

  return { subject: copy.subject, html, text };
}
