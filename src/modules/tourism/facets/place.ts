/**
 * Entorno a pie (1 km): caminabilidad, gastronomía, transporte, ruido.
 *
 * `coverage.census === false` es el hub diciendo que el censo de Overpass no
 * es confiable acá (no respondió, o volvió vacío en un lugar con aeropuerto
 * cerca — el cero falso de Bariloche). Se proyecta como desconocido: la
 * tarjeta nunca dibuja "0 restaurantes" por una caída de Overpass.
 */

import type { PlacePointPayload, Proximity } from "../../place/place.types";
import type { PlaceNearby, PlaceSlim, Projection } from "../tourism.types";

const NEARBY: Array<[keyof Proximity, string]> = [
  ["transitStop", "parada de transporte"],
  ["busTerminal", "terminal de ómnibus"],
  ["attraction", "atracción turística"],
  ["museum", "museo"],
  ["park", "parque"],
  ["beach", "playa"],
  ["conventionCentre", "centro de convenciones"],
  ["university", "universidad"],
  ["hospital", "hospital"],
  ["airport", "aeropuerto"],
];

export function projectPlace(p: PlacePointPayload | null): Projection<PlaceSlim> {
  if (!p) return { data: null, missing: ["entorno a pie"] };
  if (!p.coverage.census) {
    return {
      data: null,
      missing: ["entorno a pie (OpenStreetMap no respondió o devolvió un censo no confiable)"],
    };
  }

  const nearby: PlaceNearby[] = [];
  for (const [kind, label] of NEARBY) {
    const n = p.proximity[kind];
    if (!n) continue;
    nearby.push({
      kind,
      label,
      name: n.name,
      distanceM: n.distanceM,
      ...(kind === "airport" ? { iata: (n as { iata?: string | null }).iata ?? null } : {}),
    });
  }

  return {
    data: {
      radiusKm: p.location.radiusKm,
      walkability: {
        score: p.walkability.score,
        label: p.walkability.label,
        components: { ...p.walkability.components },
      },
      noise: { score: p.noise.score, label: p.noise.label, sources: p.noise.sources },
      gastronomy: p.density.gastronomy,
      nightlife: p.density.nightlife,
      shops: p.density.shops,
      truncated: p.coverage.gaps.some((g) => /corto en/i.test(g)),
      nearby,
      profile: p.profile,
    },
    // La elevación sólo alimenta los indicios de vista, que la tarjeta no usa.
    missing: [],
  };
}
