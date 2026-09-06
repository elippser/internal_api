// Tipos del hub de comportamiento y tendencias del consumidor
// (event-list.md §13).
//
// La categoria pregunta por moda, viralidad, cobertura y busquedas. Todo eso
// deja una misma huella medible: la gente busca el destino. Las vistas de
// Wikipedia son el proxy de atencion, y su valor es que ANTECEDE a la reserva.

/** Pico de atencion contra la linea de base del propio destino. */
export interface Spike {
  /** Cuantas veces la semana actual supera la mediana previa. */
  ratio: number;
  currentDailyMean: number;
  baselineDailyMedian: number;
  since: string;
}

/**
 * Atencion en una edicion idiomatica. Es lo mas parecido a "que mercado esta
 * mirando" que hay sin datos propietarios.
 */
export interface LanguageAttention {
  code: string;
  label: string;
  /** Titulo del articulo EN ESE IDIOMA. Cambia entre ediciones (Kioto/Kyoto)
   *  y usar uno solo invierte la lectura de que mercado mira. */
  title: string;
  totalViews: number;
  dailyMean: number;
  /** Proporcion sobre el total de todos los idiomas consultados. */
  share: number;
  spike: Spike | null;
}

export interface NearbyArticle {
  title: string;
  distanceM: number;
}

export interface AttentionCoverage {
  article: boolean;
  languages: number;
  gaps: string[];
}

export interface AttentionPointPayload {
  location: { lat: number; lng: number };
  article: {
    title: string | null;
    place: string | null;
    /** nominatim | geosearch | none: de donde salio el articulo. */
    resolvedVia: string;
    url: string | null;
  };
  window: { days: number };
  totalViews: number;
  byLanguage: LanguageAttention[];
  /** El pico mas fuerte entre los idiomas, si hay alguno. */
  spike: Spike | null;
  /** Ultimos 90 dias para el grafico. */
  series: Array<{ date: string; views: number }>;
  nearby: NearbyArticle[];
  coverage: AttentionCoverage;
  sources: string[];
  timestamp: string;
}
