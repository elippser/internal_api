// Fábrica de plugins Drupal JSON:API.
//
// Varios gobiernos de ciudad publican su agenda en Drupal con el módulo
// JSON:API activo — no está documentado, pero responde sin auth:
//   GET {host}/jsonapi/node/evento?filter[status]=1&page[limit]=50&include=...
// Verificado (ago-2026): buenosaires.gob.ar → 2.002 eventos publicados;
// eventos.montevideo.gub.uy → agenda con coordenadas nativas.
//
// `filter[status]=1` es OBLIGATORIO: sin él Drupal responde data:[] con un
// meta.omitted de "insufficient authorization" en vez de un error visible.
//
// La forma del `include` varía por sitio, así que la paginación y el manejo
// de errores son comunes y cada sitio aporta su propio mapper.

import { fetchJson } from "../../../../core/http";
import type { Signal } from "../../../../core/signal.types";
import type { ScraperPlugin, ScrapedEvent } from "../types";
import { scrapedToSignal } from "../normalize";

export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, { data?: { type: string; id: string } | Array<{ type: string; id: string }> }>;
}

export interface JsonApiResponse {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
  links?: { next?: { href: string } };
}

// Índice type:id → recurso, para resolver los `include` sin recorrer arrays.
export type IncludedIndex = Map<string, JsonApiResource>;

export const relatedOf = (
  node: JsonApiResource,
  field: string,
  idx: IncludedIndex,
): JsonApiResource | undefined => {
  const rel = node.relationships?.[field]?.data;
  const ref = Array.isArray(rel) ? rel[0] : rel;
  return ref ? idx.get(`${ref.type}:${ref.id}`) : undefined;
};

export interface DrupalSite {
  sourceLabel: string;
  marketCode: string;
  host: string; // ej. "https://buenosaires.gob.ar"
  resource?: string; // default "node/evento"
  include?: string;
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  spreadKm?: number;
  maxPages?: number;
  enabled?: boolean;
  mapNode(node: JsonApiResource, included: IncludedIndex): ScrapedEvent | null;
}

const PAGE_LIMIT = 50;

export function createDrupalPlugin(cfg: DrupalSite): ScraperPlugin {
  return {
    marketCode: cfg.marketCode,
    sourceLabel: cfg.sourceLabel,
    kind: "api",
    enabled: cfg.enabled !== false,

    async scrape(): Promise<Signal[]> {
      const ctx = {
        sourceLabel: cfg.sourceLabel,
        countryCode: cfg.countryCode,
        city: cfg.city,
        lat: cfg.lat,
        lng: cfg.lng,
        fallbackSpreadKm: cfg.spreadKm ?? 6,
        kind: "api" as const,
        defaultCategory: "miscellaneous",
      };
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
      const signals: Signal[] = [];
      const maxPages = cfg.maxPages ?? 45;

      const params = new URLSearchParams({
        "filter[status]": "1",
        "page[limit]": String(PAGE_LIMIT),
      });
      if (cfg.include) params.set("include", cfg.include);
      let url = `${cfg.host}/jsonapi/${cfg.resource ?? "node/evento"}?${params}`;

      try {
        for (let page = 0; page < maxPages && url; page++) {
          const res = await fetchJson<JsonApiResponse>(url);
          const nodes = res.data ?? [];
          const idx: IncludedIndex = new Map(
            (res.included ?? []).map((r) => [`${r.type}:${r.id}`, r]),
          );

          for (const node of nodes) {
            let ev: ScrapedEvent | null = null;
            try {
              ev = cfg.mapNode(node, idx);
            } catch {
              continue; // un nodo con forma inesperada no frena la página
            }
            if (!ev) continue;
            // La API no filtra por fecha, así que se descarta lo pasado acá.
            const last = ev.endDate ?? ev.startDate;
            if (last < today || ev.startDate > horizon) continue;
            const signal = scrapedToSignal(ev, ctx);
            if (signal) signals.push(signal);
          }

          const next = res.links?.next?.href;
          if (!next || nodes.length === 0) break;
          url = next;
        }
        return signals;
      } catch (err) {
        console.error(
          `[intelligence] drupal ${cfg.sourceLabel} falló:`,
          (err as Error).message,
        );
        return signals;
      }
    },
  };
}

const dayOf = (v: unknown): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length >= 10 ? s.slice(0, 10) : undefined;
};

export const DRUPAL_SITES: DrupalSite[] = [
  {
    sourceLabel: "ar-buenosaires-agenda",
    marketCode: "AR",
    host: "https://buenosaires.gob.ar",
    include: "field_ubicacion",
    city: "Buenos Aires",
    countryCode: "AR",
    lat: -34.6037,
    lng: -58.3816,
    spreadKm: 7,
    mapNode(node, idx) {
      const a = node.attributes ?? {};
      const start =
        dayOf(a.field_fecha_del_evento) ?? dayOf(a.field_periodo_activo?.value);
      if (!a.title || !start) return null;
      const place = relatedOf(node, "field_ubicacion", idx);
      const alias = a.path?.alias;
      return {
        name: String(a.title),
        startDate: start,
        endDate: dayOf(a.field_periodo_activo?.end_value),
        venue: place?.attributes?.field_titulo_ubicacion
          ? String(place.attributes.field_titulo_ubicacion)
          : undefined,
        url: alias ? `https://buenosaires.gob.ar${alias}` : undefined,
        category: a.field_tipo_de_evento ? String(a.field_tipo_de_evento) : undefined,
      };
    },
  },
  {
    sourceLabel: "uy-montevideo-agenda",
    marketCode: "UY",
    host: "https://eventos.montevideo.gub.uy",
    include: "field_fechas_horarios.field_donde",
    city: "Montevideo",
    countryCode: "UY",
    lat: -34.9011,
    lng: -56.1645,
    spreadKm: 5,
    mapNode(node, idx) {
      const a = node.attributes ?? {};
      const start = dayOf(a.field_fechas?.value);
      if (!a.title || !start) return null;
      // Cadena de dos saltos: evento → funciones → lugar (con coordenadas).
      const funciones = relatedOf(node, "field_fechas_horarios", idx);
      const lugar = funciones ? relatedOf(funciones, "field_donde", idx) : undefined;
      const geo = lugar?.attributes?.field_ubicacion;
      const lat = Number(geo?.lat);
      const lng = Number(geo?.lon);
      const hasGeo = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      const alias = a.path?.alias;
      return {
        name: String(a.title),
        startDate: start,
        endDate: dayOf(a.field_fechas?.end_value),
        venue: lugar?.attributes?.title ? String(lugar.attributes.title) : undefined,
        url: alias ? `https://eventos.montevideo.gub.uy${alias}` : undefined,
        ...(hasGeo ? { lat, lng } : {}),
      };
    },
  },
];

export const drupalPlugins: ScraperPlugin[] = DRUPAL_SITES.map(createDrupalPlugin);
