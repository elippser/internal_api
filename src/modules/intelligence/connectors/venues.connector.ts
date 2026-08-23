// Connector Venues (RADAR-DEMAND-DATA-SPEC.md #10): inventario de
// generadores de demanda vía OpenStreetMap Overpass. No captura eventos sino
// los ACTIVOS que los producen — estadios, predios feriales, centros de
// convenciones, universidades, parques temáticos, centros de esquí — con
// geo exacta y capacidad cuando OSM la publica.
//
// Usos: capa de inventario en el radar, geocodificación de eventos futuros
// (matchear "IFEMA" contra el venue real en vez de jitter urbano) y feature
// de proximidad para auto-revenue (hotel a 500 m de un estadio ≠ a 20 km).
//
// Overpass es gratis y sin key pero rate-limitea: corrida secuencial con
// pausa entre ciudades, cadencia mensual (el stock de estadios no cambia
// semana a semana). Primera carga: POST /api/v1/intelligence/ingest/venues.

import { v4 as uuid } from "uuid";
import { activeCities, type TouristCity } from "../core/cities.catalog";
import { VENUES_CONFIG } from "../core/intelligence.config";
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

// Ciudades objetivo: catálogo activo filtrado por tier + override puntual.
function targetCities(): TouristCity[] {
  const only = (process.env.IH_VENUES_CITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = activeCities().filter((c) => VENUES_CONFIG.tiers.includes(c.tier));
  if (only.length === 0) return base;
  return activeCities().filter((c) => only.includes(c.label));
}

function buildQuery(city: TouristCity): string {
  const radiusM = Math.round(Math.min(city.radiusKm, VENUES_CONFIG.maxRadiusKm) * 1000);
  const around = `(around:${radiusM},${city.lat},${city.lng})`;
  const clauses = VENUES_CONFIG.categories
    .map((cat) => `  nwr${cat.filter}${around};`)
    .join("\n");
  return `[out:json][timeout:90];\n(\n${clauses}\n);\nout center tags;`;
}

function categoryOf(tags: Record<string, string>): string | null {
  if (tags.leisure === "stadium") return "stadium";
  if (tags.amenity === "exhibition_centre") return "exhibition_centre";
  if (tags.amenity === "conference_centre") return "conference_centre";
  if (tags.amenity === "events_venue") return "events_venue";
  if (tags.tourism === "theme_park") return "theme_park";
  if (tags.amenity === "university") return "university";
  if (tags.landuse === "winter_sports") return "winter_sports";
  return null;
}

// capacity=55000 → magnitude por escala log: 500 personas ≈ 0.3, 5k ≈ 0.55,
// 50k ≈ 0.8, 100k+ → 1. Sin capacity, default de la categoría.
function magnitudeFor(category: string, capacity: number | null): number {
  const def =
    VENUES_CONFIG.categories.find((c) => c.key === category)?.defaultMagnitude ?? 0.5;
  if (!capacity || capacity < 50) return def;
  const m = 0.3 + 0.25 * (Math.log10(capacity) - Math.log10(500));
  return Math.max(def * 0.6, Math.min(1, Number(m.toFixed(2))));
}

export function createVenuesConnector(): Connector {
  return {
    name: "venues",

    async healthCheck() {
      return overpassHealthCheck(VENUES_CONFIG.overpassUrls);
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const cities = targetCities();
      const signals: Signal[] = [];
      const errors: string[] = [];
      const perCity: Record<string, number> = {};

      const now = new Date();
      // Ventana rolling de 1 año: el refresh mensual la corre hacia adelante,
      // y un venue que desaparece de OSM expira solo del summary.
      const windowStart = now.toISOString();
      const windowEnd = new Date(now.getTime() + 365 * 86_400_000).toISOString();

      // Orden vivo de endpoints: el que responde pasa al frente.
      const endpoints = [...VENUES_CONFIG.overpassUrls];

      for (const city of cities) {
        try {
          // Overpass castiga la concurrencia y los bursts: secuencial + pausa.
          await sleep(VENUES_CONFIG.delayMs);
          const { data, endpoint } = await overpassQuery(endpoints, buildQuery(city));
          promoteEndpoint(endpoints, endpoint);

          let count = 0;
          // Orden por capacidad: si la ciudad supera maxPerCity, sobreviven
          // los venues grandes (los que mueven demanda).
          const ranked = data.elements
            .map((el) => {
              const tags = el.tags ?? {};
              const capacity = Number(tags.capacity);
              return {
                el,
                tags,
                category: categoryOf(tags),
                coords: coordsOf(el),
                name: nameOf(tags),
                capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
              };
            })
            .filter((v) => v.category !== null && v.coords !== null && v.name !== null)
            .sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0))
            .slice(0, VENUES_CONFIG.maxPerCity);

          for (const v of ranked) {
            signals.push({
              id: uuid(),
              type: "venue",
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
              magnitude: magnitudeFor(v.category!, v.capacity),
              confidence: SOURCE_CONFIDENCE.overpass,
              rawPayload: {
                name: v.name,
                category: v.category,
                capacity: v.capacity,
                operator: v.tags.operator ?? null,
                website: v.tags.website ?? v.tags["contact:website"] ?? null,
                osmUrl: `https://www.openstreetmap.org/${v.el.type}/${v.el.id}`,
              },
              ingestedAt: "",
              dedupeKey: `venue:osm:${v.el.type}/${v.el.id}`,
            });
            count++;
          }
          perCity[city.label] = count;
        } catch (err) {
          errors.push(`${city.label}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          cities: cities.length,
          tiers: VENUES_CONFIG.tiers,
          perCity,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
