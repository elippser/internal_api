// Registro de plugins de scraping por mercado (spec §3.3).
// Corre todos los plugins activos con Promise.allSettled — un plugin roto
// (sitio caído, cambio de HTML) nunca frena a los demás.

import type { Signal } from "../../../core/signal.types";
import type { ScraperPlugin } from "./types";
import { ifemaMadridPlugin } from "./plugins/es-ifema-madrid";
import { laRuralPlugin } from "./plugins/ar-la-rural";
import { baFerialPlugin } from "./plugins/ar-ba-ferial";
import { mendozaTurismoPlugin } from "./plugins/ar-mendoza-turismo";
import { anhembiPlugin } from "./plugins/br-anhembi";
import { odsPlugins } from "./plugins/opendatasoft";
import { socrataPlugins } from "./plugins/socrata";
import { drupalPlugins } from "./plugins/drupal-jsonapi";
import { tribePlugins } from "./plugins/tribe-events";
import { chileCulturaPlugin } from "./plugins/cl-chilecultura";
import { meetupPlugin } from "./plugins/meetup";
import { icsPlugins } from "./plugins/ics-generic";

const PLUGINS: ScraperPlugin[] = [
  // Predios feriales y agendas propias (HTML/iCal)
  ifemaMadridPlugin,
  laRuralPlugin,
  baFerialPlugin, // reemplaza a Costa Salguero (sitio suspendido desde 2026)
  mendozaTurismoPlugin,
  anhembiPlugin, // reemplaza a SP Expo (robots.txt bloquea bots de IA)
  // APIs oficiales de open data, una entrada de config por ciudad
  ...odsPlugins, // Opendatasoft (París, Île-de-France)
  ...socrataPlugins, // Socrata (Nueva York, San Francisco, Chicago, Catalunya)
  ...drupalPlugins, // Drupal JSON:API (Buenos Aires, Montevideo)
  ...tribePlugins, // The Events Calendar de WordPress (Chicago)
  chileCulturaPlugin,
  meetupPlugin, // long tail global; oportunista, con circuit breaker
  // Feeds iCal genéricos: agendas regionales por config (ICS_FEEDS /
  // IH_ICS_FEEDS), cero código por fuente nueva.
  ...icsPlugins(),
];

export function activePlugins(): ScraperPlugin[] {
  // IH_SCRAPERS_DISABLED="es-ifema-madrid,br-sp-expo" apaga plugins por env
  // sin tocar código.
  const disabled = new Set(
    (process.env.IH_SCRAPERS_DISABLED ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return PLUGINS.filter((p) => p.enabled && !disabled.has(p.sourceLabel));
}

export async function runScrapers(only?: string[]): Promise<{
  signals: Signal[];
  errors: string[];
  perPlugin: Record<string, number>;
}> {
  // `only`: subconjunto por sourceLabel (barrido dirigido a un punto: solo los
  // plugins geolocalizados, sin re-scrapear todas las agendas por mercado).
  const plugins = only ? activePlugins().filter((p) => only.includes(p.sourceLabel)) : activePlugins();
  const signals: Signal[] = [];
  const errors: string[] = [];
  const perPlugin: Record<string, number> = {};

  const results = await Promise.allSettled(plugins.map((p) => p.scrape()));
  results.forEach((res, i) => {
    const label = plugins[i].sourceLabel;
    if (res.status === "fulfilled") {
      perPlugin[label] = res.value.length;
      signals.push(...res.value);
    } else {
      // Los plugins no deberían rechazar (devuelven [] ante fallo), pero si
      // uno lo hace, se registra sin frenar al resto.
      perPlugin[label] = 0;
      errors.push(`${label}: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`);
    }
  });

  return { signals, errors, perPlugin };
}
