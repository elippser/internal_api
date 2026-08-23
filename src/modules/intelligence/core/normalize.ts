import type { DestinationProfile } from "./intelligence.config";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Normalización contra histórico móvil (spec §2): un valor igual al promedio
// da 0.5; el doble del promedio da 1.0. Sin histórico (arranque en frío)
// devuelve 0.5 — "en línea con lo esperado".
export function normalizeVsRollingAvg(value: number, rollingAvg: number | null): number {
  if (rollingAvg === null || rollingAvg <= 0) return 0.5;
  return clamp(value / rollingAvg, 0, 2) / 2;
}

// Confidence del pronóstico decrece con el horizonte (spec §6):
// 0.9 el día 1 → 0.4 el día 16, lineal.
export function confidenceByHorizon(daysAhead: number): number {
  const t = clamp((daysAhead - 1) / 15, 0, 1);
  return Number((0.9 - t * 0.5).toFixed(2));
}

export interface DailyWeather {
  tMax: number | null;
  tMin: number | null;
  precipitationMm: number | null;
}

// Favorabilidad del clima según el perfil del destino (spec §6):
// un día soleado favorece playa/trekking pero es neutro-negativo para esquí.
export function weatherFavorability(day: DailyWeather, profile: DestinationProfile): number {
  const tMax = day.tMax ?? 20;
  const precip = day.precipitationMm ?? 0;
  const dryScore = clamp(1 - precip / 20, 0, 1); // 20mm+ = día lavado

  switch (profile) {
    case "beach": {
      const warmScore = clamp((tMax - 18) / 14, 0, 1); // 18°C→0, 32°C→1
      return Number((0.6 * warmScore + 0.4 * dryScore).toFixed(2));
    }
    case "ski": {
      // Frío ayuda; la precipitación (nieve en temporada) no penaliza tanto.
      const coldScore = clamp((10 - tMax) / 15, 0, 1); // 10°C→0, -5°C→1
      const snowBonus = precip > 0 && tMax <= 4 ? 0.2 : 0;
      return Number(clamp(0.7 * coldScore + 0.3 * dryScore + snowBonus, 0, 1).toFixed(2));
    }
    case "trekking": {
      const mildScore = clamp(1 - Math.abs(tMax - 22) / 15, 0, 1); // ideal ~22°C
      return Number((0.5 * mildScore + 0.5 * dryScore).toFixed(2));
    }
    case "urban":
    default: {
      const mildScore = clamp(1 - Math.abs(tMax - 23) / 18, 0, 1);
      return Number((0.35 * mildScore + 0.65 * dryScore).toFixed(2));
    }
  }
}

// Para FX: qué tan favorable está el cambio vs su propio promedio móvil
// (spec §4). rate > promedio ⇒ la moneda del turista compra más ⇒ >0.5.
export function normalizeRateVsHistorical(rate: number, rollingAvg: number | null): number {
  if (rollingAvg === null || rollingAvg <= 0) return 0.5;
  // ±20% respecto del promedio mapea al rango completo 0-1.
  const deviation = (rate - rollingAvg) / rollingAvg;
  return Number(clamp(0.5 + deviation / 0.4, 0, 1).toFixed(3));
}

export function toDayISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
