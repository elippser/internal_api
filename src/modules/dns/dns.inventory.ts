/**
 * Inventario esperado de la zona `bookfer.com`.
 *
 * Es la traduccion a codigo de DNS-CLOUDFLARE-BOOKFER.md: cada hostname de aca
 * esta referenciado por al menos un `.env.production` del monorepo. Si borras
 * un registro, algo deja de resolver.
 *
 * Sirve para dos cosas:
 *   1. La auditoria (`GET /mkt/dns/audit`): que falta, que sobra y que esta con
 *      el proxy al reves.
 *   2. Los guardarrailes de escritura: `proxy: false` no es una sugerencia, es
 *      lo unico que hace que el hostname funcione. Ponerlo en naranja se
 *      bloquea salvo que se pase `force`.
 *
 * Si agregas un servicio al stack, el registro va ACA y la URL va al
 * `.env.production` de quien lo consume.
 */

/**
 * `proxy` es lo que debe estar en Cloudflare:
 *   true   naranja obligatorio (o al menos esperado)
 *   false  gris obligatorio — hay un motivo tecnico, esta en `warning`
 *   null   da igual / no aplica (TXT, MX)
 */
export interface ExpectedRecord {
  /** Subdominio sin la zona. "" = apex. */
  host: string;
  types: string[];
  service: string;
  purpose: string;
  proxy: boolean | null;
  group: "platform" | "email";
  /** `required` cuenta como falta en la auditoria; `recommended` solo avisa. */
  severity: "required" | "recommended";
  /** Por que el proxy va como va. Se muestra en la UI al bloquear. */
  warning?: string;
  /** Valor sugerido cuando es fijo y lo sabemos (SPF, DMARC). */
  suggestedContent?: string;
}

export const ZONE_DEFAULT = "bookfer.com";

/**
 * Los 17 de plataforma (apex + www + 15 subdominios) + el wildcard de previews.
 * El tipo depende de donde hostees (Vercel = CNAME, Coolify/VPS = A), por eso
 * `types` lista los aceptables y la auditoria no opina sobre cual elegiste.
 */
const PLATFORM: ExpectedRecord[] = [
  {
    host: "",
    types: ["A", "AAAA", "CNAME"],
    service: "mkt-renderer",
    purpose: "Sitio publico de bookfer",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "www",
    types: ["A", "AAAA", "CNAME"],
    service: "—",
    purpose: "Redirect al apex (Redirect Rule, no contenido)",
    proxy: true,
    group: "platform",
    severity: "required",
    warning:
      "Tiene que estar en naranja: la Redirect Rule www → apex la aplica el edge de Cloudflare. En gris nunca corre y queda el sitio duplicado para SEO.",
  },
  {
    host: "app",
    types: ["A", "AAAA", "CNAME"],
    service: "pms-core/app",
    purpose: "El PMS (Next)",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api",
    types: ["A", "AAAA", "CNAME"],
    service: "pms-core/api",
    purpose: "API principal (Express)",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "booking",
    types: ["A", "AAAA", "CNAME"],
    service: "booking-app/web",
    purpose: "Reservas del staff, basePath /reservas",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "web-booking",
    types: ["A", "AAAA", "CNAME"],
    service: "booking-app/web-engine-public",
    purpose: "Motor de reservas publico",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api-booking",
    types: ["A", "AAAA", "CNAME"],
    service: "booking-app/api",
    purpose: "API de reservas",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "rooms",
    types: ["A", "AAAA", "CNAME"],
    service: "rooms-app/web",
    purpose: "Habitaciones, basePath /habitaciones",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api-rooms",
    types: ["A", "AAAA", "CNAME"],
    service: "rooms-app/api",
    purpose: "API de habitaciones",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "staypass",
    types: ["A", "AAAA", "CNAME"],
    service: "staypass-app/web",
    purpose: "Portal del huesped",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api-staypass",
    types: ["A", "AAAA", "CNAME"],
    service: "staypass-app/api",
    purpose: "API del huesped",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "revenue",
    types: ["A", "AAAA", "CNAME"],
    service: "rms-app/web",
    purpose: "Hub Revenue, basePath /revenue",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api-revenue",
    types: ["A", "AAAA", "CNAME"],
    service: "rms-app/api",
    purpose: "API del RMS",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "internal",
    types: ["A", "AAAA", "CNAME"],
    service: "internal-laupser/web",
    purpose: "Panel interno (SPA Vite)",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "api-internal",
    types: ["A", "AAAA", "CNAME"],
    service: "internal-laupser/api",
    purpose: "API interna + motor agentico",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "links",
    types: ["A", "AAAA", "CNAME"],
    service: "linkhub-renderer",
    purpose: "LinkHub publico de cada hotel",
    proxy: true,
    group: "platform",
    severity: "required",
  },
  {
    host: "sites",
    types: ["A", "AAAA", "CNAME"],
    service: "web-renderer",
    purpose: "Sitios de los hoteles (multi-tenant)",
    proxy: false,
    group: "platform",
    severity: "required",
    warning:
      "GRIS obligatorio. Es el target al que los hoteles apuntan su propio dominio por CNAME (CUSTOM_HOSTNAME_CNAME_TARGET). En naranja, Cloudflare no encuentra la zona de ese Host y devuelve error 1014 (CNAME Cross-User Banned): el sitio del hotel no carga nunca. Solo se puede proxiar con Cloudflare for SaaS (Custom Hostnames), que es pago.",
  },
  {
    host: "*.sites",
    types: ["A", "AAAA", "CNAME"],
    service: "web-renderer",
    purpose: "Preview por subsite",
    proxy: false,
    group: "platform",
    severity: "required",
    warning:
      "GRIS obligatorio. El certificado Universal cubre bookfer.com y *.bookfer.com, pero NO un segundo nivel como *.sites.bookfer.com: en naranja cualquier preview da error de certificado. En gris, Traefik emite el wildcard por DNS-01. Para dejarlo naranja hace falta Advanced Certificate Manager (pago). Tiene que coincidir con PREVIEW_DOMAIN del web-renderer y NEXT_PUBLIC_HOST_WEB_RENDERER de pms-core/app.",
  },
];

/** Resend (§6 del doc). Los valores exactos de DKIM y MX los da su panel. */
const EMAIL: ExpectedRecord[] = [
  {
    host: "resend._domainkey",
    types: ["TXT"],
    service: "Resend",
    purpose: "DKIM — sin esto los mails salen sin firmar",
    proxy: null,
    group: "email",
    severity: "recommended",
  },
  {
    host: "send",
    types: ["TXT"],
    service: "Resend",
    purpose: "SPF del subdominio de envio",
    proxy: null,
    group: "email",
    severity: "recommended",
    suggestedContent: "v=spf1 include:amazonses.com ~all",
  },
  {
    host: "send",
    types: ["MX"],
    service: "Resend",
    purpose: "Feedback loop de SES (prioridad 10)",
    proxy: null,
    group: "email",
    severity: "recommended",
  },
  {
    host: "_dmarc",
    types: ["TXT"],
    service: "Resend",
    purpose: "DMARC — Gmail y Outlook ya lo exigen para volumen",
    proxy: null,
    group: "email",
    severity: "recommended",
    suggestedContent: "v=DMARC1; p=none; rua=mailto:dmarc@bookfer.com",
  },
];

export const EXPECTED_RECORDS: ExpectedRecord[] = [...PLATFORM, ...EMAIL];

/**
 * Hostnames que NO hay que crear, con el motivo.
 *
 * `trends` esta en el `.env.production` de internal como
 * `https://trends.bookfer.com`, pero el trends-service solo lo consume
 * api-internal y no tiene ninguna autenticacion: publicarlo es regalar un proxy
 * de scraping de Google. Va por red interna (`http://trends-service:8700`).
 */
export const FORBIDDEN_HOSTS: Array<{ host: string; reason: string }> = [
  {
    host: "trends",
    reason:
      "El trends-service no tiene autenticacion y solo lo consume api-internal. Apunta TRENDS_SERVICE_URL a la red interna (http://trends-service:8700) en vez de exponerlo.",
  },
];

/** `app` + `bookfer.com` → `app.bookfer.com`; "" → `bookfer.com`. */
export function fqdn(host: string, zone: string): string {
  return host === "" || host === "@" ? zone : `${host}.${zone}`;
}

/** Busca la fila del inventario que corresponde a un FQDN + tipo. */
export function expectedFor(
  name: string,
  type: string,
  zone: string,
): ExpectedRecord | null {
  const target = name.toLowerCase();
  return (
    EXPECTED_RECORDS.find(
      (e) =>
        fqdn(e.host, zone).toLowerCase() === target && e.types.includes(type),
    ) ?? null
  );
}

/**
 * La regla de proxy que aplica a un hostname, mire o no el tipo.
 *
 * Se usa como guardarrail de escritura: `sites.` y `*.sites.` no se pueden
 * poner en naranja aunque el tipo con el que los crees no sea el del
 * inventario.
 */
export function proxyRuleFor(
  name: string,
  zone: string,
): { proxy: boolean | null; warning?: string } | null {
  const target = name.toLowerCase();
  const hit = EXPECTED_RECORDS.find(
    (e) => fqdn(e.host, zone).toLowerCase() === target && e.proxy !== null,
  );
  return hit ? { proxy: hit.proxy, warning: hit.warning } : null;
}
