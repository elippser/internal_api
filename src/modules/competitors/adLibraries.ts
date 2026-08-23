/**
 * Bibliotecas públicas de anuncios (spec v2.1).
 *
 * NO hay rastreo automático: se probó y no existe una vía legítima.
 *   · Meta Ad Library (página pública y su endpoint async): 403 con challenge
 *     de JavaScript. Pasarlo sería evasión, que este módulo no hace.
 *   · Meta Graph `ads_archive`: pide token y **sólo cubre anuncios políticos y
 *     de temas sociales**; los comerciales (los que corre un PMS) no están.
 *   · Google Ads Transparency: responde sin auth, pero es un RPC interno sin
 *     documentar (400 salvo con su payload protobuf exacto), que cambia sin
 *     aviso.
 *
 * Entonces: un click a la biblioteca ya filtrada por el competidor, y el
 * anuncio se registra a mano (`ads[]`). Mismo criterio que v1 con el battle
 * set: la herramienta ahorra tipeo, la curación es humana.
 */

export interface AdLibraryLink {
  network: "meta" | "google" | "linkedin" | "tiktok";
  label: string;
  url: string;
  hint: string;
}

/** País por defecto para las bibliotecas que lo piden (ISO-2). */
const DEFAULT_COUNTRY = (process.env.CI_AD_LIBRARY_COUNTRY ?? "AR").toUpperCase();

export function adLibraryLinks(input: { name: string; websiteDomain: string; geoFocus?: string[] }): AdLibraryLink[] {
  const q = encodeURIComponent(input.name);
  const domain = encodeURIComponent(input.websiteDomain);
  // Si el competidor declara un país concreto, se usa el primero; si no, el default.
  const country = (input.geoFocus ?? []).map((g) => String(g).toUpperCase()).find((g) => /^[A-Z]{2}$/.test(g)) ?? DEFAULT_COUNTRY;
  return [
    {
      network: "meta",
      label: "Meta Ad Library",
      url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered&media_type=all`,
      hint: `Anuncios activos en Facebook e Instagram (país ${country}). Filtrá por la página oficial del competidor.`,
    },
    {
      network: "google",
      label: "Google Ads Transparency",
      url: `https://adstransparency.google.com/?region=${country}&domain=${domain}`,
      hint: "Anuncios de Búsqueda, YouTube y Display asociados al dominio.",
    },
    {
      network: "linkedin",
      label: "LinkedIn Ad Library",
      url: `https://www.linkedin.com/ad-library/search?keyword=${q}`,
      hint: "Anuncios de LinkedIn de los últimos 12 meses.",
    },
    {
      network: "tiktok",
      label: "TikTok Creative Center",
      url: `https://ads.tiktok.com/business/creativecenter/topads/pc/en?search=${q}`,
      hint: "Anuncios destacados de TikTok (cobertura parcial).",
    },
  ];
}
