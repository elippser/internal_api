// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */

import { NextResponse } from '../../runtime/next-shim';
import { stealthFetch } from '../../lib/stealthFetch';
import { airlineFor } from '../../lib/airlines';

export const maxDuration = 60;

// Regions covering every major aviation corridor at 250 nm radius.
// Focused on high-density airspace: US domestic, North Atlantic, Europe,
// Middle East hub, India, East Asia, SE Asia, Australia, Latin America.
const REGIONS = [
  // North America
  { lat: 39.8,  lon: -98.5 }, // Central US
  { lat: 41.0,  lon: -74.0 }, // Northeast (NYC/Boston/DC)
  { lat: 33.0,  lon: -84.0 }, // Southeast (Atlanta)
  { lat: 42.0,  lon: -88.0 }, // Midwest (Chicago)
  { lat: 30.0,  lon: -97.0 }, // Texas (Dallas/Houston)
  { lat: 47.0,  lon:-122.0 }, // Pacific Northwest (Seattle)
  { lat: 34.0,  lon:-118.0 }, // SoCal (LA)
  { lat: 45.0,  lon: -73.0 }, // Canada East (Montreal/Toronto)
  { lat: 49.0,  lon: -97.0 }, // Canada Prairies
  // Europe
  { lat: 50.0,  lon:  15.0 }, // Central Europe
  { lat: 51.5,  lon:  -1.0 }, // UK / Ireland
  { lat: 47.0,  lon:   2.0 }, // France / Alps
  { lat: 40.0,  lon:  -4.0 }, // Iberia
  { lat: 42.0,  lon:  13.0 }, // Italy / Adriatic
  { lat: 60.0,  lon:  15.0 }, // Scandinavia
  { lat: 52.0,  lon:  22.0 }, // Eastern Europe / Baltics
  { lat: 39.0,  lon:  35.0 }, // Turkey / Aegean
  // Middle East & South Asia
  { lat: 25.0,  lon:  45.0 }, // Arabian Gulf (Dubai/Riyadh)
  { lat: 22.0,  lon:  78.0 }, // India
  // East Asia & Pacific
  { lat: 35.0,  lon: 105.0 }, // China
  { lat: 35.0,  lon: 136.0 }, // Japan
  { lat: 37.0,  lon: 127.0 }, // Korea
  { lat: 13.0,  lon: 100.0 }, // SE Asia (Bangkok)
  { lat:  1.0,  lon: 104.0 }, // Singapore / Malacca Strait
  // Australia
  { lat:-25.0,  lon: 133.0 }, // Central Australia
  { lat:-33.0,  lon: 151.0 }, // Eastern Australia (Sydney)
  // Africa
  { lat:  0.0,  lon:  20.0 }, // Central Africa
  { lat:-26.0,  lon:  28.0 }, // South Africa
];

// Latin America is thinly covered by OpenSky's receiver network, so these
// points are queried against the ADS-B feeder networks on every refresh —
// not only when OpenSky fails. Measured: ~37 aircraft per sweep that OpenSky
// does not report at all.
const LATAM_REGIONS = [
  // Mexico
  { lat: 19.4,  lon: -99.1 },  // Mexico City
  { lat: 25.7,  lon:-100.3 },  // Monterrey
  { lat: 20.7,  lon:-103.3 },  // Guadalajara
  { lat: 21.2,  lon: -86.8 },  // Cancún / Yucatán
  { lat: 32.5,  lon:-117.0 },  // Tijuana / Baja
  // Central America & Caribbean
  { lat:  9.0,  lon: -79.5 },  // Panama City
  { lat: 14.6,  lon: -90.5 },  // Guatemala / El Salvador
  { lat: 18.5,  lon: -69.9 },  // Dominican Republic / PR
  { lat: 23.1,  lon: -82.4 },  // Cuba
  { lat: 12.1,  lon: -68.9 },  // Curaçao / ABC islands
  // Andes & northern South America
  { lat:  4.7,  lon: -74.1 },  // Bogotá
  { lat:  6.2,  lon: -75.6 },  // Medellín
  { lat: 10.5,  lon: -66.9 },  // Caracas
  { lat: -0.2,  lon: -78.5 },  // Quito
  { lat:-12.0,  lon: -77.0 },  // Lima
  { lat:-16.5,  lon: -68.1 },  // La Paz
  // Brazil
  { lat: -3.1,  lon: -60.0 },  // Manaus / Amazonia
  { lat: -8.1,  lon: -34.9 },  // Recife / Northeast
  { lat:-12.9,  lon: -38.5 },  // Salvador
  { lat:-15.8,  lon: -47.9 },  // Brasília
  { lat:-23.5,  lon: -46.6 },  // São Paulo
  { lat:-22.9,  lon: -43.2 },  // Rio de Janeiro
  { lat:-25.4,  lon: -49.3 },  // Curitiba
  { lat:-30.0,  lon: -51.2 },  // Porto Alegre
  // Southern Cone
  { lat:-34.6,  lon: -58.4 },  // Buenos Aires
  { lat:-31.4,  lon: -64.2 },  // Córdoba
  { lat:-34.9,  lon: -56.2 },  // Montevideo
  { lat:-25.3,  lon: -57.6 },  // Asunción
  { lat:-33.4,  lon: -70.7 },  // Santiago
  { lat:-41.1,  lon: -71.3 },  // Patagonia norte
  { lat:-51.6,  lon: -69.2 },  // Patagonia sur
];

const HELI_TYPES = new Set([
  'R22','R44','R66','B06','B06T','B204','B205','B206','B212','B222','B230',
  'B407','B412','B427','B429','B430','B505','B525',
  'AS32','AS35','AS50','AS55','AS65',
  'EC20','EC25','EC30','EC35','EC45','EC55','EC75',
  'H125','H130','H135','H145','H155','H160','H175','H215','H225',
  'S55','S58','S61','S64','S70','S76','S92',
  'A109','A119','A139','A169','A189','AW09',
  'MD52','MD60','MDHI','MD90','NOTR',
  'B47G','HUEY','GAMA','CABR','EXE',
]);

const PRIVATE_JET_TYPES = new Set([
  'G150','G200','G280','GLEX','G500','G550','G600','G650','G700',
  'GLF2','GLF3','GLF4','GLF5','GLF6','GL5T','GL7T','GV','GIV',
  'CL30','CL35','CL60','BD70','BD10',
  'C25A','C25B','C25C','C500','C510','C525','C550','C560','C56X','C680','C700','C750',
  'E35L','E50P','E55P','E545','E550',
  'FA50','FA7X','FA8X','F900','F2TH',
  'LJ35','LJ40','LJ45','LJ60','LJ70','LJ75',
  'PC12','PC24','TBM7','TBM8','TBM9',
  'PRM1','SF50','EA50','VLJ',
]);

const MILITARY_INDICATORS = new Set([
  'C17','C5M','C130','C30J','KC10','KC46','KC35','E3CF','E3TF','E8A',
  'B1B','B2','B52','F16','F15','F18','F22','F35','A10','F117',
  'RC135','E6B','P8A','P3','MQ9','RQ4','U2','EP3','RC12',
  'V22','CH47','UH60','AH64','AH1Z','MV22',
  'EUFI','RFAL','TORD','TYP','GR4',
]);

const AIRLINE_CODE_RE = /^([A-Z]{3})\d/;

// Both providers speak the same tar1090/ADSBexchange-v2 response shape so
// classifyFlight() works unchanged. They run on independent feeder networks
// with minimal overlap — tested: airplanes.live gives ~6K aircraft across 30
// regions, adsb.lol adds ~650 unique on top. Run them simultaneously.
const ADSB_MAX_DIST = 250; // nm — hard cap both providers enforce

async function fetchRegionFrom(
  lat: number, lon: number,
  urlFn: (lat: number, lon: number, dist: number) => string,
  arrayKey: 'ac' | 'aircraft',
): Promise<any[]> {
  try {
    const res = await stealthFetch(urlFn(lat, lon, ADSB_MAX_DIST), {
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      return data[arrayKey] || data.ac || [];
    }
  } catch {}
  return [];
}

function classifyFlight(f: any) {
  const modelUpper = (f.t || '').toUpperCase();
  const flightStr = (f.flight || '').trim().toUpperCase();
  const dbFlags = (f.dbFlags || 0);

  if (modelUpper === 'TWR') return null;

  const lat = f.lat;
  const lon = f.lon;
  if (lat == null || lon == null) return null;

  const callsign = flightStr || f.hex || 'UNKNOWN';
  const altRaw = f.alt_baro;
  const altMeters = typeof altRaw === 'number' ? altRaw * 0.3048 : 0;
  const speedKnots = typeof f.gs === 'number' ? Math.round(f.gs * 10) / 10 : null;
  const heading = f.track || 0;
  const isHeli = HELI_TYPES.has(modelUpper) || f.category_os === 8;
  const isGrounded = typeof altRaw === 'number' && altRaw < 100;

  const isOsMilitary = f.category_os === 14;
  const isOsJet = f.category_os === 7 || f.category_os === 3;
  const isOsPrivate = f.category_os === 2;

  const airlineMatch = AIRLINE_CODE_RE.exec(callsign);
  const airlineCode = airlineMatch ? airlineMatch[1] : '';
  const airline = airlineFor(airlineCode);

  let category: 'commercial' | 'private' | 'jet' | 'military' = 'commercial';
  if (isOsMilitary || dbFlags & 1 || MILITARY_INDICATORS.has(modelUpper) || (f.flight || '').match(/^(RCH|KING|DUKE|EVAC|JAKE|REACH|CONVOY)\d/i)) {
    category = 'military';
  } else if (isOsJet || PRIVATE_JET_TYPES.has(modelUpper)) {
    category = 'jet';
  } else if (isOsPrivate || (!airlineCode && modelUpper && !['A319','A320','A321','A332','A333','A339','A343','A359','A388','B737','B738','B739','B38M','B39M','B752','B753','B763','B764','B772','B77L','B77W','B788','B789','B78X','E170','E175','E190','E195','CRJ7','CRJ9','AT43','AT72','DH8D'].includes(modelUpper))) {
    category = 'private';
  }

  return {
    callsign,
    lat: Math.round(lat * 100000) / 100000,
    lng: Math.round(lon * 100000) / 100000,
    alt: Math.round(altMeters),
    heading: Math.round(heading),
    speed_knots: speedKnots,
    model: f.t || 'Unknown',
    icao24: f.hex || '',
    registration: f.r || 'N/A',
    squawk: f.squawk || '',
    airline_code: airlineCode,
    // Resolved from the ICAO designator table; null when the code is unknown
    // (the raw callsign is shown rather than a guessed carrier).
    airline: airline?.name || null,
    airline_iata: airline?.iata || null,
    airline_country: airline?.country || null,
    aircraft_category: isHeli ? 'heli' : 'plane',
    category,
    grounded: isGrounded,
    nac_p: f.nac_p,
    type: 'flight',
  };
}

let cachedData: any = null;
let lastFetchTime = 0;
// 90s TTL keeps us well within the authenticated OpenSky budget (4000 credits/day,
// 4 credits/call = 1000 calls/day ≈ one per 86s). The old 45s TTL at ~1920 calls/day
// was what got the VPS IP rate-limited on the anonymous pool.
const CACHE_TTL = 90000;
let fetchPromise: Promise<any> | null = null;

// Back off from OpenSky after a 429 so the daily quota can reset.
// Re-poking a limited endpoint on every cache miss keeps the IP throttled.
let openSkyCooldownUntil = 0;
const OPENSKY_COOLDOWN = 15 * 60 * 1000; // 15 min

// OpenSky OAuth2 — optional but recommended for VPS deployments.
// Without keys: anonymous, works fine on residential IPs. VPS IPs can
// be throttled by OpenSky's anonymous per-IP pool. Setting these env
// vars bypasses the per-IP pool (account pool: 4000 credits/day).
let osToken: string | null = null;
let osTokenExpiry = 0;

async function getOpenSkyToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (osToken && Date.now() < osTokenExpiry) return osToken;
  try {
    const res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) { console.warn('[elippser] OpenSky token failed:', res.status); return null; }
    const data = await res.json();
    if (!data.access_token) {
      console.warn('[elippser] OpenSky token response missing access_token');
      return null;
    }
    osToken = data.access_token;
    osTokenExpiry = Date.now() + ((data.expires_in || 1800) - 60) * 1000;
    return osToken;
  } catch (e) {
    console.warn('[elippser] OpenSky token error:', e);
    return null;
  }
}

function ingestAc(raw: any[], into: any[], seen: Set<string>) {
  for (const ac of raw) {
    const hex = (ac.hex || '').toLowerCase().trim();
    if (hex && !seen.has(hex)) { seen.add(hex); into.push(ac); }
  }
}

export async function GET() {
  const now = Date.now();

  if (cachedData && now - lastFetchTime < CACHE_TTL) {
    return NextResponse.json(cachedData, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  if (fetchPromise) {
    try {
      const data = await fetchPromise;
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    } catch {
      return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 500 });
    }
  }

  const JAMMING_NACAP_THRESHOLD = 4;

  fetchPromise = (async () => {
    const allRaw: any[] = [];
    const seenHex = new Set<string>();
    let source: string;

    // ── Phase 1 + 2 in parallel: global type feeds AND OpenSky simultaneously ──
    // Running them together keeps total wall-clock time to max(global_feeds, opensky)
    // instead of sum. Global feeds cover mil/ladd/pia from two independent networks
    // and run regardless of OpenSky status.
    const skipOpenSky = Date.now() < openSkyCooldownUntil;
    const token = skipOpenSky ? null : await getOpenSkyToken();
    const osInit: RequestInit = token
      ? { signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}` } }
      : { signal: AbortSignal.timeout(30000) };

    const [apl_mil, apl_ladd, apl_pia, apl_emg, lol_mil, lol_ladd, lol_pia, lol_emg, osRes] = await Promise.allSettled([
      stealthFetch('https://api.airplanes.live/v2/mil',          { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.airplanes.live/v2/ladd',         { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.airplanes.live/v2/pia',          { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.airplanes.live/v2/squawk/7700',  { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.adsb.lol/v2/mil',                { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.adsb.lol/v2/ladd',               { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.adsb.lol/v2/pia',                { signal: AbortSignal.timeout(15000) }),
      stealthFetch('https://api.adsb.lol/v2/squawk/7700',        { signal: AbortSignal.timeout(15000) }),
      skipOpenSky
        ? Promise.reject(new Error('OpenSky in cooldown'))
        : stealthFetch('https://opensky-network.org/api/states/all', osInit),
    ]);

    // Drain global type feeds — parse ok responses, discard body on non-ok to free TCP connections.
    // Covers: military, LADD (limited display), PIA (privacy ICAO), and emergency squawk 7700
    // from two independent feeder networks (airplanes.live + adsb.lol).
    const globalFeeds = await Promise.allSettled(
      [apl_mil, apl_ladd, apl_pia, apl_emg, lol_mil, lol_ladd, lol_pia, lol_emg].map(async r => {
        if (r.status !== 'fulfilled') return;
        if (r.value.ok) {
          const data = await r.value.json();
          ingestAc(data.ac || [], allRaw, seenHex);
        } else {
          await r.value.body?.cancel();
        }
      })
    );
    void globalFeeds; // allSettled — errors already isolated per feed

    // Process OpenSky states
    let openSkyWorked = false;
    if (osRes.status === 'fulfilled') {
      if (osRes.value.status === 429) {
        openSkyCooldownUntil = Date.now() + OPENSKY_COOLDOWN;
        console.warn('[elippser] OpenSky 429 — cooling down 15 min');
        await osRes.value.body?.cancel();
      } else if (osRes.value.ok) {
        try {
          const data = await osRes.value.json();
          const states = data.states || [];
          if (states.length > 100) {
            openSkyWorked = true;
            for (const s of states) {
              const hex = (s[0] || '').toLowerCase().trim();
              if (hex && !seenHex.has(hex)) {
                seenHex.add(hex);
                allRaw.push({
                  hex: s[0],
                  flight: s[1]?.trim(),
                  lon: s[5],
                  lat: s[6],
                  alt_baro: typeof s[7] === 'number' ? s[7] * 3.28084 : null,
                  gs: typeof s[9] === 'number' ? s[9] * 1.94384 : null,
                  track: s[10],
                  squawk: s[14],
                  category_os: s[17],
                });
              }
            }
          }
        } catch (e) {
          console.warn('[elippser] OpenSky parse error:', e);
        }
      } else {
        await osRes.value.body?.cancel();
      }
    }

    // ── Phase 3: Regional fallback (when OpenSky unavailable) ─────────────────
    // airplanes.live + adsb.lol are independent feeder networks. Tested:
    // airplanes.live gives ~6 K aircraft across 30 regions, adsb.lol adds
    // ~650 more unique on top — combined ~6.8 K from zero keys.
    const aplFn = (la: number, lo: number, d: number) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`;
    const lolFn = (la: number, lo: number, d: number) => `https://api.adsb.lol/v2/point/${la}/${lo}/${d}`;

    if (!openSkyWorked) {
      source = 'regional';
      console.warn('[elippser] OpenSky unavailable — fanning out regional queries');

      const [aplResults, lolResults] = await Promise.all([
        Promise.allSettled(REGIONS.map(r => fetchRegionFrom(r.lat, r.lon, aplFn, 'ac'))),
        Promise.allSettled(REGIONS.map(r => fetchRegionFrom(r.lat, r.lon, lolFn, 'ac'))),
      ]);

      for (const results of [aplResults, lolResults]) {
        for (const r of results) {
          if (r.status === 'fulfilled') ingestAc(r.value, allRaw, seenHex);
        }
      }
    } else {
      source = osToken ? 'opensky-auth' : 'opensky-anon';
    }

    // ── Latin America top-up (always, both paths) ──────────────────────────
    // OpenSky's states/all under-reports LATAM badly relative to actual traffic.
    // ingestAc() dedupes by hex, so this only ever adds aircraft the earlier
    // passes missed. Skipped when the regional fan-out above already ran, since
    // REGIONS covers Brazil and these points would be redundant work.
    if (openSkyWorked) {
      const before = allRaw.length;
      const latamResults = await Promise.allSettled(
        LATAM_REGIONS.map(r => fetchRegionFrom(r.lat, r.lon, aplFn, 'ac'))
      );
      for (const r of latamResults) {
        if (r.status === 'fulfilled') ingestAc(r.value, allRaw, seenHex);
      }
      const added = allRaw.length - before;
      if (added > 0) {
        source += `+latam(${added})`;
        console.log(`[elippser] LATAM top-up added ${added} aircraft`);
      }
    }

    // ── Classify ──────────────────────────────────────────────────────────────
    const commercial: any[] = [];
    const privateFl: any[] = [];
    const jets: any[] = [];
    const military: any[] = [];
    const gpsJamming: any[] = [];

    for (const raw of allRaw) {
      const flight = classifyFlight(raw);
      if (!flight) continue;

      if (typeof flight.nac_p === 'number' && flight.nac_p <= JAMMING_NACAP_THRESHOLD && !flight.grounded) {
        gpsJamming.push({ lat: flight.lat, lng: flight.lng, nac_p: flight.nac_p, callsign: flight.callsign });
      }

      switch (flight.category) {
        case 'military': military.push(flight); break;
        case 'jet':      jets.push(flight);     break;
        case 'private':  privateFl.push(flight); break;
        default:         commercial.push(flight);
      }
    }

    return {
      commercial_flights: commercial,
      private_flights:    privateFl,
      private_jets:       jets,
      military_flights:   military,
      gps_jamming:        aggregateJamming(gpsJamming, JAMMING_NACAP_THRESHOLD),
      total:              allRaw.length,
      source,
      timestamp:          new Date().toISOString(),
    };
  })();

  try {
    const data = await fetchPromise;
    cachedData = data;
    lastFetchTime = Date.now();
    fetchPromise = null;
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': data.total < 100 ? 'no-store, max-age=0' : 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('[elippser] Flight fetch error:', error);
    fetchPromise = null;
    // Stale-cache fallback: return last known good data instead of blank map
    if (cachedData) {
      console.warn('[elippser] Returning stale flight cache as fallback');
      return NextResponse.json({ ...cachedData, source: (cachedData.source || 'unknown') + '+stale' }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }
    return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 500 });
  }
}

function aggregateJamming(points: any[], threshold: number) {
  if (points.length === 0) return [];
  const grid = new Map<string, { lat: number; lng: number; count: number; total_nac_p: number }>();
  const GRID_SIZE = 2;

  for (const p of points) {
    const gLat = Math.floor(p.lat / GRID_SIZE) * GRID_SIZE;
    const gLng = Math.floor(p.lng / GRID_SIZE) * GRID_SIZE;
    const key = `${gLat},${gLng}`;
    if (!grid.has(key)) grid.set(key, { lat: gLat + GRID_SIZE / 2, lng: gLng + GRID_SIZE / 2, count: 0, total_nac_p: 0 });
    const cell = grid.get(key)!;
    cell.count++;
    cell.total_nac_p += p.nac_p;
  }

  return Array.from(grid.values())
    .filter(z => z.count >= 3)
    .map(z => ({
      lat: z.lat,
      lng: z.lng,
      severity: Math.round((1 - (z.total_nac_p / z.count) / threshold) * 100),
      count: z.count,
    }));
}
