// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import type { CctvCamera } from './types';

// ── Existing YouTube Live Streams ──
const YOUTUBE_LIVE: CctvCamera[] = [
  {
    id: 'fr-paris-1', lat: 48.8584, lng: 2.2945,
    name: 'Paris - Eiffel Tower Area', city: 'Paris', country: 'France',
    stream_url: 'https://www.youtube.com/embed/UMuEooW0iAQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe', source: 'YouTube Live',
  },
  {
    id: 'fr-paris-2', lat: 48.8600, lng: 2.3300,
    name: 'Paris - Louvre Area', city: 'Paris', country: 'France',
    stream_url: 'https://www.youtube.com/embed/OzYp4NRZlwQ?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe', source: 'YouTube Live',
  },
  {
    id: 'fr-nice-1', lat: 43.6961, lng: 7.2717,
    name: 'Nice - Promenade des Anglais', city: 'Nice', country: 'France',
    stream_url: 'https://www.youtube.com/embed/YAdNYoRY0Cw?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe', source: 'YouTube Live',
  },
  {
    id: 'fr-nice-2', lat: 43.7000, lng: 7.2600,
    name: 'Nice - City View', city: 'Nice', country: 'France',
    stream_url: 'https://www.youtube.com/embed/asO_10T0k2k?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0',
    stream_type: 'iframe', source: 'YouTube Live',
  }
];

// ── SkylineWebcams — Live Snapshot JPGs (auto-refresh) ──
// Source: https://www.skylinewebcams.com/fr/webcam/france.html
const SKYLINE_FRANCE: CctvCamera[] = [
  { id: 'sky-fr-calanques', lat: 43.2100, lng: 5.4300, name: 'Marseille - Les Calanques', city: 'Marseille', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1234.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/provence-alpes-cote-dazur/marseille/les-calanques-de-marseille.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-frejus', lat: 43.4330, lng: 6.7370, name: 'Plage de Fréjus', city: 'Fréjus', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1235.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/provence-alpes-cote-dazur/frejus/plage-de-frejus.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-la-rochelle', lat: 46.1591, lng: -1.1520, name: 'La Rochelle - Vieux Port', city: 'La Rochelle', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1236.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/nouvelle-aquitaine/la-rochelle/vieux-port.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-royan', lat: 45.6284, lng: -1.0286, name: 'Royan - Plage de Pontaillac', city: 'Royan', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1237.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/nouvelle-aquitaine/royan/plage-de-pontaillac.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-mont-dore', lat: 45.5740, lng: 2.8080, name: 'Le Mont-Dore - Sommet de Sancy', city: 'Le Mont-Dore', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1238.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/auvergne-rhone-alpes/mont-dore/le-mont-dore.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-sete', lat: 43.4035, lng: 3.6970, name: 'Sète - Port de Plaisance', city: 'Sète', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1239.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/occitanie/sete/port-de-plaisance.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-bourget', lat: 45.6910, lng: 5.8810, name: 'Lac du Bourget - Aix les Bains', city: 'Aix-les-Bains', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1240.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/auvergne-rhone-alpes/aix-les-bains/lac-du-bourget.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-porto-vecchio', lat: 41.5910, lng: 9.2790, name: 'Porto-Vecchio - Plage de Folaca', city: 'Porto-Vecchio', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1241.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/corsica/porto-vecchio/porto-vecchio-folacca-beach.html', source: 'SkylineWebcams' },
  { id: 'sky-fr-menton', lat: 43.7750, lng: 7.4990, name: 'Menton - Vue Panoramique', city: 'Menton', country: 'France', feed_url: '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1242.jpg', external_url: 'https://www.skylinewebcams.com/en/webcam/france/provence-alpes-cote-dazur/menton/vue-panoramique.html', source: 'SkylineWebcams' },
];

const FRANCE_CAMERAS: CctvCamera[] = [...YOUTUBE_LIVE, ...SKYLINE_FRANCE];

export async function fetchFranceCameras(): Promise<CctvCamera[]> {
  return FRANCE_CAMERAS;
}
