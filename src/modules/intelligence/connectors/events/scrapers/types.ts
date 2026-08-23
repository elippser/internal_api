// Interfaz común de los plugins de eventos por mercado (spec §3.3).
// Cada plugin es independiente y activable/desactivable sin tocar el resto.
// Regla: ante cambio de estructura de la fuente, loggear y devolver [] —
// nunca tirar excepción que tumbe el pipeline de ingesta.

import type { Signal } from "../../../core/signal.types";

// El spec pensó esta capa como "scrapers", pero en la práctica las mejores
// fuentes por mercado son APIs abiertas de gobiernos/entes de turismo. Se
// distinguen porque un dato oficial estructurado merece más confianza que
// HTML parseado que puede romperse en silencio.
export type PluginKind = "api" | "ical" | "jsonld" | "html";

export const CONFIDENCE_BY_KIND: Record<PluginKind, number> = {
  api: 0.8, // open data oficial / API estructurada
  ical: 0.7, // feed iCal publicado por la fuente
  jsonld: 0.6, // schema.org embebido, estructurado pero no contractual
  html: 0.4, // parsing propio de HTML (valor del spec)
};

export interface ScraperPlugin {
  marketCode: string; // ISO country o región, ej. 'ES', 'AR', 'AR-CUYO', 'BR'
  sourceLabel: string; // Signal.source queda como 'ih-scraper-{sourceLabel}'
  kind: PluginKind;
  enabled: boolean;
  scrape(): Promise<Signal[]>;
}

// Evento crudo extraído por un plugin, antes de normalizar a Signal.
export interface ScrapedEvent {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  venue?: string;
  category?: string;
  url?: string;
  // Coordenada propia del evento. Sin esto, el plugin cae a la del CTX
  // (el predio/ciudad), que es lo que apila cientos de puntos en uno solo.
  lat?: number;
  lng?: number;
}
