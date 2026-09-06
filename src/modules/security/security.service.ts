// Hub de seguridad y estabilidad (event-list.md §9).
//
// LA ALERTA ES EL MECANISMO DE TRANSMISION
// Un hotel no pierde reservas porque suba el delito. Las pierde cuando la
// cancilleria de un mercado emisor sube el nivel de alerta, porque ese acto
// activa las prohibiciones de viaje corporativo y las exclusiones de los
// seguros. Por eso las alertas son la columna del payload y el homicidio va
// como contexto, aunque el homicidio sea el dato "duro" de los dos.
//
// DOS GOBIERNOS PARA PODER VER DESACUERDO
// Canada y Estados Unidos publican con escalas equivalentes (0-3 y 1-4), asi
// que se normalizan a 1-4 y se comparan. Cuando difieren dos escalones el
// riesgo esta en disputa: no es un error de datos, es informacion.
//
// LO QUE NO SE MEZCLA
// El indice de percepcion de inseguridad no tiene fuente abierta (Numbeo no
// publica API gratuita) y no se inventa a partir del tono de las noticias.
// Queda declarado como hueco.

import { fetchJson } from "../intelligence/core/http";
import { COUNTRY_NAME, ISO3 } from "../economy/reference";
import { LEVEL_LABEL, advisorySet, isoForName, type AdvisoryLevel } from "./advisories";
import type {
  Advisory,
  Indicator,
  Outbreak,
  SecurityCoverage,
  SecurityPointPayload,
  UnrestItem,
} from "./security.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const WB_BASE = "https://api.worldbank.org/v2";
const WHO_DON =
  "https://www.who.int/api/news/diseaseoutbreaknews?sf_provider=dynamicProvider372&sf_culture=en&%24orderby=PublicationDateAndTime%20desc&%24top=60&%24format=json";
const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";

const UA = "roombir-internal-security-hub/1.0 (+https://roombir.com)";

// ── Cache con TTL ─────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 500;

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
const TTL_CRIME = 7 * 24 * 60 * 60 * 1000;
const TTL_OUTBREAK = 6 * 60 * 60 * 1000;
// GDELT tarda entre 20 y 40 s y se cae seguido: se cachea largo para que el
// panel no dependa de que responda dos veces seguidas.
const TTL_UNREST = 60 * 60 * 1000;

async function resolveCountry(lat: number, lng: number) {
  const key = "geo:" + lat.toFixed(1) + ":" + lng.toFixed(1);
  return memo(key, TTL_GEO, async () => {
    const data = await fetchJson<{ address?: Record<string, string> }>(
      NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=5&addressdetails=1",
      { headers: { "user-agent": UA }, timeoutMs: 12_000, retries: 1 },
    );
    const addr = data.address ?? {};
    return {
      countryCode: (addr.country_code ?? "").toUpperCase(),
      countryName: addr.country ?? "",
    };
  });
}

// ── Homicidios (Banco Mundial) ────────────────────────────────────────────

interface WbRow {
  countryiso3code: string;
  date: string;
  value: number | null;
}

/**
 * Tasa de homicidios de todos los paises en una sola llamada, igual que el
 * hub economico: el indicador no cambia de un dia para otro y sirve para el
 * destino y para cualquier comparacion.
 */
async function homicideRates(): Promise<Map<string, { value: number; year: number }>> {
  return memo("wb:homicide", TTL_CRIME, async () => {
    const raw = await fetchJson<[unknown, WbRow[] | null]>(
      WB_BASE + "/country/all/indicator/VC.IHR.PSRC.P5?format=json&mrv=1&per_page=400",
      { timeoutMs: 25_000, retries: 1 },
    );
    const rows = Array.isArray(raw) ? raw[1] ?? [] : [];
    const out = new Map<string, { value: number; year: number }>();
    for (const r of rows) {
      if (!r || r.value === null || !Number.isFinite(r.value)) continue;
      out.set(r.countryiso3code, { value: r.value, year: Number(r.date) });
    }
    return out;
  });
}

// ── Brotes (OMS) ──────────────────────────────────────────────────────────

interface WhoItem {
  Title?: string;
  OverrideTitle?: string;
  PublicationDate?: string;
  ItemDefaultUrl?: string;
  UrlName?: string;
}

/**
 * Disease Outbreak News de la OMS. No trae codigo de pais: el nombre viene
 * dentro del titulo ("Ebola ... - Democratic Republic of the Congo"), asi que
 * se lo cruza contra el indice de nombres que ya arma el modulo de alertas.
 */
async function outbreaksFor(cc: string, isoByName: Map<string, string>): Promise<Outbreak[]> {
  return memo("who:don", TTL_OUTBREAK, async () => {
    const data = await fetchJson<{ value?: WhoItem[] }>(WHO_DON, {
      headers: { "user-agent": UA },
      timeoutMs: 25_000,
      retries: 1,
    });
    return data.value ?? [];
  }).then((items) =>
    items
      .map((it) => {
        const title = it.OverrideTitle || it.Title || "";
        // El pais va despues del ultimo guion del titulo.
        const dash = title.lastIndexOf(" - ");
        const tail = dash === -1 ? "" : title.slice(dash + 3);
        const iso = isoForName(tail, isoByName);
        return { title, iso, publishedAt: (it.PublicationDate ?? "").slice(0, 10), url: it.ItemDefaultUrl ?? null };
      })
      .filter((x) => x.iso === cc)
      .map((x) => ({
        title: x.title,
        publishedAt: x.publishedAt,
        url: x.url ? "https://www.who.int" + x.url : null,
      }))
      .slice(0, 6),
  );
}

// ── Conflictividad social (GDELT) ─────────────────────────────────────────

interface GdeltArticle {
  title?: string;
  url?: string;
  domain?: string;
  seendate?: string;
}

const UNREST_TERMS =
  '(protest OR protesta OR manifestacion OR huelga OR paro OR piquete OR disturbios OR riot)';

/**
 * Noticias de conflictividad social del pais, ultimos dias.
 *
 * Es la parte mas fragil del hub: GDELT tarda 20-40 s, devuelve 000 seguido y
 * no garantiza cobertura pareja por pais. Va como mejor esfuerzo — si no
 * contesta, el bloque se declara no disponible y el resto del payload sigue
 * intacto. Nunca se convierte su silencio en "no hay conflictividad".
 */
async function unrestFor(cc: string, windowDays: number): Promise<UnrestItem[] | null> {
  const key = "gdelt:" + cc + ":" + windowDays;
  return memo(key, TTL_UNREST, async () => {
    try {
      const url =
        GDELT_DOC +
        "?query=" +
        encodeURIComponent(UNREST_TERMS + " sourcecountry:" + cc) +
        "&mode=artlist&format=json&maxrecords=15&timespan=" +
        windowDays +
        "d";
      const res = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text.trim().startsWith("{")) return null;
      const data = JSON.parse(text) as { articles?: GdeltArticle[] };
      const arts = data.articles ?? [];
      return arts.slice(0, 10).map((a) => ({
        title: a.title ?? "",
        // seendate viene como 20260831T120000Z
        date: (a.seendate ?? "").slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
        domain: a.domain ?? null,
        url: a.url ?? null,
      }));
    } catch {
      return null;
    }
  });
}

// ── Endpoint ──────────────────────────────────────────────────────────────

export async function getSecurityPoint(
  lat: number,
  lng: number,
  windowDays = 7,
): Promise<SecurityPointPayload> {
  const gaps: string[] = [];
  const geo = await resolveCountry(lat, lng);
  const cc = geo.countryCode;

  if (!cc) {
    throw new Error("No se pudo resolver el pais del punto (probablemente oceano)");
  }

  const set = await advisorySet();

  // ── Alertas ──
  const advisories: Advisory[] = [];
  const ca = set.canada.get(cc);
  if (ca) {
    advisories.push({
      issuer: "CA",
      issuerName: "Canada (Global Affairs)",
      level: ca.level,
      label: LEVEL_LABEL[ca.level],
      text: ca.text || null,
      regional: ca.regional,
      publishedAt: ca.publishedAt || null,
      recentUpdate: ca.recentUpdate,
    });
  }
  const us = set.usa.get(cc);
  if (us) {
    advisories.push({
      issuer: "US",
      issuerName: "Estados Unidos (State Dept.)",
      level: us,
      label: LEVEL_LABEL[us],
      text: null,
      regional: false,
      publishedAt: null,
      recentUpdate: null,
    });
  }

  const levels = advisories.map((a) => a.level);
  const worstLevel: AdvisoryLevel | null = levels.length
    ? (Math.max(...levels) as AdvisoryLevel)
    : null;
  // Dos escalones de diferencia entre gobiernos es desacuerdo real, no matiz.
  const disagreement =
    levels.length > 1 && Math.max(...levels) - Math.min(...levels) >= 2;

  // ── Homicidios ──
  const homicideRate: Indicator = { value: null, year: null, unit: "por 100.000 hab." };
  try {
    const rates = await homicideRates();
    // El Banco Mundial indexa por ISO3; se resuelve con el mismo mapa que usa
    // el hub economico.
    const iso3 = ISO3[cc];
    const hit = iso3 ? rates.get(iso3) : undefined;
    if (hit) {
      homicideRate.value = Math.round(hit.value * 100) / 100;
      homicideRate.year = hit.year;
    } else {
      gaps.push("El Banco Mundial no publica tasa de homicidios para " + cc);
    }
  } catch {
    gaps.push("No se pudo leer la tasa de homicidios del Banco Mundial");
  }

  // ── Brotes ──
  let outbreaks: Outbreak[] = [];
  try {
    outbreaks = await outbreaksFor(cc, set.isoByName);
  } catch {
    gaps.push("No se pudo leer el Disease Outbreak News de la OMS");
  }

  // ── Conflictividad ──
  const unrestItems = await unrestFor(cc, windowDays);
  if (unrestItems === null) {
    gaps.push(
      "GDELT no respondio: no hay relevamiento de conflictividad. Su silencio no significa que no haya protestas",
    );
  }

  if (!advisories.length) {
    gaps.push("Ninguna cancilleria relevada publica alerta para " + cc);
  }
  if (!set.usaAvailable) {
    gaps.push("El feed de Estados Unidos no respondio: la comparacion entre gobiernos queda coja");
  }
  gaps.push("Percepcion de inseguridad: no hay indice con API abierta (Numbeo es de pago)");
  gaps.push("Atentados y accidentes graves: sin fuente estructurada y en vivo");
  gaps.push("Conflictos armados cercanos: el mapa ya tiene la capa de conflictos de elippser");

  const coverage: SecurityCoverage = {
    advisories: advisories.length > 0,
    crime: homicideRate.value !== null,
    outbreaks: true,
    unrest: unrestItems !== null,
    gaps,
  };

  return {
    location: { lat, lng },
    country: { code: cc, name: COUNTRY_NAME[cc] ?? set.namesByIso.get(cc) ?? geo.countryName ?? cc },
    advisories,
    worstLevel,
    disagreement,
    homicideRate,
    outbreaks,
    unrest: {
      items: unrestItems ?? [],
      windowDays,
      available: unrestItems !== null,
    },
    coverage,
    sources: [
      "Global Affairs Canada (avisos de viaje)",
      ...(set.usaAvailable ? ["US State Department (travel advisories)"] : []),
      "Banco Mundial (homicidios intencionales)",
      "OMS Disease Outbreak News",
      ...(unrestItems !== null ? ["GDELT (conflictividad social)"] : []),
      "OpenStreetMap Nominatim",
    ],
    timestamp: new Date().toISOString(),
  };
}
