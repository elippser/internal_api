// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';

export const dynamic = 'force-dynamic';

/**
 * elippser — Live Radiation Monitoring (Safecast)
 * Crowdsourced radiation measurements from the Safecast sensor network.
 * Free API, no key. CPM readings are converted to nSv/h with the standard
 * Safecast LND-7317 pancake-tube factor (334 CPM ≈ 1 µSv/h).
 */

const CPM_PER_USVH = 334;

function statusFor(nSvH: number): string {
  if (nSvH >= 1000) return 'DANGER';   // >1 µSv/h sustained is well above background
  if (nSvH >= 300) return 'WARNING';
  return 'NORMAL';
}

export async function GET() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const res = await fetch(
      `https://api.safecast.org/measurements.json?unit=cpm&captured_after=${since}&per_page=200`,
      { signal: AbortSignal.timeout(15000), cache: 'no-store' }
    );
    if (!res.ok) {
      return NextResponse.json({ stations: [], total: 0, error: 'Safecast unavailable' });
    }

    const raw = await res.json();
    // Dedupe by ~1 km grid so a single bGeigie drive doesn't stack hundreds of points
    const seen = new Set<string>();
    const stations: any[] = [];

    for (const m of Array.isArray(raw) ? raw : []) {
      if (typeof m.latitude !== 'number' || typeof m.longitude !== 'number') continue;
      if (typeof m.value !== 'number' || m.value < 0) continue;
      const key = `${m.latitude.toFixed(2)},${m.longitude.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const nSvH = Math.round((m.value / CPM_PER_USVH) * 1000);
      stations.push({
        name: m.location_name || `Safecast sensor ${m.device_id || m.id}`,
        city: `${m.latitude.toFixed(3)}, ${m.longitude.toFixed(3)}`,
        country: m.captured_at ? m.captured_at.split('T')[0] : '—',
        lat: m.latitude,
        lng: m.longitude,
        reading: nSvH,
        cpm: m.value,
        status: statusFor(nSvH),
        network: 'Safecast (crowdsourced)',
      });
    }

    return NextResponse.json({
      stations,
      total: stations.length,
      timestamp: new Date().toISOString(),
      source: 'Safecast API (live, last 7 days)',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' },
    });
  } catch (error) {
    console.error('[elippser] Radiation feed error:', error);
    return NextResponse.json({ stations: [], total: 0, error: 'Radiation feed unavailable' }, { status: 500 });
  }
}
