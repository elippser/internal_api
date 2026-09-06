// Hub de comportamiento y tendencias del consumidor (event-list.md §13).
//
// LA ATENCION PRECEDE A LA RESERVA
// Esta categoria pregunta si un destino se puso de moda, si lo cubrieron los
// medios, si salio en una serie. Todo eso tiene una huella medible comun: la
// gente lo busca. Las vistas del articulo de Wikipedia son el proxy estandar
// para eso — es la unica serie de atencion publica, oficial, diaria, con
// historia y sin clave. Google Trends no tiene API abierta.
//
// El valor no es saber cuanta gente miro: es que la atencion ANTECEDE a la
// reserva por semanas. Un pico hoy es demanda despues.
//
// Y POR IDIOMA ES POR MERCADO
// Wikipedia publica las vistas separadas por edicion idiomatica. Medido sobre
// Bariloche en 30 dias: 7.554 en espaniol, 740 en ingles, 54 en portugues. Eso
// no es una curiosidad — dice QUE mercado esta mirando, y se lee en fila con el
// §6 (para quien es barato) y el §7 (quien puede volar).
//
// LO QUE NO SE SIMULA
// Redes sociales, influencers y reseñas no tienen fuente abierta, y las
// tendencias generacionales (workation, revenge travel) no son un dato de un
// punto del mapa: son marcos de lectura. Se declaran.

import { fetchJson } from "../intelligence/core/http";
import type {
  AttentionPointPayload,
  AttentionCoverage,
  LanguageAttention,
  NearbyArticle,
  Spike,
} from "./attention.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const PAGEVIEWS_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";
const UA = "roombir-internal-attention-hub/1.0 (+https://roombir.com)";

/**
 * Idiomas que se consultan. Son los de los mercados emisores del producto, no
 * los mas hablados del mundo: sumar chino o hindi daria volumen y ninguna
 * lectura accionable para estas plazas.
 */
const LANGS: Array<{ code: string; label: string }> = [
  { code: "es", label: "Espaniol" },
  { code: "en", label: "Ingles" },
  { code: "pt", label: "Portugues" },
  { code: "de", label: "Aleman" },
  { code: "fr", label: "Frances" },
  { code: "it", label: "Italiano" },
];

// ── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 400;

async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await load();
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { ts: Date.now(), value });
  return value;
}

const TTL_GEO = 30 * 24 * 60 * 60 * 1000;
// Wikipedia publica las vistas con un dia de atraso: cachear 6 h es de sobra.
const TTL_VIEWS = 6 * 60 * 60 * 1000;

const stamp = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, "") + "00";

// ── Resolucion del articulo ───────────────────────────────────────────────

/**
 * De un punto al articulo que lo representa.
 *
 * Primero se prueba el nombre de la localidad que da Nominatim, porque es lo
 * que la gente busca. La busqueda geografica de Wikipedia queda de respaldo:
 * devuelve lo que este mas cerca de las coordenadas, que suele ser un
 * monumento —"Centro Civico Bariloche" a 10 m— y no la ciudad.
 */
async function resolveArticle(
  lat: number,
  lng: number,
): Promise<{ title: string | null; place: string | null; via: string }> {
  const key = "article:" + lat.toFixed(2) + ":" + lng.toFixed(2);
  return memo(key, TTL_GEO, async () => {
    let place: string | null = null;
    try {
      const geo = await fetchJson<{ address?: Record<string, string> }>(
        NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=12&addressdetails=1",
        { headers: { "user-agent": UA }, timeoutMs: 12_000, retries: 1 },
      );
      const a = geo.address ?? {};
      place = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null;
    } catch {
      place = null;
    }

    if (place) {
      const title = place.replace(/ /g, "_");
      // Se valida contra la propia serie: si el articulo no existe, la API
      // devuelve 404 y conviene saberlo antes de construir el payload.
      const ok = await hasViews("es", title);
      if (ok) return { title, place, via: "nominatim" };
    }

    try {
      const gs = await fetchJson<{ query?: { geosearch?: Array<{ title: string }> } }>(
        "https://es.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=" +
          lat + "%7C" + lng + "&gsradius=10000&gslimit=1&format=json",
        { headers: { "user-agent": UA }, timeoutMs: 12_000, retries: 1 },
      );
      const first = gs.query?.geosearch?.[0];
      if (first) return { title: first.title.replace(/ /g, "_"), place, via: "geosearch" };
    } catch {
      // Sin articulo: el payload lo declara.
    }
    return { title: null, place, via: "none" };
  });
}

/**
 * Titulo del articulo en cada edicion idiomatica.
 *
 * Es imprescindible y no es un detalle: el titulo cambia de idioma en idioma
 * ("Kioto" en espaniol, "Kyoto" en ingles, "Londres"/"London"). Consultando el
 * mismo titulo contra todas las ediciones, el ingles devuelve casi cero y el
 * hub concluye que a Kioto lo miran los hispanohablantes — exactamente al
 * reves de la realidad. Se resuelven los enlaces interlinguisticos primero.
 */
async function langTitles(title: string): Promise<Record<string, string>> {
  const key = "langlinks:" + title;
  return memo(key, TTL_GEO, async () => {
    const out: Record<string, string> = { es: title };
    try {
      const data = await fetchJson<{
        query?: { pages?: Record<string, { langlinks?: Array<{ lang: string; "*": string }> }> };
      }>(
        "https://es.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=" +
          encodeURIComponent(title.replace(/_/g, " ")) +
          "&lllimit=500&format=json",
        { headers: { "user-agent": UA }, timeoutMs: 15_000, retries: 1 },
      );
      const pages = data.query?.pages ?? {};
      for (const p of Object.values(pages)) {
        for (const l of p.langlinks ?? []) {
          if (l.lang && l["*"]) out[l.lang] = l["*"].replace(/ /g, "_");
        }
      }
    } catch {
      // Sin enlaces: queda solo el titulo en espaniol y los demas idiomas se
      // consultan con el mismo, que es el comportamiento anterior.
    }
    return out;
  });
}

interface PageviewItem { timestamp: string; views: number }

async function pageviews(lang: string, title: string, days: number): Promise<PageviewItem[] | null> {
  const to = new Date(Date.now() - 86_400_000);
  const from = new Date(to.getTime() - days * 86_400_000);
  const key = "pv:" + lang + ":" + title + ":" + days;
  return memo(key, TTL_VIEWS, async () => {
    try {
      const data = await fetchJson<{ items?: PageviewItem[] }>(
        PAGEVIEWS_BASE + "/" + lang + ".wikipedia/all-access/user/" +
          encodeURIComponent(title) + "/daily/" + stamp(from) + "/" + stamp(to),
        { headers: { "user-agent": UA }, timeoutMs: 20_000, retries: 1 },
      );
      return data.items ?? [];
    } catch {
      // 404 = el articulo no existe en esa edicion. Es normal, no un fallo.
      return null;
    }
  });
}

const hasViews = async (lang: string, title: string): Promise<boolean> => {
  const it = await pageviews(lang, title, 30);
  return it !== null && it.length > 0;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const round = (n: number, d = 2): number => Number(n.toFixed(d));

/**
 * Pico de atencion: la ultima semana contra la mediana de la ventana previa.
 *
 * Se usa la MEDIANA y no el promedio a proposito — un pico anterior dentro de
 * la ventana inflaria el promedio y escondería el pico actual. Y se exige 50%
 * por encima: la atencion es ruidosa y un 20% es un martes cualquiera.
 */
function detectSpike(items: PageviewItem[]): Spike | null {
  if (items.length < 30) return null;
  const views = items.map((x) => x.views);
  const last7 = views.slice(-7);
  const baselineWindow = views.slice(0, -7);
  if (!baselineWindow.length) return null;

  const sorted = [...baselineWindow].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return null;

  const current = mean(last7);
  const ratio = current / median;
  if (ratio < 1.5) return null;

  return {
    ratio: round(ratio, 2),
    currentDailyMean: Math.round(current),
    baselineDailyMedian: median,
    since: items[items.length - 7]?.timestamp.slice(0, 8) ?? "",
  };
}

// ── Endpoint ──────────────────────────────────────────────────────────────

export async function getAttentionPoint(
  lat: number,
  lng: number,
  days = 180,
): Promise<AttentionPointPayload> {
  const gaps: string[] = [];
  const { title, place, via } = await resolveArticle(lat, lng);

  if (!title) {
    gaps.push("No se encontro un articulo de Wikipedia para este punto: sin serie de atencion");
  }

  const byLanguage: LanguageAttention[] = [];
  let mainSeries: PageviewItem[] = [];

  if (title) {
    // Cada edicion con SU titulo: ver langTitles().
    const titles = await langTitles(title);
    const results = await Promise.all(
      LANGS.map(async (l) => ({
        lang: l,
        title: titles[l.code] ?? title,
        items: await pageviews(l.code, titles[l.code] ?? title, days),
      })),
    );
    for (const r of results) {
      if (!r.items || !r.items.length) continue;
      const total = r.items.reduce((s, x) => s + x.views, 0);
      byLanguage.push({
        code: r.lang.code,
        label: r.lang.label,
        title: r.title,
        totalViews: total,
        dailyMean: Math.round(total / r.items.length),
        share: 0,
        spike: detectSpike(r.items),
      });
      if (r.lang.code === "es" || !mainSeries.length) mainSeries = r.items;
    }
    const grand = byLanguage.reduce((s, l) => s + l.totalViews, 0);
    for (const l of byLanguage) l.share = grand ? round(l.totalViews / grand, 3) : 0;
    byLanguage.sort((a, b) => b.totalViews - a.totalViews);
  }

  // ── Articulos cercanos: que atrae la atencion alrededor ──
  let nearby: NearbyArticle[] = [];
  try {
    const gs = await memo(
      "geo:near:" + lat.toFixed(2) + ":" + lng.toFixed(2),
      TTL_GEO,
      () =>
        fetchJson<{ query?: { geosearch?: Array<{ title: string; dist: number }> } }>(
          "https://es.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=" +
            lat + "%7C" + lng + "&gsradius=10000&gslimit=8&format=json",
          { headers: { "user-agent": UA }, timeoutMs: 12_000, retries: 1 },
        ),
    );
    nearby = (gs.query?.geosearch ?? []).map((g) => ({
      title: g.title,
      distanceM: Math.round(g.dist),
    }));
  } catch {
    gaps.push("La busqueda geografica de Wikipedia no respondio: sin hitos cercanos");
  }

  const spike = byLanguage.find((l) => l.spike)?.spike ?? null;
  const total = byLanguage.reduce((s, l) => s + l.totalViews, 0);

  // Serie recortada para el grafico del panel: 90 dias alcanzan y el payload
  // no se infla.
  const series = mainSeries.slice(-90).map((x) => ({ date: x.timestamp.slice(0, 8), views: x.views }));

  gaps.push(
    "Las ediciones de Wikipedia tienen trafico base muy distinto (la inglesa recibe un orden de magnitud mas): las proporciones comparan VOLUMEN, no cuantos viajeros hay detras. Lo comparable es la misma edicion entre destinos, o su pico contra su propia base",
  );
  gaps.push("Redes sociales e influencers: sin API abierta; lo viral solo se ve reflejado en la atencion");
  gaps.push("Reseñas y calificacion online: son dato del PMS y de cada OTA, no de un punto del mapa");
  gaps.push("Google Trends no tiene API publica: Wikipedia es el sustituto disponible");
  gaps.push(
    "Workation, turismo sostenible, revenge travel: son marcos de lectura del mercado, no un dato geolocalizable",
  );

  const coverage: AttentionCoverage = {
    article: title !== null,
    languages: byLanguage.length,
    gaps,
  };

  return {
    location: { lat, lng },
    article: { title, place, resolvedVia: via, url: title ? "https://es.wikipedia.org/wiki/" + title : null },
    window: { days },
    totalViews: total,
    byLanguage,
    spike,
    series,
    nearby,
    coverage,
    sources: ["Wikimedia Pageviews API", "Wikipedia geosearch", "OpenStreetMap Nominatim"],
    timestamp: new Date().toISOString(),
  };
}
