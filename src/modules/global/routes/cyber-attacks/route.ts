// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';
import { geolocateIPs } from '../../lib/ipGeo';

export const dynamic = 'force-dynamic';

/**
 * elippser — Live Botnet C2 Infrastructure
 * Feodo Tracker C2 servers geolocated by their real IP via ip-api batch.
 * Every point is the actual location of a tracked C2 server — no synthetic
 * attack origins, no jitter, no cloned records.
 */

let cached: any = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60_000; // Feodo updates a few times per hour

export async function GET() {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
    });
  }

  try {
    const res = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { 'User-Agent': 'elippser/4.3', Accept: 'application/json' },
    });

    if (!res.ok) {
      return NextResponse.json({ attacks: [], total: 0, error: 'Feodo unavailable' });
    }

    const raw = await res.json();
    const entries = (Array.isArray(raw) ? raw : [])
      .filter((e: any) => e.ip_address)
      .sort((a: any, b: any) => String(b.last_online || '').localeCompare(String(a.last_online || '')))
      .slice(0, 100); // ip-api batch limit

    const geoMap = await geolocateIPs(entries.map((e: any) => e.ip_address));

    const attacks = entries.flatMap((entry: any) => {
      const geo = geoMap.get(entry.ip_address);
      if (!geo) return [];
      return [{
        id: `c2-${entry.ip_address}:${entry.port || 0}`,
        lat: geo.lat,
        lng: geo.lon,
        ip: entry.ip_address,
        port: entry.port || entry.dst_port || null,
        malware: entry.malware || 'Unknown',
        status: entry.status || 'unknown',
        country: geo.countryCode || entry.country || '—',
        city: geo.city || '—',
        isp: geo.isp || entry.as_name || '—',
        first_seen: entry.first_seen || null,
        last_online: entry.last_online || null,
      }];
    });

    const result = {
      attacks,
      total: attacks.length,
      online: attacks.filter((a: any) => a.status === 'online').length,
      timestamp: new Date().toISOString(),
      source: 'abuse.ch Feodo Tracker · geolocated via ip-api',
    };

    cached = result;
    cacheTime = now;

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
    });
  } catch (error) {
    console.error('[elippser] C2 infrastructure feed error:', error);
    return NextResponse.json({ attacks: [], total: 0, error: 'Feed unavailable' }, { status: 500 });
  }
}
