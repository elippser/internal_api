// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';

export const dynamic = 'force-dynamic';

/**
 * elippser — Live Sounding Balloons (WindBorne Systems)
 * Real-time positions of the WindBorne global sounding-balloon constellation.
 * Public endpoint, no key: /treasure/00.json = positions for the current hour,
 * each entry is [lat, lng, altitude_km]. The feed occasionally contains NaN
 * literals (invalid JSON), so the body is sanitized before parsing.
 */

export async function GET() {
  try {
    const res = await fetch('https://a.windbornesystems.com/treasure/00.json', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ balloons: [], total: 0, error: 'WindBorne unavailable' });
    }

    const text = await res.text();
    let raw: any;
    try {
      raw = JSON.parse(text.replace(/\bNaN\b/g, 'null'));
    } catch {
      return NextResponse.json({ balloons: [], total: 0, error: 'WindBorne feed malformed' });
    }

    const balloons = (Array.isArray(raw) ? raw : [])
      .filter((b: any) =>
        Array.isArray(b) &&
        typeof b[0] === 'number' && isFinite(b[0]) && Math.abs(b[0]) <= 90 &&
        typeof b[1] === 'number' && isFinite(b[1]) && Math.abs(b[1]) <= 180
      )
      .map((b: any, i: number) => ({
        callsign: `WB-${String(i + 1).padStart(3, '0')}`,
        lat: b[0],
        lng: b[1],
        altitude: typeof b[2] === 'number' && isFinite(b[2]) ? Math.round(b[2] * 1000) : null, // km → m
        type: 'sounding balloon',
        status: 'airborne',
        // The public feed only carries position + altitude; no telemetry is invented.
        speed: null,
        verticalRate: null,
        temperature: null,
        color: '#4FC3F7',
      }));

    return NextResponse.json({
      balloons,
      total: balloons.length,
      timestamp: new Date().toISOString(),
      source: 'WindBorne Systems constellation (live)',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('[elippser] Balloon feed error:', error);
    return NextResponse.json({ balloons: [], total: 0, error: 'Balloon feed unavailable' }, { status: 500 });
  }
}
