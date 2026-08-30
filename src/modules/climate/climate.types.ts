// Tipos del hub de estacionalidad climática (event-list.md §1).
// Un solo payload por punto: normales mensuales + temporadas derivadas +
// riesgos estacionales + snapshot actual. Sin persistencia: todo se computa
// on-demand desde APIs públicas y se cachea en memoria por celda de grilla.

/** Normales climáticas de un mes (promedio de la última década, ERA5). */
export interface MonthlyNormal {
  month: number; // 1-12
  tMax: number | null; // °C, promedio de máximas diarias
  tMin: number | null; // °C
  tMean: number | null; // °C
  precipMm: number | null; // total mensual promedio
  rainDays: number | null; // días con >=1mm
  snowCm: number | null; // nevada total mensual promedio
  humidityPct: number | null;
  sunshineHours: number | null; // horas de sol efectivas por día
  daylightHours: number | null; // duración del día (astronómica, calculada)
  uvIndex: number | null; // UV medio diario (NASA POWER, climatología 20 años)
  tRecordHigh: number | null; // récord absoluto del mes (NASA POWER, 2001-2020)
  tRecordLow: number | null;
}

export interface SeasonWindows {
  /** tropical | arid | temperate | polar — perfil grueso del clima local. */
  profile: "tropical" | "arid" | "temperate" | "polar";
  /** Amplitud térmica anual (max tMean - min tMean). */
  amplitudeC: number;
  annualPrecipMm: number;
  warmest: number[]; // 3 meses más cálidos consecutivos ("verano" térmico)
  coldest: number[]; // 3 meses más fríos consecutivos
  wet: number[]; // meses de temporada de lluvias
  dry: number[]; // meses de temporada seca
  snow: number[]; // meses con nieve significativa
  best: number[]; // mejores meses por confort (temp + poca lluvia)
  monsoonal: boolean; // lluvia muy concentrada en pocos meses
}

export interface HazardWindows {
  hurricane: { basin: string; months: number[]; note?: string } | null;
  tornado: { region: string; months: number[] } | null;
  /** Meses de mayor riesgo de incendios (calor + sequedad, derivado). */
  fireRisk: number[];
}

export interface SpecialWindows {
  /** Ventana de follaje otoñal (solo latitudes templadas con estaciones). */
  foliage: number[] | null;
  /** Ventana de floración primaveral (cerezos y flora estacional). */
  bloom: number[] | null;
}

export interface EnsoStatus {
  phase: "El Niño" | "La Niña" | "Neutral";
  oni: number; // anomalía ONI del último trimestre publicado
  period: string; // ej. "MJJ 2026"
  strength: "weak" | "moderate" | "strong" | "very strong" | null;
}

export interface ClimateShift {
  baseline: string; // ej. "1981-1990"
  recent: string; // ej. "2015-2024"
  annualDeltaC: number; // calentamiento medio anual entre ambas décadas
  monthlyDeltaC: Array<number | null>; // 12 posiciones, ene-dic
  /** Tendencia lineal sobre toda la serie disponible, en °C por década. */
  trendCPerDecade: number | null;
}

export interface CurrentSnapshot {
  airQuality: {
    europeanAqi: number | null;
    usAqi: number | null;
    pm25: number | null;
    pm10: number | null;
    ozone: number | null;
  } | null;
  /** grains/m³, máximo del día. Solo Europa (dominio CAMS europeo). */
  pollen: {
    alder: number | null;
    birch: number | null;
    grass: number | null;
    mugwort: number | null;
    olive: number | null;
    ragweed: number | null;
  } | null;
  snowDepthCm: number | null;
  uvIndexMaxToday: number | null;
}

export interface ClimatePointPayload {
  location: {
    lat: number;
    lng: number;
    elevation: number | null;
    timezone: string | null;
    hemisphere: "north" | "south";
    /** Radio (km) al que se detectó mar, o null si es interior (>200 km). */
    oceanWithinKm: number | null;
  };
  normals: MonthlyNormal[];
  seasons: SeasonWindows;
  hazards: HazardWindows;
  special: SpecialWindows;
  enso: EnsoStatus | null;
  climateShift: ClimateShift | null;
  current: CurrentSnapshot;
  sources: string[];
  timestamp: string;
}
