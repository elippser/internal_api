// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../../runtime/next-shim';
import { airlineFor } from '../../../lib/airlines';

export const dynamic = 'force-dynamic';

/**
 * elippser — Flight Route Lookup
 * Resolves a callsign to its operating airline and origin/destination airports
 * via adsbdb.com (free, no key). Used on demand when an aircraft is selected —
 * looking this up for every aircraft in the feed would be thousands of requests.
 */

const cache = new Map<string, { data: any; at: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000; // routes are stable within a day

export async function GET(request: Request) {
  const callsign = (new URL(request.url).searchParams.get('callsign') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(callsign)) {
    return NextResponse.json({ error: 'Invalid callsign' }, { status: 400 });
  }

  const hit = cache.get(callsign);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return NextResponse.json(hit.data, { headers: { 'Cache-Control': 'public, s-maxage=3600' } });
  }

  // Local table first — instant, and covers the major carriers even when
  // adsbdb has no route for this particular flight number.
  const localAirline = airlineFor(callsign.slice(0, 3));

  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const fallback = {
        callsign,
        airline: localAirline?.name || null,
        airline_country: localAirline?.country || null,
        origin: null, destination: null,
        source: localAirline ? 'elippser ICAO table' : null,
      };
      return NextResponse.json(fallback);
    }

    const json = await res.json();
    const fr = json?.response?.flightroute;
    const ap = (a: any) => a ? {
      iata: a.iata_code || null,
      icao: a.icao_code || null,
      name: a.name || null,
      city: a.municipality || null,
      country: a.country_name || null,
      lat: typeof a.latitude === 'number' ? a.latitude : null,
      lng: typeof a.longitude === 'number' ? a.longitude : null,
    } : null;

    const data = {
      callsign,
      callsign_iata: fr?.callsign_iata || null,
      airline: fr?.airline?.name || localAirline?.name || null,
      airline_iata: fr?.airline?.iata || localAirline?.iata || null,
      airline_country: fr?.airline?.country || localAirline?.country || null,
      origin: ap(fr?.origin),
      destination: ap(fr?.destination),
      source: fr ? 'adsbdb.com' : (localAirline ? 'elippser ICAO table' : null),
    };

    cache.set(callsign, { data, at: Date.now() });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=3600' } });
  } catch {
    return NextResponse.json({
      callsign,
      airline: localAirline?.name || null,
      airline_country: localAirline?.country || null,
      origin: null, destination: null,
      source: localAirline ? 'elippser ICAO table' : null,
    });
  }
}
