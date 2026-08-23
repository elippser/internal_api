// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';
import { fetchIntelligence, isConfigured } from '../../lib/intelligence';

/**
 * elippser — Hotel/Demand Intelligence proxy
 *
 * Source: internal-laupser intelligence-hub API (flights, events, FX,
 * holidays, weather, search trends normalized as demand signals).
 * Needs INTELLIGENCE_API_URL (+ INTELLIGENCE_API_SECRET) in .env — without
 * them this route returns 503 and the HOTEL INTEL layer toggles stay hidden.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Capability probe — never touches upstream, always 200.
  if (searchParams.get('probe') === '1') {
    return NextResponse.json({ configured: isConfigured(), source: 'Intelligence Hub' });
  }

  if (!isConfigured()) {
    return NextResponse.json(
      {
        events: [], airports: [], weather: [], origins: [], venues: [], str: [], lodging: [],
        error: 'Intelligence hub not configured',
        hint: 'Set INTELLIGENCE_API_URL (and INTELLIGENCE_API_SECRET) in .env — see .env.example',
      },
      { status: 503 },
    );
  }

  try {
    const result = await fetchIntelligence();
    return NextResponse.json(
      {
        ...result,
        total_events: result.events.length,
        total_airports: result.airports.length,
        total_venues: result.venues.length,
        total_str: result.str.length,
        total_lodging: result.lodging.length,
        source: 'Intelligence Hub',
        timestamp: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err) {
    console.error('[elippser] intelligence fetch failed:', err);
    return NextResponse.json(
      {
        events: [], airports: [], weather: [], origins: [], venues: [], str: [], lodging: [],
        error: err instanceof Error ? err.message : 'Intelligence hub unreachable',
      },
      { status: 502 },
    );
  }
}
