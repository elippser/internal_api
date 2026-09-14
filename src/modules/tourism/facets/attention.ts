/**
 * Interés online: vistas de Wikipedia del destino.
 *
 * El hub cachea sus fallas como dato: un error de pageviews queda `null` 6 h y
 * un artículo no resuelto 30 días. Un `totalViews` en 0 casi nunca significa
 * "nadie mira este destino": significa "no se pudo leer". Se proyecta como
 * DESCONOCIDO, nunca como cero.
 */

import type { AttentionPointPayload } from "../../attention/attention.types";
import type { AttentionSlim, Projection } from "../tourism.types";

/** El hub rotula sin eñes ("Espaniol"): el nombre que ve el usuario va acá. */
const LANGUAGE_NAME: Record<string, string> = {
  es: "español",
  en: "inglés",
  pt: "portugués",
  de: "alemán",
  fr: "francés",
  it: "italiano",
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const toIsoDate = (yyyymmdd: string): string =>
  /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : yyyymmdd;

/**
 * Última semana contra la mediana de las cuatro anteriores. Mediana y no
 * promedio: un pico viejo inflaría la base y escondería el actual (mismo
 * criterio que la detección de picos del hub).
 */
export function weeklyTrendPct(series: Array<{ views: number }>): number | null {
  if (series.length < 35) return null;
  const recent = series.slice(-7).map((x) => x.views);
  const base = median(series.slice(-35, -7).map((x) => x.views));
  if (base <= 0) return null;
  const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
  return Math.round((mean / base - 1) * 100);
}

export function projectAttention(p: AttentionPointPayload | null): Projection<AttentionSlim> {
  if (!p) return { data: null, missing: ["interés online"] };
  if (!p.coverage.article || !p.article.title || p.totalViews <= 0 || p.byLanguage.length === 0) {
    return {
      data: null,
      missing: ["interés online (no se encontró el artículo de Wikipedia o no respondió)"],
    };
  }

  const series = p.series.map((s) => ({ date: toIsoDate(s.date), views: s.views }));
  const days = Math.max(1, p.window.days);

  return {
    data: {
      article: p.article.title,
      place: p.article.place,
      resolvedVia: p.article.resolvedVia,
      weeklyViews: Math.round((p.totalViews / days) * 7),
      trendPct: weeklyTrendPct(series),
      seriesEdition: p.byLanguage.some((l) => l.code === "es") ? "es" : (p.byLanguage[0]?.code ?? null),
      spikeRatio: p.spike ? Number(p.spike.ratio.toFixed(2)) : null,
      spikeSince: p.spike?.since ? toIsoDate(p.spike.since) : null,
      topLanguages: p.byLanguage
        .slice(0, 3)
        .map((l) => ({ code: l.code, label: LANGUAGE_NAME[l.code] ?? l.label, share: l.share })),
      series: series.slice(-30),
    },
    missing: [],
  };
}
