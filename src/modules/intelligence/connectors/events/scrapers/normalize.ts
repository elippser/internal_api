// Normalización compartida de los plugins: ScrapedEvent → Signal.

import { v4 as uuid } from "uuid";
import { EVENT_SEGMENT_WEIGHTS } from "../../../core/intelligence.config";
import { isOnLand } from "../../../core/landMask";
import { SCRAPER_CONFIDENCE_DEFAULT, type Signal } from "../../../core/signal.types";
import { CONFIDENCE_BY_KIND, type PluginKind, type ScrapedEvent } from "./types";

export interface ScraperContext {
  sourceLabel: string;
  countryCode: string;
  city: string;
  // Coordenada de referencia del mercado: se usa solo cuando el evento no
  // trae la suya. Los eventos con lat/lng propia se dispersan en el mapa.
  lat: number;
  lng: number;
  // Radio del jitter aplicado a eventos sin geo propia. Un predio ferial usa
  // ~0.4 km; una agenda de ciudad entera, varios km.
  fallbackSpreadKm?: number;
  // Ferias/congresos llenan hoteles semana completa (spec §3.3): default alto.
  defaultCategory?: string;
  kind?: PluginKind;
  confidence?: number;
}

// Jitter determinístico para eventos sin coordenada propia: sin esto,
// decenas (o miles) de eventos del mismo predio o ciudad se dibujan como un
// único punto. La semilla es el nombre, así que el desplazamiento es estable
// entre corridas y el evento no "salta" en el mapa al reingerir.
//
// El radio se elige según qué representa la coordenada de respaldo: la de un
// predio concreto admite metros, la de una ciudad entera necesita kilómetros
// para que el conjunto se lea como una mancha urbana y no como un pin.
function jitter(seed: string, radiusKm: number): { dLat: number; dLng: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const angle = (((h >>> 0) % 3600) / 3600) * Math.PI * 2;
  const degrees = radiusKm / 111;
  // sqrt para distribución uniforme en el área, no concentrada en el centro.
  const r = degrees * Math.sqrt(((h >>> 8) % 1000) / 1000);
  return { dLat: Math.sin(angle) * r, dLng: Math.cos(angle) * r };
}

export function scrapedToSignal(ev: ScrapedEvent, ctx: ScraperContext): Signal | null {
  if (!ev.name || !ev.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(ev.startDate)) return null;
  const endDate = ev.endDate && /^\d{4}-\d{2}-\d{2}$/.test(ev.endDate) ? ev.endDate : ev.startDate;

  const category = (ev.category ?? ctx.defaultCategory ?? "fair").toLowerCase();
  const magnitude = EVENT_SEGMENT_WEIGHTS[category] ?? EVENT_SEGMENT_WEIGHTS.default;

  // Clave estable ante re-scrapes: mercado + nombre + fecha de inicio.
  const nameKey = ev.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 80);

  // Coordenadas propias: se normaliza la longitud al rango [-180, 180]
  // (algunas fuentes publican grados "envueltos", ej. -776.19 ≡ -56.19) y
  // una latitud imposible invalida el par completo → cae al jitter urbano.
  const wrapLng = (l: number) => ((l % 360) + 540) % 360 - 180;
  const ownLat = typeof ev.lat === "number" && Math.abs(ev.lat) <= 90 ? ev.lat : null;
  const ownLng = typeof ev.lng === "number" && Number.isFinite(ev.lng) ? wrapLng(ev.lng) : null;
  const hasOwnCoords = ownLat !== null && ownLng !== null;

  let lat: number;
  let lng: number;
  if (hasOwnCoords) {
    lat = ownLat;
    lng = ownLng;
  } else {
    // Jitter consciente de la costa: en mercados costeros (Buenos Aires,
    // Punta Arenas, Singapur…) el disco de dispersión pisa el mar, así que
    // se reintenta con semillas derivadas hasta caer en tierra. Sigue siendo
    // determinístico (misma semilla → misma posición entre corridas). Si
    // ningún intento cae en tierra, se usa el punto de referencia tal cual.
    const radius = ctx.fallbackSpreadKm ?? 0.4;
    lat = ctx.lat;
    lng = ctx.lng;
    for (let attempt = 0; attempt < 12; attempt++) {
      const off = jitter(attempt === 0 ? nameKey : `${nameKey}#${attempt}`, radius);
      if (isOnLand(ctx.lng + off.dLng, ctx.lat + off.dLat)) {
        lat = ctx.lat + off.dLat;
        lng = ctx.lng + off.dLng;
        break;
      }
    }
  }

  const confidence =
    ctx.confidence ??
    (ctx.kind ? CONFIDENCE_BY_KIND[ctx.kind] : SCRAPER_CONFIDENCE_DEFAULT);

  return {
    id: uuid(),
    type: "event",
    source: `ih-scraper-${ctx.sourceLabel}`,
    scope: {
      geo: { lat, lng, countryCode: ctx.countryCode, city: ctx.city },
    },
    timeWindow: {
      start: `${ev.startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
    },
    magnitude,
    confidence,
    rawPayload: {
      name: ev.name,
      venue: ev.venue ?? null,
      category,
      url: ev.url ?? null,
      scrapedFrom: ctx.sourceLabel,
      approxLocation: !hasOwnCoords,
    },
    ingestedAt: "",
    dedupeKey: `event:scraper:${ctx.sourceLabel}:${nameKey}:${ev.startDate}`,
  };
}

// Parseo tolerante de rangos de fecha en español/portugués tal como aparecen
// en calendarios de predios feriales: "12-15 marzo 2026", "3 de mayo de 2026",
// "12/03/2026", "12.03.2026", "marzo 2026" (sin día → día 1).
const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
  janeiro: 1, fevereiro: 2, "março": 3, marco: 3, maio: 5, junho: 6,
  julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

export function parseSpanishDateRange(
  text: string,
  fallbackYear?: number,
): { startDate: string; endDate?: string } | null {
  const t = text.toLowerCase().trim();
  const year = Number((t.match(/(20\d{2})/) ?? [])[1] ?? fallbackYear ?? NaN);
  if (!year) return null;

  // dd/mm/yyyy o dd.mm.yyyy o dd-mm-yyyy
  const numeric = t.match(/(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/);
  if (numeric) {
    return { startDate: `${numeric[3]}-${pad(Number(numeric[2]))}-${pad(Number(numeric[1]))}` };
  }

  const monthName = Object.keys(MONTHS).find((m) => t.includes(m));
  if (!monthName) return null;
  const month = MONTHS[monthName];

  // "12 - 15 de marzo", "12 al 15 marzo", "del 12 al 15"
  const range = t.match(/(\d{1,2})\s*(?:-|–|al?|a)\s*(\d{1,2})/);
  if (range) {
    const d1 = Number(range[1]);
    const d2 = Number(range[2]);
    if (d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31) {
      return {
        startDate: `${year}-${pad(month)}-${pad(d1)}`,
        endDate: `${year}-${pad(month)}-${pad(d2)}`,
      };
    }
  }

  const single = t.match(/(\d{1,2})\s*(?:de\s+)?[a-zãç]+/);
  const day = single ? Number(single[1]) : 1;
  if (day < 1 || day > 31) return null;
  return { startDate: `${year}-${pad(month)}-${pad(day)}` };
}
