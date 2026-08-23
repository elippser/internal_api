// Connector Lodging (RADAR-DEMAND-DATA-SPEC.md #32): inventario completo de
// alojamiento vía OpenStreetMap Overpass — del resort de 500 habitaciones a
// la cabaña de dos, pasando por hoteles, moteles, hostels, campings, B&B,
// apart turísticos y refugios de montaña.
//
// Espejo de `venues`: aquel inventaría lo que GENERA demanda (estadios,
// predios); este, la OFERTA que compite por esa misma noche. Juntos dan el
// ratio que le falta al radar — un pico de 5.000 personas sobre un pueblo de
// 40 camas no se tarifa como sobre una ciudad de 40.000.
//
// Jerarquía de tamaño explícita (LODGING_CATEGORIES va de mayor a menor):
// la magnitud sale de rooms/beds cuando OSM las publica y del tipo cuando no,
// así el mapa dibuja los grandes grandes y las cabañas chicas. Cuando una
// ciudad supera maxPerCity, el recorte conserva los de mayor capacidad y se
// reporta en meta.truncated (nunca un tope silencioso).
//
// Cadencia mensual: el stock hotelero se mueve por aperturas, no por semana.
// Primera carga: POST /api/v1/intelligence/ingest/lodging.

import { v4 as uuid } from "uuid";
import { activeCities, type TouristCity } from "../core/cities.catalog";
import { LODGING_CONFIG } from "../core/intelligence.config";
import {
  coordsOf,
  nameOf,
  overpassHealthCheck,
  overpassQuery,
  promoteEndpoint,
} from "../core/overpass";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function targetCities(): TouristCity[] {
  const only = (process.env.IH_LODGING_CITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (only.length > 0) return activeCities().filter((c) => only.includes(c.label));
  return activeCities().filter((c) => LODGING_CONFIG.tiers.includes(c.tier));
}

// Una cláusula por TAG (no por categoría): los 10 valores de `tourism` van
// en un solo regex. Ver el comentario de LODGING_CATEGORIES — con cláusulas
// sueltas Overpass devolvía 504.
export function buildQuery(city: TouristCity): string {
  const radiusM = Math.round(Math.min(city.radiusKm, LODGING_CONFIG.maxRadiusKm) * 1000);
  const around = `(around:${radiusM},${city.lat},${city.lng})`;
  const byTag = new Map<string, string[]>();
  for (const cat of LODGING_CONFIG.categories) {
    const list = byTag.get(cat.tag) ?? [];
    list.push(cat.key);
    byTag.set(cat.tag, list);
  }
  const clauses = [...byTag.entries()]
    .map(([tag, values]) => `  nwr["${tag}"~"^(${values.join("|")})$"]${around};`)
    .join("\n");
  return `[out:json][timeout:180];\n(\n${clauses}\n);\nout center tags;`;
}

function categoryOf(tags: Record<string, string>): string | null {
  for (const cat of LODGING_CONFIG.categories) {
    if (tags[cat.tag] === cat.key) return cat.key;
  }
  return null;
}

const numTag = (raw: string | undefined): number | null => {
  if (!raw) return null;
  // OSM trae "120", "120;130" y a veces "approx. 120".
  const n = Number(String(raw).split(";")[0].replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface LodgingSize {
  rooms: number | null;
  beds: number | null;
  stars: number | null;
  /** Unidades estimadas: rooms, o beds/2, o capacity (campings). */
  units: number | null;
}

export function readSize(tags: Record<string, string>): LodgingSize {
  const rooms = numTag(tags.rooms);
  const beds = numTag(tags.beds);
  const capacity = numTag(tags.capacity);
  const stars = numTag(tags.stars);
  const units = rooms ?? (beds !== null ? Math.round(beds / 2) : null) ?? capacity;
  return { rooms, beds, stars, units };
}

// Clase de tamaño para leer el mapa de un vistazo, con el mismo criterio que
// usa revenue: lo que cambia es el orden de magnitud del inventario.
export function sizeClassOf(units: number | null, category: string): string {
  if (units === null) {
    if (category === "resort" || category === "hotel") return "unknown";
    return "micro";
  }
  if (units >= 300) return "xl";
  if (units >= 120) return "large";
  if (units >= 40) return "medium";
  if (units >= 10) return "small";
  return "micro";
}

// Escala log sobre unidades: 5 → ~0.2, 40 → ~0.5, 300 → ~0.85, 1000+ → 1.
// Sin dato, el default del tipo (un hotel sin `rooms` sigue pesando más que
// una cabaña sin `rooms`).
export function magnitudeFor(category: string, units: number | null): number {
  const def =
    LODGING_CONFIG.categories.find((c) => c.key === category)?.defaultMagnitude ?? 0.4;
  if (units === null) return def;
  const m = 0.2 + 0.3 * (Math.log10(units) - Math.log10(5));
  return Math.max(0.08, Math.min(1, Number(m.toFixed(2))));
}

export function createLodgingConnector(): Connector {
  return {
    name: "lodging",

    async healthCheck() {
      return overpassHealthCheck(LODGING_CONFIG.overpassUrls);
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const cities = targetCities();
      const signals: Signal[] = [];
      const errors: string[] = [];
      const perCity: Record<string, number> = {};
      const perCategory: Record<string, number> = {};
      const truncated: Record<string, number> = {};

      const now = new Date();
      // Ventana rolling de 1 año, igual que venues: el refresh mensual la
      // corre hacia adelante y un alojamiento cerrado expira solo del summary.
      const windowStart = now.toISOString();
      const windowEnd = new Date(now.getTime() + 365 * 86_400_000).toISOString();

      const endpoints = [...LODGING_CONFIG.overpassUrls];

      for (const city of cities) {
        try {
          await sleep(LODGING_CONFIG.delayMs);
          const { data, endpoint } = await overpassQuery(endpoints, buildQuery(city));
          promoteEndpoint(endpoints, endpoint);

          const parsed = data.elements
            .map((el) => {
              const tags = el.tags ?? {};
              const category = categoryOf(tags);
              return {
                el,
                tags,
                category,
                coords: coordsOf(el),
                name: nameOf(tags),
                size: readSize(tags),
              };
            })
            // Sin nombre no sirve para compset ni para el popup; sin geo no
            // se dibuja. Ambos filtros descartan poco en ciudades turísticas.
            .filter((v) => v.category !== null && v.coords !== null && v.name !== null);

          // De mayor a menor: si hay recorte, sobreviven los grandes.
          parsed.sort((a, b) => (b.size.units ?? 0) - (a.size.units ?? 0));
          if (parsed.length > LODGING_CONFIG.maxPerCity) {
            truncated[city.label] = parsed.length - LODGING_CONFIG.maxPerCity;
          }
          const ranked = parsed.slice(0, LODGING_CONFIG.maxPerCity);

          for (const v of ranked) {
            const category = v.category!;
            const sizeClass = sizeClassOf(v.size.units, category);
            perCategory[category] = (perCategory[category] ?? 0) + 1;
            signals.push({
              id: uuid(),
              type: "lodging",
              source: "overpass",
              scope: {
                geo: {
                  lat: v.coords!.lat,
                  lng: v.coords!.lng,
                  countryCode: city.countryCode,
                  city: city.label,
                },
              },
              timeWindow: { start: windowStart, end: windowEnd },
              magnitude: magnitudeFor(category, v.size.units),
              confidence: SOURCE_CONFIDENCE.overpass,
              rawPayload: {
                name: v.name,
                category,
                sizeClass,
                rooms: v.size.rooms,
                beds: v.size.beds,
                units: v.size.units,
                stars: v.size.stars,
                brand: v.tags.brand ?? v.tags.operator ?? null,
                website: v.tags.website ?? v.tags["contact:website"] ?? null,
                phone: v.tags.phone ?? v.tags["contact:phone"] ?? null,
                osmUrl: `https://www.openstreetmap.org/${v.el.type}/${v.el.id}`,
              },
              ingestedAt: "",
              dedupeKey: `lodging:osm:${v.el.type}/${v.el.id}`,
            });
          }
          perCity[city.label] = ranked.length;
        } catch (err) {
          errors.push(`${city.label}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          cities: cities.length,
          tiers: LODGING_CONFIG.tiers,
          perCity,
          perCategory,
          produced: signals.length,
          // Tope explícito: nunca un recorte silencioso.
          ...(Object.keys(truncated).length ? { truncated } : {}),
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
