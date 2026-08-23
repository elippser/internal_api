// Catálogo mundial de ciudades turísticas monitoreadas para eventos.
//
// Por qué existe: los corredores piloto (FLIGHTS_CONFIG/EVENTS_CONFIG.regions)
// definen el estudio dirigido emisor→receptor, pero limitar el barrido de
// eventos a esas 5 ciudades dejaba el mapa casi vacío. Los providers globales
// (Ticketmaster y sucesores) se consultan contra ESTE catálogo, que es amplio
// y barato: una ciudad sin cobertura del provider simplemente devuelve 0
// eventos y cuesta 1 llamada.
//
// tier 1 = mercados hoteleros de alto volumen (se pagan más páginas de
// resultados). tier 2 = destinos secundarios, 1-2 páginas alcanzan.
//
// profile = perfil climático del destino para el connector weather (spec §6):
// determina la fórmula de favorabilidad (un día de 30°C es ideal en playa y
// malo para esquí). Sin profile ⇒ "urban".

export type CityProfile = "beach" | "ski" | "trekking" | "urban";

export interface TouristCity {
  label: string;
  countryCode: string;
  lat: number;
  lng: number;
  radiusKm: number;
  tier: 1 | 2;
  profile?: CityProfile;
}

export const TOURIST_CITIES: TouristCity[] = [
  // ── Europa ──
  { label: "Madrid", countryCode: "ES", lat: 40.4168, lng: -3.7038, radiusKm: 60, tier: 1 },
  { label: "Barcelona", countryCode: "ES", lat: 41.3874, lng: 2.1686, radiusKm: 60, tier: 1 },
  { label: "Palma de Mallorca", countryCode: "ES", lat: 39.5696, lng: 2.6502, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Sevilla", countryCode: "ES", lat: 37.3891, lng: -5.9845, radiusKm: 50, tier: 2 },
  { label: "Valencia", countryCode: "ES", lat: 39.4699, lng: -0.3763, radiusKm: 50, tier: 2 },
  { label: "Málaga", countryCode: "ES", lat: 36.7213, lng: -4.4214, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "París", countryCode: "FR", lat: 48.8566, lng: 2.3522, radiusKm: 60, tier: 1 },
  { label: "Niza", countryCode: "FR", lat: 43.7102, lng: 7.262, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Lyon", countryCode: "FR", lat: 45.764, lng: 4.8357, radiusKm: 50, tier: 2 },
  { label: "Marsella", countryCode: "FR", lat: 43.2965, lng: 5.3698, radiusKm: 50, tier: 2 },
  { label: "Londres", countryCode: "GB", lat: 51.5074, lng: -0.1278, radiusKm: 60, tier: 1 },
  { label: "Mánchester", countryCode: "GB", lat: 53.4808, lng: -2.2426, radiusKm: 50, tier: 2 },
  { label: "Edimburgo", countryCode: "GB", lat: 55.9533, lng: -3.1883, radiusKm: 50, tier: 2 },
  { label: "Dublín", countryCode: "IE", lat: 53.3498, lng: -6.2603, radiusKm: 50, tier: 2 },
  { label: "Roma", countryCode: "IT", lat: 41.9028, lng: 12.4964, radiusKm: 60, tier: 1 },
  { label: "Milán", countryCode: "IT", lat: 45.4642, lng: 9.19, radiusKm: 60, tier: 1 },
  { label: "Venecia", countryCode: "IT", lat: 45.4408, lng: 12.3155, radiusKm: 50, tier: 2 },
  { label: "Florencia", countryCode: "IT", lat: 43.7696, lng: 11.2558, radiusKm: 50, tier: 2 },
  { label: "Nápoles", countryCode: "IT", lat: 40.8518, lng: 14.2681, radiusKm: 50, tier: 2 },
  { label: "Berlín", countryCode: "DE", lat: 52.52, lng: 13.405, radiusKm: 60, tier: 1 },
  { label: "Múnich", countryCode: "DE", lat: 48.1351, lng: 11.582, radiusKm: 50, tier: 1 },
  { label: "Fráncfort", countryCode: "DE", lat: 50.1109, lng: 8.6821, radiusKm: 50, tier: 2 },
  { label: "Hamburgo", countryCode: "DE", lat: 53.5511, lng: 9.9937, radiusKm: 50, tier: 2 },
  { label: "Colonia", countryCode: "DE", lat: 50.9375, lng: 6.9603, radiusKm: 50, tier: 2 },
  { label: "Ámsterdam", countryCode: "NL", lat: 52.3676, lng: 4.9041, radiusKm: 50, tier: 1 },
  { label: "Bruselas", countryCode: "BE", lat: 50.8503, lng: 4.3517, radiusKm: 50, tier: 2 },
  { label: "Viena", countryCode: "AT", lat: 48.2082, lng: 16.3738, radiusKm: 50, tier: 2 },
  { label: "Zúrich", countryCode: "CH", lat: 47.3769, lng: 8.5417, radiusKm: 50, tier: 2 },
  { label: "Ginebra", countryCode: "CH", lat: 46.2044, lng: 6.1432, radiusKm: 50, tier: 2 },
  { label: "Praga", countryCode: "CZ", lat: 50.0755, lng: 14.4378, radiusKm: 50, tier: 2 },
  { label: "Lisboa", countryCode: "PT", lat: 38.7223, lng: -9.1393, radiusKm: 50, tier: 1 },
  { label: "Oporto", countryCode: "PT", lat: 41.1579, lng: -8.6291, radiusKm: 50, tier: 2 },
  { label: "Atenas", countryCode: "GR", lat: 37.9838, lng: 23.7275, radiusKm: 50, tier: 2 },
  { label: "Estambul", countryCode: "TR", lat: 41.0082, lng: 28.9784, radiusKm: 60, tier: 2 },
  { label: "Copenhague", countryCode: "DK", lat: 55.6761, lng: 12.5683, radiusKm: 50, tier: 2 },
  { label: "Estocolmo", countryCode: "SE", lat: 59.3293, lng: 18.0686, radiusKm: 50, tier: 2 },
  { label: "Oslo", countryCode: "NO", lat: 59.9139, lng: 10.7522, radiusKm: 50, tier: 2 },
  { label: "Helsinki", countryCode: "FI", lat: 60.1699, lng: 24.9384, radiusKm: 50, tier: 2 },
  { label: "Varsovia", countryCode: "PL", lat: 52.2297, lng: 21.0122, radiusKm: 50, tier: 2 },
  { label: "Cracovia", countryCode: "PL", lat: 50.0647, lng: 19.945, radiusKm: 50, tier: 2 },
  { label: "Budapest", countryCode: "HU", lat: 47.4979, lng: 19.0402, radiusKm: 50, tier: 2 },
  { label: "Dubrovnik", countryCode: "HR", lat: 42.6507, lng: 18.0944, radiusKm: 40, tier: 2, profile: "beach" },
  { label: "Reikiavik", countryCode: "IS", lat: 64.1466, lng: -21.9426, radiusKm: 50, tier: 2, profile: "trekking" },

  // ── Norteamérica ──
  { label: "Nueva York", countryCode: "US", lat: 40.7128, lng: -74.006, radiusKm: 60, tier: 1 },
  { label: "Miami", countryCode: "US", lat: 25.7617, lng: -80.1918, radiusKm: 60, tier: 1, profile: "beach" },
  { label: "Orlando", countryCode: "US", lat: 28.5383, lng: -81.3792, radiusKm: 60, tier: 1 },
  { label: "Las Vegas", countryCode: "US", lat: 36.1699, lng: -115.1398, radiusKm: 50, tier: 1 },
  { label: "Los Ángeles", countryCode: "US", lat: 34.0522, lng: -118.2437, radiusKm: 60, tier: 1 },
  { label: "San Francisco", countryCode: "US", lat: 37.7749, lng: -122.4194, radiusKm: 50, tier: 1 },
  { label: "Chicago", countryCode: "US", lat: 41.8781, lng: -87.6298, radiusKm: 60, tier: 1 },
  { label: "Nueva Orleans", countryCode: "US", lat: 29.9511, lng: -90.0715, radiusKm: 50, tier: 2 },
  { label: "Boston", countryCode: "US", lat: 42.3601, lng: -71.0589, radiusKm: 50, tier: 2 },
  { label: "Washington DC", countryCode: "US", lat: 38.9072, lng: -77.0369, radiusKm: 50, tier: 2 },
  { label: "Honolulu", countryCode: "US", lat: 21.3069, lng: -157.8583, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "San Diego", countryCode: "US", lat: 32.7157, lng: -117.1611, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Toronto", countryCode: "CA", lat: 43.6532, lng: -79.3832, radiusKm: 60, tier: 1 },
  { label: "Montreal", countryCode: "CA", lat: 45.5017, lng: -73.5673, radiusKm: 50, tier: 2 },
  { label: "Vancouver", countryCode: "CA", lat: 49.2827, lng: -123.1207, radiusKm: 50, tier: 2 },
  { label: "Ciudad de México", countryCode: "MX", lat: 19.4326, lng: -99.1332, radiusKm: 60, tier: 1 },
  { label: "Cancún", countryCode: "MX", lat: 21.1619, lng: -86.8515, radiusKm: 50, tier: 1, profile: "beach" },
  { label: "Guadalajara", countryCode: "MX", lat: 20.6597, lng: -103.3496, radiusKm: 50, tier: 2 },

  // ── Latinoamérica (incluye los corredores piloto) ──
  { label: "São Paulo", countryCode: "BR", lat: -23.5505, lng: -46.6333, radiusKm: 60, tier: 1 },
  { label: "Río de Janeiro", countryCode: "BR", lat: -22.9068, lng: -43.1729, radiusKm: 60, tier: 1, profile: "beach" },
  { label: "Salvador", countryCode: "BR", lat: -12.9777, lng: -38.5016, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Buenos Aires", countryCode: "AR", lat: -34.6037, lng: -58.3816, radiusKm: 60, tier: 1 },
  { label: "Mendoza", countryCode: "AR", lat: -32.8895, lng: -68.8458, radiusKm: 50, tier: 1, profile: "trekking" },
  { label: "Bariloche", countryCode: "AR", lat: -41.1335, lng: -71.3103, radiusKm: 50, tier: 1, profile: "ski" },
  { label: "Córdoba", countryCode: "AR", lat: -31.4201, lng: -64.1888, radiusKm: 50, tier: 2 },
  { label: "Santiago", countryCode: "CL", lat: -33.4489, lng: -70.6693, radiusKm: 60, tier: 1 },
  { label: "Montevideo", countryCode: "UY", lat: -34.9011, lng: -56.1645, radiusKm: 50, tier: 1 },
  { label: "Punta del Este", countryCode: "UY", lat: -34.9633, lng: -54.9433, radiusKm: 40, tier: 2, profile: "beach" },
  { label: "Lima", countryCode: "PE", lat: -12.0464, lng: -77.0428, radiusKm: 50, tier: 2 },
  { label: "Cusco", countryCode: "PE", lat: -13.5319, lng: -71.9675, radiusKm: 40, tier: 2, profile: "trekking" },
  { label: "Bogotá", countryCode: "CO", lat: 4.711, lng: -74.0721, radiusKm: 50, tier: 2 },
  { label: "Cartagena", countryCode: "CO", lat: 10.391, lng: -75.4794, radiusKm: 40, tier: 2, profile: "beach" },
  { label: "Medellín", countryCode: "CO", lat: 6.2442, lng: -75.5812, radiusKm: 50, tier: 2 },
  { label: "Ciudad de Panamá", countryCode: "PA", lat: 8.9824, lng: -79.5199, radiusKm: 50, tier: 2 },
  { label: "San José", countryCode: "CR", lat: 9.9281, lng: -84.0907, radiusKm: 50, tier: 2 },
  { label: "Punta Cana", countryCode: "DO", lat: 18.5601, lng: -68.3725, radiusKm: 40, tier: 2, profile: "beach" },

  // ── Asia-Pacífico ──
  { label: "Tokio", countryCode: "JP", lat: 35.6762, lng: 139.6503, radiusKm: 60, tier: 1 },
  { label: "Osaka", countryCode: "JP", lat: 34.6937, lng: 135.5023, radiusKm: 50, tier: 2 },
  { label: "Kioto", countryCode: "JP", lat: 35.0116, lng: 135.7681, radiusKm: 40, tier: 2 },
  { label: "Seúl", countryCode: "KR", lat: 37.5665, lng: 126.978, radiusKm: 60, tier: 2 },
  { label: "Hong Kong", countryCode: "HK", lat: 22.3193, lng: 114.1694, radiusKm: 40, tier: 2 },
  { label: "Singapur", countryCode: "SG", lat: 1.3521, lng: 103.8198, radiusKm: 40, tier: 1 },
  { label: "Bangkok", countryCode: "TH", lat: 13.7563, lng: 100.5018, radiusKm: 60, tier: 1 },
  { label: "Phuket", countryCode: "TH", lat: 7.8804, lng: 98.3923, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Kuala Lumpur", countryCode: "MY", lat: 3.139, lng: 101.6869, radiusKm: 50, tier: 2 },
  { label: "Bali", countryCode: "ID", lat: -8.6705, lng: 115.2126, radiusKm: 60, tier: 1, profile: "beach" },
  { label: "Yakarta", countryCode: "ID", lat: -6.2088, lng: 106.8456, radiusKm: 50, tier: 2 },
  { label: "Ho Chi Minh", countryCode: "VN", lat: 10.8231, lng: 106.6297, radiusKm: 50, tier: 2 },
  { label: "Hanói", countryCode: "VN", lat: 21.0285, lng: 105.8542, radiusKm: 50, tier: 2 },
  { label: "Manila", countryCode: "PH", lat: 14.5995, lng: 120.9842, radiusKm: 50, tier: 2 },
  { label: "Delhi", countryCode: "IN", lat: 28.6139, lng: 77.209, radiusKm: 60, tier: 2 },
  { label: "Bombay", countryCode: "IN", lat: 19.076, lng: 72.8777, radiusKm: 60, tier: 2 },
  { label: "Goa", countryCode: "IN", lat: 15.2993, lng: 74.124, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Sídney", countryCode: "AU", lat: -33.8688, lng: 151.2093, radiusKm: 60, tier: 1 },
  { label: "Melbourne", countryCode: "AU", lat: -37.8136, lng: 144.9631, radiusKm: 60, tier: 1 },
  { label: "Brisbane", countryCode: "AU", lat: -27.4698, lng: 153.0251, radiusKm: 50, tier: 2 },
  { label: "Auckland", countryCode: "NZ", lat: -36.8485, lng: 174.7633, radiusKm: 50, tier: 2 },

  // ── Medio Oriente y África ──
  { label: "Dubái", countryCode: "AE", lat: 25.2048, lng: 55.2708, radiusKm: 60, tier: 1 },
  { label: "Abu Dabi", countryCode: "AE", lat: 24.4539, lng: 54.3773, radiusKm: 50, tier: 2 },
  { label: "Doha", countryCode: "QA", lat: 25.2854, lng: 51.531, radiusKm: 40, tier: 2 },
  { label: "Tel Aviv", countryCode: "IL", lat: 32.0853, lng: 34.7818, radiusKm: 40, tier: 2, profile: "beach" },
  { label: "Ciudad del Cabo", countryCode: "ZA", lat: -33.9249, lng: 18.4241, radiusKm: 50, tier: 2, profile: "beach" },
  { label: "Johannesburgo", countryCode: "ZA", lat: -26.2041, lng: 28.0473, radiusKm: 50, tier: 2 },
  { label: "Marrakech", countryCode: "MA", lat: 31.6295, lng: -7.9811, radiusKm: 40, tier: 2 },
  { label: "El Cairo", countryCode: "EG", lat: 30.0444, lng: 31.2357, radiusKm: 50, tier: 2 },
];

export const citiesByCountry = (countryCode: string): TouristCity[] =>
  TOURIST_CITIES.filter((c) => c.countryCode === countryCode.toUpperCase());

// Subconjunto activo: IH_CITIES limita el barrido a ciudades concretas
// (ej. "Madrid,Buenos Aires") para bajar consumo en dev o en un estudio
// dirigido; vacío = catálogo completo.
export function activeCities(): TouristCity[] {
  const only = (process.env.IH_CITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (only.length === 0) return TOURIST_CITIES;
  return TOURIST_CITIES.filter((c) => only.includes(c.label));
}

// ── Puntos de barrido (watchpoints) ──
//
// El catálogo cubre destinos turísticos genéricos; los hoteles de la
// plataforma están donde están (Tucumán, Chillán, Ibagué…). El RMS registra la
// ubicación de cada property como "punto de barrido" (`ih_watchpoints`, ver
// intelligence.service) y los conectores geolocalizados (Ticketmaster,
// Meetup, TheSportsDB) barren también alrededor de esos puntos: la cobertura
// pasa a ser property-driven en vez de depender de una lista fija de ciudades.
//
// El orquestador carga los puntos de Mongo antes de cada corrida y los inyecta
// acá (`setSweepPoints`); los conectores no tocan la base.

export interface SweepPoint extends TouristCity {
  pointId: string;
  isWatchpoint: true;
}

let extraSweepPoints: SweepPoint[] = [];
let sweepScope: "all" | "pointsOnly" = "all";

/** Inyecta los puntos activos. `onlyPoints` = barrido dirigido (sin catálogo). */
export function setSweepPoints(points: SweepPoint[], onlyPoints = false): void {
  extraSweepPoints = points;
  sweepScope = onlyPoints ? "pointsOnly" : "all";
}

export function getSweepPoints(): SweepPoint[] {
  return extraSweepPoints;
}

/** true durante un barrido dirigido (solo puntos, sin catálogo). */
export function isPointsOnlySweep(): boolean {
  return sweepScope === "pointsOnly";
}

function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Un punto a menos de esto de una ciudad del catálogo ya está cubierto por ella. */
const COVERED_BY_CATALOG_KM = 30;
/** Dos puntos más cerca que esto (dos hoteles en la misma ciudad) se barren una vez. */
const POINT_DEDUPE_KM = 10;

/**
 * Ciudades/puntos a barrer en esta corrida: catálogo activo + puntos de
 * barrido que no estén ya cubiertos por una ciudad del catálogo, deduplicados
 * entre sí. En modo dirigido (`pointsOnly`) solo los puntos.
 */
export function sweepCities(): TouristCity[] {
  const base = sweepScope === "pointsOnly" ? [] : activeCities();
  const out: TouristCity[] = [...base];
  for (const p of extraSweepPoints) {
    if (sweepScope !== "pointsOnly" && base.some((c) => distKm(c, p) <= COVERED_BY_CATALOG_KM)) continue;
    if (out.some((c) => (c as SweepPoint).isWatchpoint && distKm(c, p) <= POINT_DEDUPE_KM)) continue;
    out.push(p);
  }
  return out;
}

/** Catálogo completo + puntos (para índices por nombre de ciudad, ej. deportes). */
export function catalogWithSweepPoints(): TouristCity[] {
  return [...TOURIST_CITIES, ...extraSweepPoints];
}
