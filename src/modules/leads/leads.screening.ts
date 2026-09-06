import type { Request } from "express";
import type { LeadRiskFlag } from "./leads.model";

/**
 * El filtro del formulario publico.
 *
 * El endpoint de captura es la unica superficie sin autenticacion que ESCRIBE
 * en la base y ademas dispara un mail. Sin filtro, un script lo usa para tres
 * cosas distintas: llenar la base de basura, quemar la reputacion del dominio
 * mandando correos a direcciones ajenas (mail bombing con nuestro remitente), y
 * fabricarse invites para entrar al PMS.
 *
 * Ninguna capa alcanza sola, asi que hay cuatro y son independientes:
 *
 * 1. **Techo por IP y por email** (abajo). Es lo que corta el volumen.
 * 2. **Senales del formulario** (honeypot, tiempo, interaccion). Cortan al bot
 *    que postea sin renderizar la pagina.
 * 3. **Calidad del destinatario** (dominios descartables, sintaxis). Corta al
 *    que igual pasaria las dos anteriores.
 * 4. **Turnstile** (opcional, si hay clave). Es la unica que ve el visitante y
 *    por eso es la ultima: sin ella el formulario sigue defendido.
 *
 * Nada de esto vive en el proxy de Next: ese cuenta por IP del servidor cuando
 * hay un proxy delante, y ademas un atacante puede saltearse el sitio entero y
 * pegarle directo a esta API. Los limites de verdad son los de aca.
 */

// ---------------------------------------------------------------------------
// Rate limit en memoria
// ---------------------------------------------------------------------------

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/**
 * Ventana deslizante simple, en memoria del proceso.
 *
 * En memoria y no en Mongo a proposito: el caso que importa es el burst (mil
 * envios en un minuto) y ahi una escritura por intento seria el ataque en si
 * mismo. Con varias instancias cada una tiene su cuota, que es un techo peor
 * pero nunca mas permisivo que no tener ninguno.
 */
function hit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  const limited = bucket.hits.length >= max;
  if (!limited) bucket.hits.push(now);
  buckets.set(key, bucket);
  return limited;
}

/**
 * Limpieza perezosa: se corre en cada captura y borra las claves vencidas.
 *
 * Va aca y no en un `setInterval` porque sin proceso de fondo el mapa no puede
 * crecer sin techo, y un intervalo mantendria vivo el event loop del API por
 * una tabla de rate limit.
 */
function sweep(maxWindowMs: number) {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t >= maxWindowMs)) buckets.delete(key);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export interface RateVerdict {
  limited: boolean;
  /** Que techo se toco. Va al log, nunca a la respuesta. */
  scope?: "ip_hour" | "ip_day" | "email_day" | "global_hour";
}

/** Los cuatro techos, del mas especifico al mas general. */
export function checkRate(ip: string, email: string): RateVerdict {
  sweep(DAY);

  const perIpHour = num(process.env.LEADS_MAX_PER_IP_HOUR, 5);
  const perIpDay = num(process.env.LEADS_MAX_PER_IP_DAY, 12);
  const perEmailDay = num(process.env.LEADS_MAX_PER_EMAIL_DAY, 3);
  // Techo de todo el formulario. Es el freno de mano: si alguien encontro la
  // forma de rotar IPs, esto acota el dano a algo que se puede revisar a mano.
  const globalHour = num(process.env.LEADS_MAX_GLOBAL_HOUR, 120);

  if (hit("global", HOUR, globalHour)) return { limited: true, scope: "global_hour" };
  if (ip && hit(`ip:${ip}`, HOUR, perIpHour)) return { limited: true, scope: "ip_hour" };
  if (ip && hit(`ipd:${ip}`, DAY, perIpDay)) return { limited: true, scope: "ip_day" };
  if (email && hit(`em:${email}`, DAY, perEmailDay)) {
    return { limited: true, scope: "email_day" };
  }
  return { limited: false };
}

/** Solo para los tests y el smoke: vacia los contadores. */
export function resetRateLimits() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// La IP del visitante
// ---------------------------------------------------------------------------

/**
 * La IP real, no la del proxy.
 *
 * El sitio publico postea desde su propio servidor (Next), asi que la IP del
 * visitante llega en `x-forwarded-for` que ese servidor reenvia. Se toma el
 * PRIMER elemento: los siguientes son los proxies intermedios. Un cliente puede
 * mentir en ese header, pero para eso estan las otras capas — y el techo global
 * no depende de la IP.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) return raw.split(",")[0].trim().slice(0, 60);
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return real.trim().slice(0, 60);
  return (req.ip ?? "").slice(0, 60);
}

// ---------------------------------------------------------------------------
// Calidad del email
// ---------------------------------------------------------------------------

/**
 * Dominios de correo temporal mas comunes.
 *
 * La lista corta a proposito: no pretende ser exhaustiva (hay miles y cambian
 * todas las semanas), sino sacar del medio el 90% del ruido sin bloquear a
 * nadie real. Ampliable sin tocar codigo con LEADS_BLOCKED_EMAIL_DOMAINS.
 */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mailnesia.com",
  "mytemp.email",
  "spamgourmet.com",
  "mohmal.com",
  "emailondeck.com",
  "moakt.com",
  "tempr.email",
  "discard.email",
  "inboxbear.com",
  "mail-temp.com",
  "burnermail.io",
]);

/**
 * Buzones de rol. No se bloquean: quien administra un hotel chico usa
 * `info@` como correo real y bloquearlo seria perder clientes. Solo suma una
 * bandera, para que el panel sepa que el destinatario puede ser compartido.
 */
const ROLE_LOCAL_PARTS = new Set([
  "info",
  "admin",
  "contacto",
  "contact",
  "ventas",
  "sales",
  "soporte",
  "support",
  "hola",
  "hello",
  "noreply",
  "no-reply",
  "postmaster",
  "webmaster",
  "abuse",
]);

/** RFC-lite: alcanza para un formulario y no rechaza direcciones validas raras. */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function blockedDomains(): Set<string> {
  const extra = (process.env.LEADS_BLOCKED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (extra.length === 0) return DISPOSABLE_DOMAINS;
  return new Set([...DISPOSABLE_DOMAINS, ...extra]);
}

export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return true;
  if (blockedDomains().has(domain)) return true;
  // Subdominios de un descartable (`x.mailinator.com`) cuentan igual.
  return [...blockedDomains()].some((d) => domain.endsWith(`.${d}`));
}

export function isRoleEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROLE_LOCAL_PARTS.has(local);
}

// ---------------------------------------------------------------------------
// Senales del formulario
// ---------------------------------------------------------------------------

/** Texto que no tiene nada que hacer en el nombre de un hotel. */
const SPAM_TEXT_RE =
  /(https?:\/\/|www\.|<\s*a\s|\[url|\{\{|\$\{|viagra|casino|crypto|seo\s+service|backlink)/i;

export interface ScreeningInput {
  /** El campo trampa. Si trae algo lo completo un bot. */
  honeypot?: string;
  /** Milisegundos entre el render del formulario y el submit. */
  elapsedMs?: number | null;
  /** Si hubo teclado/puntero/foco real sobre el formulario. */
  interacted?: boolean;
  email: string;
  hotelName: string;
  city?: string;
  contactName?: string;
  /** Resultado de Turnstile, cuando esta configurado. */
  captchaOk?: boolean | null;
}

export interface ScreeningVerdict {
  score: number;
  flags: LeadRiskFlag[];
  /** Descartar en silencio: se guarda como `spam` y NO sale ningun mail. */
  drop: boolean;
  /** Rechazar con un mensaje util: el visitante puede corregirlo. */
  reject: "disposable_email" | null;
}

/**
 * Tiempo minimo verosimil para completar el formulario a mano. Cuatro campos y
 * un correo no se tipean en menos de dos segundos y medio, y un bot headless
 * suele tardar decenas de milisegundos.
 */
const MIN_ELAPSED_MS = 2500;

export function screen(input: ScreeningInput): ScreeningVerdict {
  const flags: LeadRiskFlag[] = [];
  let score = 0;

  if ((input.honeypot ?? "").trim().length > 0) {
    flags.push("honeypot");
    score += 100;
  }

  if (typeof input.elapsedMs === "number" && input.elapsedMs >= 0) {
    if (input.elapsedMs < MIN_ELAPSED_MS) {
      flags.push("too_fast");
      score += 60;
    }
  }

  // `interacted === false` es informacion; `undefined` es un cliente viejo o un
  // navegador raro y no se castiga.
  if (input.interacted === false) {
    flags.push("no_interaction");
    score += 40;
  }

  if (input.captchaOk === false) {
    flags.push("captcha_failed");
    score += 100;
  }

  if (isRoleEmail(input.email)) {
    flags.push("role_email");
    score += 5;
  }

  const text = `${input.hotelName} ${input.city ?? ""} ${input.contactName ?? ""}`;
  if (SPAM_TEXT_RE.test(text)) {
    flags.push("suspicious_text");
    score += 50;
  }

  const disposable = isDisposableEmail(input.email);
  if (disposable) {
    flags.push("disposable_email");
    score += 30;
  }

  return {
    score,
    flags,
    // 60 = una senal fuerte sola (honeypot, tiempo imposible, captcha fallido)
    // o dos debiles juntas. El descartable NO entra por aca: ese se contesta.
    drop: score - (disposable ? 30 : 0) >= 60,
    reject: disposable ? "disposable_email" : null,
  };
}

// ---------------------------------------------------------------------------
// Turnstile (opcional)
// ---------------------------------------------------------------------------

/**
 * Verifica el token de Cloudflare Turnstile.
 *
 * Devuelve `null` cuando no hay clave configurada: el captcha es un refuerzo,
 * no el porton. Si esta configurado y el proveedor no responde, se falla
 * CERRADO (`false`): con captcha activo, un corte del verificador no puede
 * convertirse en la puerta abierta que el captcha venia a cerrar.
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip: string,
): Promise<boolean | null> {
  const secret = (process.env.LEADS_TURNSTILE_SECRET ?? "").trim();
  if (!secret) return null;
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body },
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch (err) {
    console.error("[leads] turnstile no respondio:", err);
    return false;
  }
}
