/**
 * Clima estructural: temporadas y normales mensuales (ERA5, 10 años).
 *
 * No es un pronóstico. Las normales no cambian, por eso el sobre dura 30 días
 * y Open-Meteo —que cobra por peso y limita por minuto— se consulta una vez
 * por propiedad al mes. Las cuencas de ciclones son tablas curadas.
 */

import type { ClimatePointPayload } from "../../climate/climate.types";
import type { ClimateSlim, Projection } from "../tourism.types";

export function projectClimate(p: ClimatePointPayload | null): Projection<ClimateSlim> {
  if (!p) return { data: null, missing: ["clima"] };
  return {
    data: {
      profile: p.seasons.profile,
      hemisphere: p.location.hemisphere,
      best: p.seasons.best,
      warmest: p.seasons.warmest,
      coldest: p.seasons.coldest,
      wet: p.seasons.wet,
      dry: p.seasons.dry,
      snow: p.seasons.snow,
      hurricane: p.hazards.hurricane
        ? { basin: p.hazards.hurricane.basin, months: p.hazards.hurricane.months }
        : null,
      fireRisk: p.hazards.fireRisk,
      normals: p.normals.map((n) => ({
        month: n.month,
        tMax: n.tMax === null ? null : Math.round(n.tMax),
        tMin: n.tMin === null ? null : Math.round(n.tMin),
        precipMm: n.precipMm === null ? null : Math.round(n.precipMm),
        rainDays: n.rainDays === null ? null : Math.round(n.rainDays),
      })),
    },
    missing: [],
  };
}
