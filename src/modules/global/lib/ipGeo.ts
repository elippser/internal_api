// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
/**
 * Shared IP geolocation via ip-api.com batch endpoint.
 * Free tier: 15 requests/min, up to 100 IPs per batch. Results are cached
 * in-memory so repeat lookups across routes don't burn the quota.
 */

export interface IpGeo {
  query: string;
  lat: number;
  lon: number;
  country: string;
  countryCode: string;
  city: string;
  isp: string;
  as?: string;
}

const cache = new Map<string, { geo: IpGeo | null; at: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h — server infrastructure moves slowly

export async function geolocateIPs(ips: string[]): Promise<Map<string, IpGeo>> {
  const out = new Map<string, IpGeo>();
  const now = Date.now();
  const missing: string[] = [];

  for (const ip of Array.from(new Set(ips))) {
    const hit = cache.get(ip);
    if (hit && now - hit.at < CACHE_TTL) {
      if (hit.geo) out.set(ip, hit.geo);
    } else {
      missing.push(ip);
    }
  }

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const res = await fetch(
        'http://ip-api.com/batch?fields=status,query,lat,lon,country,countryCode,city,isp,as',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) break;
      const rows = await res.json();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row.status === 'success' && typeof row.lat === 'number' && typeof row.lon === 'number') {
          const geo: IpGeo = {
            query: row.query, lat: row.lat, lon: row.lon,
            country: row.country || '', countryCode: row.countryCode || '',
            city: row.city || '', isp: row.isp || '', as: row.as || '',
          };
          cache.set(row.query, { geo, at: now });
          out.set(row.query, geo);
        } else if (row.query) {
          cache.set(row.query, { geo: null, at: now });
        }
      }
    } catch {
      break;
    }
  }
  return out;
}
