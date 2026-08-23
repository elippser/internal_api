// Cliente Overpass compartido (venues + lodging).
//
// Aprendido en producción (2026-08): la instancia principal responde 406 al
// fetch de Node con headers por defecto y, tras un burst de queries grandes,
// corta la conexión a nivel TLS (curl seguía entrando, Node no). De ahí las
// tres defensas de este módulo:
//   1. User-Agent identificable — Overpass pide etiquetar al cliente.
//   2. Failover entre instancias con move-to-front del que responde.
//   3. El caller espacia las queries y acota el radio (ver *_CONFIG.delayMs).

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

export const OVERPASS_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
  "user-agent": "laupser-intelligence-hub/1.0 (radar hotelero interno; contacto: ops@laupser)",
};

export const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export function resolveOverpassUrls(): string[] {
  return (
    process.env.IH_OVERPASS_URLS ??
    process.env.IH_OVERPASS_URL ??
    DEFAULT_OVERPASS_URLS.join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// POST con failover: 429/5xx o corte de conexión pasan al siguiente mirror.
// Devuelve también el endpoint que respondió para que el caller lo promueva.
export async function overpassQuery(
  endpoints: string[],
  query: string,
  timeoutMs = 180_000,
): Promise<{ data: OverpassResponse; endpoint: string }> {
  // Se acumulan TODOS los fallos: con solo el último, un 429 en el primer
  // mirror quedaba invisible detrás del 504 del tercero y el diagnóstico
  // apuntaba al endpoint equivocado.
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    const host = new URL(endpoint).host;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 429 (cuota) y 504 (query cara para ese mirror) son reintentables en
      // otra instancia; el resto también, pero se registran igual.
      if (!res.ok) {
        failures.push(`${host}: HTTP ${res.status}`);
        continue;
      }
      return { data: (await res.json()) as OverpassResponse, endpoint };
    } catch (err) {
      failures.push(`${host}: ${(err as Error).message}`);
    }
  }
  throw new Error(failures.join(" | "));
}

// Mueve al frente el endpoint que respondió: la ciudad siguiente arranca por
// el que está sano en vez de reintentar el caído.
export function promoteEndpoint(endpoints: string[], endpoint: string): void {
  const idx = endpoints.indexOf(endpoint);
  if (idx > 0) {
    endpoints.splice(idx, 1);
    endpoints.unshift(endpoint);
  }
}

export async function overpassHealthCheck(
  endpoints: string[],
): Promise<{ ok: boolean; detail: string }> {
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body: `data=${encodeURIComponent("[out:json];out count;")}`,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, detail: `overpass OK vía ${new URL(endpoint).host} (sin key)` };
      failures.push(`${new URL(endpoint).host}: HTTP ${res.status}`);
    } catch (err) {
      failures.push(`${new URL(endpoint).host}: ${(err as Error).message}`);
    }
  }
  return { ok: false, detail: `todos los endpoints overpass fallan — ${failures.join("; ")}` };
}

export const coordsOf = (el: OverpassElement): { lat: number; lng: number } | null => {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
};

export const nameOf = (tags: Record<string, string>): string | null =>
  tags.name ?? tags["name:en"] ?? tags["name:es"] ?? null;
