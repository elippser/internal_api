/**
 * Alertas de desastres activas: directas (en el radio o en el país, para las
 * amenazas areales como la sequía) y por el aeropuerto que alimenta la plaza.
 */

import type { HazardsPointPayload } from "../../hazards/hazards.types";
import type { HazardsSlim, Projection } from "../tourism.types";

const LEVEL_RANK = { Red: 0, Orange: 1, Green: 2 } as const;

export function projectHazards(p: HazardsPointPayload | null): Projection<HazardsSlim> {
  if (!p) return { data: null, missing: ["alertas de desastres"] };

  const missing: string[] = [];
  if (!p.coverage.gdacs) missing.push("alertas GDACS");

  return {
    data: {
      radiusKm: p.location.radiusKm,
      worstAlert: p.headline.worstAlert,
      active: [...p.active]
        .sort((a, b) => LEVEL_RANK[a.alertLevel] - LEVEL_RANK[b.alertLevel] || a.distanceKm - b.distanceKm)
        .slice(0, 5)
        .map((a) => ({
          scope: a.scope,
          type: a.type,
          typeName: a.typeName,
          name: a.name,
          alertLevel: a.alertLevel,
          distanceKm: Math.round(a.distanceKm),
          ongoing: a.ongoing,
        })),
      airliftRisk: p.airliftRisk.slice(0, 3).map((r) => ({
        airport: r.airport,
        airportIata: r.airportIata,
        hazard: r.hazard,
        alertLevel: r.alertLevel,
        hazardDistanceKm: Math.round(r.hazardDistanceKm),
      })),
      anomalies: p.anomalies.slice(0, 2).map((a) => ({
        kind: a.kind,
        startDate: a.startDate,
        endDate: a.endDate,
        peakC: Math.round(a.peakC),
        thresholdC: Math.round(a.thresholdC),
      })),
    },
    missing,
  };
}
