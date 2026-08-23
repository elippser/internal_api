// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';

export const dynamic = 'force-dynamic';

/**
 * elippser — Health Check
 * Actually probes the critical upstream data sources instead of returning a
 * hardcoded "operational". Each probe is a real request with a short timeout.
 */

const UPSTREAMS: { name: string; url: string }[] = [
  { name: 'usgs_earthquakes', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson' },
  { name: 'adsb_flights', url: 'https://api.airplanes.live/v2/squawk/7700' },
  { name: 'abusech_feodo', url: 'https://feodotracker.abuse.ch/downloads/ipblocklist.json' },
  { name: 'gdacs', url: 'https://www.gdacs.org/xml/rss.xml' },
];

export async function GET() {
  const checks = await Promise.all(
    UPSTREAMS.map(async ({ name, url }) => {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          cache: 'no-store',
          headers: { 'User-Agent': 'elippser-healthcheck/1.0' },
        });
        await res.body?.cancel();
        return { name, ok: res.ok, status: res.status, latency_ms: Date.now() - started };
      } catch {
        return { name, ok: false, status: 0, latency_ms: Date.now() - started };
      }
    })
  );

  const okCount = checks.filter(c => c.ok).length;
  const status = okCount === checks.length ? 'operational'
    : okCount > 0 ? 'degraded'
    : 'outage';

  return NextResponse.json({
    status,
    platform: 'elippser',
    uptime_s: process.uptime ? Math.round(process.uptime()) : 0,
    upstreams: checks,
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
