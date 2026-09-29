/**
 * Los videos del sitio público que se montan desde el panel (Marketing › Videos).
 *
 * Cada uno es una línea de tiempo en código dentro de `public-side/mkt-renderer`
 * y se sirve en una ruta por idioma, con el slug traducido: estas rutas son
 * copia de `src/i18n/routes.ts` del renderer (`video`, `videoIa`,
 * `videoPropiedades`, `videoHabitaciones`, …). Si cambia un slug allá, cambia acá.
 *
 * `portada` es el video de siempre: sus montajes son de antes de que hubiera más
 * de un video y no tienen `videoId` en la base; se leen como `portada`.
 */

export const LOCALES = ["es", "en", "pt", "fr", "de"] as const;

type Slugs = Record<(typeof LOCALES)[number], string>;

export type VideoDef = { id: string; title: string; slugs: Slugs };

const same = (p: string): Slugs => ({ es: p, en: p, pt: p, fr: p, de: p });

export const VIDEOS: VideoDef[] = [
  { id: "portada", title: "Video de portada", slugs: same("/video") },
  { id: "ia", title: "Roombir IA", slugs: { es: "/video/ia", en: "/video/ai", pt: "/video/ia", fr: "/video/ia", de: "/video/ki" } },
  { id: "propiedades", title: "Propiedades", slugs: { es: "/video/propiedades", en: "/video/properties", pt: "/video/propriedades", fr: "/video/etablissements", de: "/video/unterkuenfte" } },
  { id: "habitaciones", title: "Habitaciones", slugs: { es: "/video/habitaciones", en: "/video/rooms", pt: "/video/quartos", fr: "/video/chambres", de: "/video/zimmer" } },
  { id: "motor", title: "Motor de reservas", slugs: { es: "/video/motor", en: "/video/booking-engine", pt: "/video/motor-de-reservas", fr: "/video/moteur-de-reservation", de: "/video/buchungsmaschine" } },
  { id: "informes", title: "Informes", slugs: { es: "/video/informes", en: "/video/reports", pt: "/video/relatorios", fr: "/video/rapports", de: "/video/berichte" } },
  { id: "revenue", title: "Revenue", slugs: same("/video/revenue") },
  { id: "marketing", title: "Marketing", slugs: same("/video/marketing") },
];

export const videoDef = (id: string) => VIDEOS.find((v) => v.id === id) ?? null;
export const isLocale = (l: string): l is (typeof LOCALES)[number] => (LOCALES as readonly string[]).includes(l);

/** La ruta pública del video en un idioma (`/en/video/ai`). */
export function videoPath(id: string, locale: string): string {
  const v = videoDef(id);
  return `/${locale}${v && isLocale(locale) ? v.slugs[locale] : "/video"}`;
}

/**
 * Cómo se guarda el idioma de un montaje. La portada usa el idioma pelado (`es`), como siempre; los demás
 * videos lo prefijan (`ia:es`). Así el código viejo —que busca la portada sólo por `locale` y mantiene el
 * índice único `locale_1`, y comparte la base con producción— nunca ve ni choca con un montaje de otro video.
 */
export const storedLocale = (id: string, locale: string) => (id === "portada" ? locale : `${id}:${locale}`);

/** El filtro del montaje de un video en un idioma. El de portada incluye las filas viejas sin `videoId`. */
export function montajeFilter(id: string, locale: string): Record<string, unknown> {
  return id === "portada" ? { locale, videoId: { $in: ["portada", null] } } : { locale: storedLocale(id, locale), videoId: id };
}
