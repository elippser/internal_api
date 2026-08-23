import type { SignalConnectorId } from "../../competitors.model";
import { appStoreConnector } from "./appStore.connector";
import { googlePlayConnector } from "./googlePlay.connector";
import { newsConnector } from "./news.connector";
import { productHuntConnector } from "./producthunt.connector";
import { redditConnector } from "./reddit.connector";
import { rssConnector } from "./rss.connector";
import { searchSnippetsConnector } from "./searchSnippets.connector";
import { trendsConnector } from "./trends.connector";
import type { SignalConnector } from "./types";
import { watchedPagesConnector } from "./watchedPages.connector";
import { youtubeConnector } from "./youtube.connector";

/** Registro de connectors de senales (orden = orden de corrida). */
export const SIGNAL_CONNECTOR_REGISTRY: SignalConnector[] = [
  watchedPagesConnector,
  rssConnector,
  appStoreConnector,
  googlePlayConnector,
  youtubeConnector,
  productHuntConnector,
  redditConnector,
  newsConnector,
  trendsConnector,
  searchSnippetsConnector, // el mas caro al final: si el presupuesto se corta, corta aca
];

export function getSignalConnector(id: SignalConnectorId | string): SignalConnector | null {
  return SIGNAL_CONNECTOR_REGISTRY.find((c) => c.id === id) ?? null;
}
