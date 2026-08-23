// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
import { NextResponse } from '../../runtime/next-shim';

export const dynamic = 'force-dynamic';

/**
 * elippser — Air Quality Monitoring API
 * Live PM2.5 from Open-Meteo Air Quality (CAMS model data).
 * FREE — no API key. The previous OpenAQ v2 integration silently returned
 * empty results after the v2 API was retired; this replaces it.
 * Coverage: a fixed grid of major world cities (real coordinates), with the
 * measurement itself fetched live per request.
 */

const CITIES: { name: string; country: string; lat: number; lng: number }[] = [
  { name: 'New York', country: 'US', lat: 40.713, lng: -74.006 },
  { name: 'Los Angeles', country: 'US', lat: 34.052, lng: -118.244 },
  { name: 'Chicago', country: 'US', lat: 41.878, lng: -87.630 },
  { name: 'Mexico City', country: 'MX', lat: 19.433, lng: -99.133 },
  { name: 'Toronto', country: 'CA', lat: 43.651, lng: -79.347 },
  { name: 'São Paulo', country: 'BR', lat: -23.551, lng: -46.633 },
  { name: 'Buenos Aires', country: 'AR', lat: -34.604, lng: -58.382 },
  { name: 'Bogotá', country: 'CO', lat: 4.711, lng: -74.072 },
  { name: 'Lima', country: 'PE', lat: -12.046, lng: -77.043 },
  { name: 'Santiago', country: 'CL', lat: -33.449, lng: -70.669 },
  { name: 'London', country: 'GB', lat: 51.507, lng: -0.128 },
  { name: 'Paris', country: 'FR', lat: 48.857, lng: 2.352 },
  { name: 'Madrid', country: 'ES', lat: 40.417, lng: -3.704 },
  { name: 'Berlin', country: 'DE', lat: 52.520, lng: 13.405 },
  { name: 'Rome', country: 'IT', lat: 41.903, lng: 12.496 },
  { name: 'Warsaw', country: 'PL', lat: 52.230, lng: 21.012 },
  { name: 'Kyiv', country: 'UA', lat: 50.450, lng: 30.523 },
  { name: 'Moscow', country: 'RU', lat: 55.756, lng: 37.617 },
  { name: 'Istanbul', country: 'TR', lat: 41.008, lng: 28.978 },
  { name: 'Athens', country: 'GR', lat: 37.984, lng: 23.728 },
  { name: 'Cairo', country: 'EG', lat: 30.044, lng: 31.236 },
  { name: 'Lagos', country: 'NG', lat: 6.524, lng: 3.379 },
  { name: 'Nairobi', country: 'KE', lat: -1.292, lng: 36.822 },
  { name: 'Johannesburg', country: 'ZA', lat: -26.204, lng: 28.047 },
  { name: 'Riyadh', country: 'SA', lat: 24.713, lng: 46.675 },
  { name: 'Dubai', country: 'AE', lat: 25.204, lng: 55.271 },
  { name: 'Tehran', country: 'IR', lat: 35.689, lng: 51.389 },
  { name: 'Karachi', country: 'PK', lat: 24.861, lng: 67.010 },
  { name: 'Delhi', country: 'IN', lat: 28.614, lng: 77.209 },
  { name: 'Mumbai', country: 'IN', lat: 19.076, lng: 72.878 },
  { name: 'Dhaka', country: 'BD', lat: 23.811, lng: 90.412 },
  { name: 'Bangkok', country: 'TH', lat: 13.756, lng: 100.502 },
  { name: 'Hanoi', country: 'VN', lat: 21.028, lng: 105.804 },
  { name: 'Jakarta', country: 'ID', lat: -6.209, lng: 106.846 },
  { name: 'Singapore', country: 'SG', lat: 1.352, lng: 103.820 },
  { name: 'Manila', country: 'PH', lat: 14.600, lng: 120.984 },
  { name: 'Hong Kong', country: 'HK', lat: 22.319, lng: 114.169 },
  { name: 'Shanghai', country: 'CN', lat: 31.230, lng: 121.474 },
  { name: 'Beijing', country: 'CN', lat: 39.904, lng: 116.407 },
  { name: 'Seoul', country: 'KR', lat: 37.567, lng: 126.978 },
  { name: 'Tokyo', country: 'JP', lat: 35.677, lng: 139.650 },
  { name: 'Sydney', country: 'AU', lat: -33.869, lng: 151.209 },
  { name: 'Melbourne', country: 'AU', lat: -37.814, lng: 144.963 },
  { name: 'Ulaanbaatar', country: 'MN', lat: 47.886, lng: 106.906 },
  { name: 'Almaty', country: 'KZ', lat: 43.222, lng: 76.851 },
  { name: 'Baghdad', country: 'IQ', lat: 33.315, lng: 44.366 },
  { name: 'Tel Aviv', country: 'IL', lat: 32.085, lng: 34.782 },
  { name: 'Casablanca', country: 'MA', lat: 33.573, lng: -7.590 },
];

function levelFor(pm25: number): { level: string; color: string } {
  if (pm25 > 150) return { level: 'Hazardous', color: '#8B0000' };
  if (pm25 > 100) return { level: 'Unhealthy', color: '#FF1744' };
  if (pm25 > 55) return { level: 'Unhealthy (Sensitive)', color: '#FF9500' };
  if (pm25 > 35) return { level: 'Moderate', color: '#FFD700' };
  return { level: 'Good', color: '#00E676' };
}

export async function GET() {
  try {
    const lats = CITIES.map(c => c.lat).join(',');
    const lngs = CITIES.map(c => c.lng).join(',');
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}&longitude=${lngs}&current=pm2_5,pm10,us_aqi`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      return NextResponse.json({ stations: [], total: 0, error: `Open-Meteo unavailable (${res.status})` });
    }

    const data = await res.json();
    const rows = Array.isArray(data) ? data : [data];

    const stations: any[] = [];
    rows.forEach((row: any, i: number) => {
      const city = CITIES[i];
      const pm25 = row?.current?.pm2_5;
      if (!city || typeof pm25 !== 'number') return;
      const { level, color } = levelFor(pm25);
      stations.push({
        id: `aq-${city.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: city.name,
        city: city.name,
        country: city.country,
        lat: city.lat,
        lng: city.lng,
        pm25,
        pm10: row.current.pm10 ?? null,
        us_aqi: row.current.us_aqi ?? null,
        unit: 'µg/m³',
        level,
        color,
        lastUpdated: row.current.time || null,
      });
    });

    return NextResponse.json({
      stations,
      total: stations.length,
      source: 'Open-Meteo Air Quality (CAMS)',
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' },
    });
  } catch (error) {
    console.error('Air Quality API error:', error);
    return NextResponse.json({ stations: [], error: 'Failed to fetch air quality data' }, { status: 500 });
  }
}
