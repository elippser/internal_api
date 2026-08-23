// Connector Sports Fixtures (RADAR-DEMAND-DATA-SPEC.md #9): próximos
// partidos de ligas mayores vía TheSportsDB. Un partido de liga top llena la
// ciudad receptora (hinchas visitantes + neutrales) y el fixture se publica
// con semanas/meses de antelación — señal de demanda directa.
//
// Emite type "event" con segment "sports": reutiliza todo el pipeline de
// eventos (summary, capa ih_events, clustering) sin código nuevo aguas abajo.
//
// Geocodificación: TheSportsDB no publica lat/lng confiable, así que el
// fixture se ancla a la ciudad del catálogo turístico (la demanda hotelera
// es de la ciudad, no del asiento del estadio). Cadena de resolución:
// strCity → lookup del venue (strLocation) → descartar si no matchea; los
// descartados se cuentan en meta.unresolved para calibrar el catálogo.

import { v4 as uuid } from "uuid";
import { activeCities, TOURIST_CITIES, type TouristCity, catalogWithSweepPoints, sweepCities, type SweepPoint } from "../core/cities.catalog";
import { EVENT_SEGMENT_WEIGHTS, SPORTS_CONFIG } from "../core/intelligence.config";
import { fetchJson } from "../core/http";
import {
  SOURCE_CONFIDENCE,
  type Connector,
  type ConnectorFetchResult,
  type Signal,
} from "../core/signal.types";

const BASE = "https://www.thesportsdb.com/api/v1/json";

interface TsdbEvent {
  idEvent: string;
  strEvent: string;
  strLeague: string;
  dateEvent: string | null; // YYYY-MM-DD
  strTime?: string | null;
  strVenue?: string | null;
  idVenue?: string | null;
  strCity?: string | null;
  strCountry?: string | null;
}

interface TsdbVenue {
  idVenue: string;
  strVenue: string;
  strLocation?: string | null; // "Holloway, London"
  intCapacity?: string | null;
  strMap?: string | null; // coordenadas DMS: 51°33′24″N 0°6′22″W
}

// strMap del venue viene en DMS ("51°33′24″N 0°6′22″W") → decimal. Si
// parsea, el fixture se ancla al estadio exacto en vez del centro urbano.
function dmsToDecimal(dms: string | null | undefined): { lat: number; lng: number } | null {
  if (!dms) return null;
  const re = /(\d{1,3})°(?:(\d{1,2})[′'])?(?:(\d{1,2}(?:\.\d+)?)[″"])?\s*([NSEW])/g;
  const parts: Array<{ value: number; hemi: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(dms)) !== null) {
    const deg = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const sec = Number(m[3] ?? 0);
    const value = deg + min / 60 + sec / 3600;
    parts.push({ value, hemi: m[4] });
  }
  const latPart = parts.find((p) => p.hemi === "N" || p.hemi === "S");
  const lngPart = parts.find((p) => p.hemi === "E" || p.hemi === "W");
  if (!latPart || !lngPart) return null;
  const lat = latPart.hemi === "S" ? -latPart.value : latPart.value;
  const lng = lngPart.hemi === "W" ? -lngPart.value : lngPart.value;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// El catálogo usa nombres en español; TheSportsDB responde en inglés.
// Se normaliza sin acentos en ambos lados + alias explícitos EN→catálogo.
const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

const EN_ALIASES: Record<string, string> = {
  london: "Londres",
  "new york": "Nueva York",
  munich: "Múnich",
  manchester: "Mánchester",
  milan: "Milán",
  rome: "Roma",
  lisbon: "Lisboa",
  seville: "Sevilla",
  naples: "Nápoles",
  frankfurt: "Fráncfort",
  hamburg: "Hamburgo",
  cologne: "Colonia",
  vienna: "Viena",
  zurich: "Zúrich",
  geneva: "Ginebra",
  prague: "Praga",
  athens: "Atenas",
  istanbul: "Estambul",
  copenhagen: "Copenhague",
  stockholm: "Estocolmo",
  warsaw: "Varsovia",
  krakow: "Cracovia",
  brussels: "Bruselas",
  amsterdam: "Ámsterdam",
  "sao paulo": "São Paulo",
  "rio de janeiro": "Río de Janeiro",
  sydney: "Sídney",
  dubai: "Dubái",
  "mexico city": "Ciudad de México",
  havana: "La Habana",
  "cape town": "Ciudad del Cabo",
  johannesburg: "Johannesburgo",
  cairo: "El Cairo",
  edinburgh: "Edimburgo",
  dublin: "Dublín",
  florence: "Florencia",
  venice: "Venecia",
  berlin: "Berlín",
  paris: "París",
  nice: "Niza",
  marseille: "Marsella",
  malaga: "Málaga",
  oporto: "Oporto",
  porto: "Oporto",
};

function buildCityIndex(): Map<string, TouristCity> {
  const idx = new Map<string, TouristCity>();
  for (const c of catalogWithSweepPoints()) {
    idx.set(strip(c.label), c);
    // Los puntos de barrido llegan con el nombre de la ciudad de la property
    // ("San Miguel de Tucumán"); TheSportsDB a veces usa la forma corta
    // ("Tucumán") en strCity/strLocation.
    const words = strip(c.label).split(" ").filter(Boolean);
    if ((c as SweepPoint).isWatchpoint && words.length >= 2) {
      const last = words[words.length - 1];
      if (last.length >= 5 && !idx.has(last)) idx.set(last, c);
    }
  }
  for (const [en, label] of Object.entries(EN_ALIASES)) {
    const city = TOURIST_CITIES.find((c) => c.label === label);
    if (city) idx.set(en, city);
  }
  return idx;
}

function matchCity(idx: Map<string, TouristCity>, text: string | null | undefined): TouristCity | null {
  if (!text) return null;
  const t = strip(text);
  if (idx.has(t)) return idx.get(t)!;
  // strLocation viene como "Ciudad, Región" o "Ciudad, País".
  for (const part of t.split(",").map((p) => p.trim())) {
    if (idx.has(part)) return idx.get(part)!;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// La key dev "3" rate-limitea agresivo (~429 tras un puñado de requests,
// verificado 2026-08): con ella se espacia MUCHO y ante 429 se enfría y
// reintenta una vez. Con key propia el paso baja a 300 ms.
const THROTTLE_MS = SPORTS_CONFIG.apiKey === "3" ? 2_500 : 300;
const COOLDOWN_MS = 20_000;

async function fetchWithCooldown<T>(url: string): Promise<T> {
  try {
    return await fetchJson<T>(url, { retries: 0 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("429")) {
      await sleep(COOLDOWN_MS);
      return await fetchJson<T>(url, { retries: 0 });
    }
    throw err;
  }
}

export function createSportsConnector(): Connector {
  return {
    name: "sports",

    async healthCheck() {
      try {
        const res = await fetchJson<{ events: TsdbEvent[] | null }>(
          `${BASE}/${SPORTS_CONFIG.apiKey}/eventsnextleague.php?id=4328`,
          { retries: 0 },
        );
        return {
          ok: Array.isArray(res.events),
          detail: `thesportsdb OK (key ${SPORTS_CONFIG.apiKey === "3" ? "dev pública" : "propia"})`,
        };
      } catch (err) {
        return { ok: false, detail: `thesportsdb inaccesible: ${(err as Error).message}` };
      }
    },

    async fetch(): Promise<ConnectorFetchResult> {
      const cityIdx = buildCityIndex();
      const activeLabels = new Set(sweepCities().map((c) => c.label));
      const signals: Signal[] = [];
      const errors: string[] = [];
      const perLeague: Record<string, number> = {};
      let unresolved = 0;

      // Cache de venues por corrida: muchos fixtures comparten estadio.
      const venueCache = new Map<string, TsdbVenue | null>();
      let venueLookups = 0;
      const MAX_VENUE_LOOKUPS = 60; // free tier ~30 req/min; no agotar cuota acá

      const lookupVenue = async (idVenue: string): Promise<TsdbVenue | null> => {
        if (venueCache.has(idVenue)) return venueCache.get(idVenue)!;
        if (venueLookups >= MAX_VENUE_LOOKUPS) return null;
        venueLookups++;
        try {
          await sleep(THROTTLE_MS);
          const res = await fetchWithCooldown<{ venues: TsdbVenue[] | null }>(
            `${BASE}/${SPORTS_CONFIG.apiKey}/lookupvenue.php?id=${idVenue}`,
          );
          const venue = res.venues?.[0] ?? null;
          venueCache.set(idVenue, venue);
          return venue;
        } catch {
          venueCache.set(idVenue, null);
          return null;
        }
      };

      // Secuencial con pausa larga: ver THROTTLE_MS/fetchWithCooldown.
      for (const league of SPORTS_CONFIG.leagues) {
        try {
          await sleep(THROTTLE_MS);
          const res = await fetchWithCooldown<{ events: TsdbEvent[] | null }>(
            `${BASE}/${SPORTS_CONFIG.apiKey}/eventsnextleague.php?id=${league.id}`,
          );
          const events = res.events ?? [];
          perLeague[league.label] = events.length;

          for (const ev of events) {
            if (!ev.dateEvent || !/^\d{4}-\d{2}-\d{2}$/.test(ev.dateEvent)) continue;

            let city = matchCity(cityIdx, ev.strCity);
            let capacity: number | null = null;
            let exact: { lat: number; lng: number } | null = null;
            if (ev.idVenue && (!city || !exact)) {
              const venue = await lookupVenue(ev.idVenue);
              if (venue) {
                if (!city) city = matchCity(cityIdx, venue.strLocation);
                exact = dmsToDecimal(venue.strMap);
                const cap = Number(venue.intCapacity);
                capacity = Number.isFinite(cap) && cap > 0 ? cap : null;
              }
            }
            if (!city || !activeLabels.has(city.label)) {
              unresolved++;
              continue;
            }

            const base = EVENT_SEGMENT_WEIGHTS.sports ?? 0.7;
            signals.push({
              id: uuid(),
              type: "event",
              source: "thesportsdb",
              scope: {
                geo: {
                  // Estadio exacto cuando el venue publica strMap; si no, el
                  // centro urbano del catálogo (la demanda es de la ciudad).
                  lat: exact?.lat ?? city.lat,
                  lng: exact?.lng ?? city.lng,
                  countryCode: city.countryCode,
                  city: city.label,
                },
              },
              timeWindow: {
                // Día completo: la demanda hotelera es noche previa + noche
                // del partido, no las 2 horas del evento.
                start: `${ev.dateEvent}T00:00:00Z`,
                end: `${ev.dateEvent}T23:59:59Z`,
              },
              magnitude: Math.min(1, base * league.weight),
              confidence: SOURCE_CONFIDENCE.thesportsdb,
              rawPayload: {
                name: ev.strEvent,
                venue: ev.strVenue ?? null,
                segment: "sports",
                category: "sports",
                league: league.label,
                capacity,
                time: ev.strTime ?? null,
                url: `https://www.thesportsdb.com/event/${ev.idEvent}`,
              },
              ingestedAt: "",
              dedupeKey: `event:thesportsdb:${ev.idEvent}`,
            });
          }
        } catch (err) {
          errors.push(`${league.label}: ${(err as Error).message}`);
        }
      }

      return {
        signals,
        meta: {
          leagues: SPORTS_CONFIG.leagues.length,
          perLeague,
          venueLookups,
          unresolved,
          produced: signals.length,
          ...(errors.length ? { errors } : {}),
        },
      };
    },
  };
}
