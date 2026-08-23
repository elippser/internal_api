// Config de corredores piloto del intelligence-hub.
// Decisión de negocio (spec §9): validar el pipeline con los corredores
// España→AR, Brasil→AR, Chile/Uruguay→AR y EEUU→AR antes de escalar a
// cobertura global. Todo lo que sigue es ampliable en runtime vía env o
// editando este archivo — los connectors no tienen geografía hardcodeada.

import { activeCities } from "./cities.catalog";
import { resolveOverpassUrls } from "./overpass";

export interface AirportInfo {
  iata: string;
  name: string;
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  tz: string;
}

// Catálogo mínimo de aeropuertos del piloto. AeroDataBox puede enriquecerlo
// (GET /airports/iata/{code}) pero estos datos alcanzan para operar sin key.
export const AIRPORT_CATALOG: AirportInfo[] = [
  // Receptores (Argentina)
  { iata: "EZE", name: "Ministro Pistarini (Ezeiza)", city: "Buenos Aires", countryCode: "AR", lat: -34.8222, lng: -58.5358, tz: "America/Argentina/Buenos_Aires" },
  { iata: "AEP", name: "Aeroparque Jorge Newbery", city: "Buenos Aires", countryCode: "AR", lat: -34.5592, lng: -58.4156, tz: "America/Argentina/Buenos_Aires" },
  { iata: "MDZ", name: "El Plumerillo", city: "Mendoza", countryCode: "AR", lat: -32.8317, lng: -68.7929, tz: "America/Argentina/Mendoza" },
  { iata: "BRC", name: "Teniente Candelaria", city: "Bariloche", countryCode: "AR", lat: -41.1512, lng: -71.1575, tz: "America/Argentina/Salta" },
  // Emisores piloto
  { iata: "MAD", name: "Adolfo Suárez Madrid-Barajas", city: "Madrid", countryCode: "ES", lat: 40.4936, lng: -3.5668, tz: "Europe/Madrid" },
  { iata: "BCN", name: "Josep Tarradellas Barcelona-El Prat", city: "Barcelona", countryCode: "ES", lat: 41.2971, lng: 2.0785, tz: "Europe/Madrid" },
  { iata: "GRU", name: "Guarulhos", city: "São Paulo", countryCode: "BR", lat: -23.4356, lng: -46.4731, tz: "America/Sao_Paulo" },
  { iata: "GIG", name: "Galeão", city: "Rio de Janeiro", countryCode: "BR", lat: -22.8099, lng: -43.2506, tz: "America/Sao_Paulo" },
  { iata: "SCL", name: "Arturo Merino Benítez", city: "Santiago", countryCode: "CL", lat: -33.3930, lng: -70.7858, tz: "America/Santiago" },
  { iata: "MVD", name: "Carrasco", city: "Montevideo", countryCode: "UY", lat: -34.8384, lng: -56.0308, tz: "America/Montevideo" },
  { iata: "MIA", name: "Miami International", city: "Miami", countryCode: "US", lat: 25.7959, lng: -80.2870, tz: "America/New_York" },
  { iata: "JFK", name: "John F. Kennedy", city: "New York", countryCode: "US", lat: 40.6413, lng: -73.7781, tz: "America/New_York" },
];

export const airportByIata = (iata: string): AirportInfo | undefined =>
  AIRPORT_CATALOG.find((a) => a.iata === iata.toUpperCase());

export interface FlightsConfig {
  // Aeropuertos cuyas llegadas se agregan como flight_volume. En el piloto,
  // los receptores AR (la señal es "capacidad aérea entrando al destino").
  watchedAirports: string[];
  // Pares con prioridad para estudios dirigidos (guardados en rawPayload).
  corridors: Array<{ origin: string; destination: string }>;
  windowDays: number;
}

export const FLIGHTS_CONFIG: FlightsConfig = {
  watchedAirports: ["EZE", "AEP", "MDZ", "BRC"],
  corridors: [
    { origin: "MAD", destination: "EZE" },
    { origin: "BCN", destination: "EZE" },
    { origin: "GRU", destination: "EZE" },
    { origin: "GRU", destination: "MDZ" },
    { origin: "GIG", destination: "EZE" },
    { origin: "SCL", destination: "MDZ" },
    { origin: "SCL", destination: "EZE" },
    { origin: "MVD", destination: "AEP" },
    { origin: "MIA", destination: "EZE" },
    { origin: "JFK", destination: "EZE" },
  ],
  windowDays: Number(process.env.IH_FLIGHTS_WINDOW_DAYS ?? 7),
};

export interface FxPair {
  base: string; // moneda del país emisor
  quote: string; // moneda del país receptor (donde está el hotel)
  quoteCountryCode: string;
}

export interface FxConfig {
  pairs: FxPair[];
  // Países con brecha cambiaria conocida: se suma la capa de mercado
  // paralelo (dolarapi) además del tipo oficial.
  marketsWithParallelRate: string[];
}

export const FX_CONFIG: FxConfig = {
  pairs: [
    { base: "EUR", quote: "ARS", quoteCountryCode: "AR" },
    { base: "BRL", quote: "ARS", quoteCountryCode: "AR" },
    { base: "CLP", quote: "ARS", quoteCountryCode: "AR" },
    { base: "UYU", quote: "ARS", quoteCountryCode: "AR" },
    { base: "USD", quote: "ARS", quoteCountryCode: "AR" },
  ],
  marketsWithParallelRate: ["AR"],
};

export interface HolidaysConfig {
  countryCodes: string[]; // emisores + receptor
  yearsAhead: number; // año actual + N
}

export const HOLIDAYS_CONFIG: HolidaysConfig = {
  countryCodes: ["AR", "ES", "BR", "CL", "UY", "US"],
  yearsAhead: 1,
};

export type DestinationProfile = "beach" | "ski" | "trekking" | "urban";

export interface WeatherDestination {
  label: string;
  lat: number;
  lng: number;
  countryCode: string;
  profile: DestinationProfile;
}

// El clima se monitorea sobre el mismo catálogo mundial que los eventos:
// cada ciudad turística activa es un destino, con su perfil climático
// (beach/ski/trekking/urban) definido en el catálogo. IH_CITIES lo acota
// igual que al barrido de eventos. Open-Meteo es gratis y sin key, y el
// connector agrupa las ciudades en pocas llamadas batch.
export const WEATHER_DESTINATIONS: WeatherDestination[] = activeCities().map((c) => ({
  label: c.label,
  lat: c.lat,
  lng: c.lng,
  countryCode: c.countryCode,
  profile: c.profile ?? "urban",
}));

export interface EventRegion {
  label: string;
  lat: number;
  lng: number;
  radiusKm: number;
  countryCode: string;
  // 'receiver' = destino hotelero; 'emitter' = mercado emisor cuyo calendario
  // de ferias/congresos genera viajeros de negocio hacia el receptor.
  role: "receiver" | "emitter";
}

export interface EventsConfig {
  regions: EventRegion[];
  windowDays: number; // eventos se planean con más anticipación que vuelos
  sources: Array<"ticketmaster" | "eventbrite" | "scraper">;
}

export const EVENTS_CONFIG: EventsConfig = {
  regions: [
    { label: "Buenos Aires", lat: -34.6037, lng: -58.3816, radiusKm: 50, countryCode: "AR", role: "receiver" },
    { label: "Mendoza", lat: -32.8895, lng: -68.8458, radiusKm: 50, countryCode: "AR", role: "receiver" },
    { label: "Madrid", lat: 40.4168, lng: -3.7038, radiusKm: 50, countryCode: "ES", role: "emitter" },
    { label: "São Paulo", lat: -23.5505, lng: -46.6333, radiusKm: 50, countryCode: "BR", role: "emitter" },
    { label: "Santiago", lat: -33.4489, lng: -70.6693, radiusKm: 50, countryCode: "CL", role: "emitter" },
  ],
  windowDays: Number(process.env.IH_EVENTS_WINDOW_DAYS ?? 90),
  sources: ["ticketmaster", "eventbrite", "scraper"],
};

// Peso por categoría de evento cuando el venue no publica capacidad
// (spec §3.1) — tabla configurable, no hardcodeada en el connector.
export const EVENT_SEGMENT_WEIGHTS: Record<string, number> = {
  music: 0.8,
  sports: 0.7,
  "arts & theatre": 0.4,
  film: 0.3,
  miscellaneous: 0.5,
  fair: 0.75, // ferias/congresos: alta ocupación de semana completa
  conference: 0.75,
  cruise: 0.75, // un barco = miles de personas con fecha exacta
  default: 0.5,
};

// ── Calendarios escolares (spec #8) ──
// OpenHolidays API cubre la mayor parte de Europa occidental (los emisores
// long-haul de mayor gasto). Países fuera de su cobertura devuelven [] y
// cuestan una llamada; la lista se ajusta por env sin deploy.
export interface SchoolHolidaysConfig {
  countryCodes: string[];
  monthsAhead: number;
}

export const SCHOOL_HOLIDAYS_CONFIG: SchoolHolidaysConfig = {
  countryCodes: (process.env.IH_SCHOOL_HOLIDAY_COUNTRIES ?? "DE,FR,ES,IT,NL,AT,CH,BE,PT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  monthsAhead: Number(process.env.IH_SCHOOL_HOLIDAY_MONTHS ?? 10),
};

// ── Fixtures deportivos (spec #9) ──
// TheSportsDB: la key "3" es la de desarrollo pública (rate limit bajo);
// para producción conviene la key propia vía IH_THESPORTSDB_KEY.
// Los IDs de liga salen de search_all_leagues.php; una liga con ID incorrecto
// devuelve vacío y se loggea en meta, nunca rompe la corrida.
export interface SportsLeague {
  id: string;
  label: string;
  // Multiplicador de demanda: un clásico de liga top llena la ciudad; una
  // liga secundaria mueve menos plazas.
  weight: number;
}

export interface SportsConfig {
  apiKey: string;
  leagues: SportsLeague[];
}

export const SPORTS_CONFIG: SportsConfig = {
  apiKey: process.env.IH_THESPORTSDB_KEY ?? "3",
  leagues: [
    { id: "4328", label: "English Premier League", weight: 1.0 },
    { id: "4335", label: "La Liga", weight: 1.0 },
    { id: "4332", label: "Serie A", weight: 0.95 },
    { id: "4331", label: "Bundesliga", weight: 0.95 },
    { id: "4334", label: "Ligue 1", weight: 0.9 },
    { id: "4480", label: "UEFA Champions League", weight: 1.0 },
    { id: "4351", label: "Brasileirão Série A", weight: 0.9 },
    { id: "4406", label: "Primera División Argentina", weight: 0.9 },
    { id: "4346", label: "MLS", weight: 0.8 },
    { id: "4387", label: "NBA", weight: 0.95 },
    { id: "4391", label: "NFL", weight: 1.0 },
    { id: "4424", label: "MLB", weight: 0.8 },
    { id: "4380", label: "NHL", weight: 0.8 },
    // LATAM (spec eventos del RMS: la cobertura tiene que servir en toda la región).
    { id: "4501", label: "Copa Libertadores", weight: 0.95 },
    { id: "4350", label: "Liga MX", weight: 0.9 },
    { id: "4627", label: "Chile Primera División", weight: 0.8 },
    { id: "4497", label: "Colombia Liga DIMAYOR", weight: 0.8 },
    { id: "4688", label: "Perú Primera División", weight: 0.75 },
    { id: "4432", label: "Uruguay Primera División", weight: 0.75 },
    { id: "4686", label: "Ecuador Serie A", weight: 0.7 },
    { id: "4687", label: "Paraguay Primera División", weight: 0.7 },
  ],
};

// ── Inventario de generadores de demanda (spec #10) ──
// Overpass/OSM por ciudad activa del catálogo. tier 1 por defecto: son las
// ciudades de mayor volumen y Overpass rate-limitea corridas largas; subir a
// tier 2 vía IH_VENUES_TIERS=1,2 cuando haya mirror propio de Overpass.
export interface VenueCategory {
  key: string;
  // Filtro Overpass tal cual se inyecta en la query nwr[...](around:…).
  filter: string;
  // Magnitud cuando el elemento no publica capacity.
  defaultMagnitude: number;
}

export interface VenuesConfig {
  // Endpoints Overpass en orden de preferencia, con failover por ciudad.
  // La instancia principal banea bursts (verificado 2026-08: 406 + corte de
  // conexión tras ~8 queries de 60 km); los mirrors absorben la corrida.
  overpassUrls: string[];
  categories: VenueCategory[];
  tiers: Array<1 | 2>;
  maxPerCity: number;
  // Radio máximo por query: un predio a >30 km del centro no llena hoteles
  // urbanos, y las queries de 60 km son las que disparan el antiabuso.
  maxRadiusKm: number;
  delayMs: number;
}

export const VENUES_CONFIG: VenuesConfig = {
  overpassUrls: resolveOverpassUrls(),
  categories: [
    { key: "stadium", filter: '["leisure"="stadium"]', defaultMagnitude: 0.8 },
    { key: "exhibition_centre", filter: '["amenity"="exhibition_centre"]', defaultMagnitude: 0.85 },
    { key: "conference_centre", filter: '["amenity"="conference_centre"]', defaultMagnitude: 0.7 },
    { key: "events_venue", filter: '["amenity"="events_venue"]', defaultMagnitude: 0.5 },
    { key: "theme_park", filter: '["tourism"="theme_park"]', defaultMagnitude: 0.7 },
    { key: "university", filter: '["amenity"="university"]', defaultMagnitude: 0.45 },
    { key: "winter_sports", filter: '["landuse"="winter_sports"]', defaultMagnitude: 0.6 },
  ],
  tiers: ((process.env.IH_VENUES_TIERS ?? "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n === 1 || n === 2)) as Array<1 | 2>,
  maxPerCity: Number(process.env.IH_VENUES_MAX_PER_CITY ?? 250),
  maxRadiusKm: Number(process.env.IH_VENUES_MAX_RADIUS_KM ?? 30),
  delayMs: Number(process.env.IH_VENUES_DELAY_MS ?? 5_000),
};

// ── Cruceros (spec #14) ──
// cruisetimetables.com publica calendario de arribos por puerto (HTML
// estático, 1 request) + página por fecha con los barcos. Un barco son
// 2-5k personas con fecha exacta; en homeports (embarque/desembarque)
// generan noches pre/post estadía — la señal hotelera fuerte.
export interface CruisePort {
  slug: string; // cruises-to-<slug>.html en cruisetimetables.com
  label: string;
  countryCode: string;
  lat: number; // terminal de cruceros, no el centro de la ciudad
  lng: number;
  role: "homeport" | "call";
}

export interface CruisesConfig {
  ports: CruisePort[];
  windowDays: number;
  // Con detail, se visita la página de cada fecha (barcos + conteo) — más
  // requests; sin detail, solo el calendario (1 request por puerto).
  detail: boolean;
  maxDetailPerPort: number;
}

export const CRUISES_CONFIG: CruisesConfig = {
  ports: [
    { slug: "cruises-to-buenos-aires-argentina", label: "Buenos Aires", countryCode: "AR", lat: -34.596, lng: -58.368, role: "homeport" },
    { slug: "cruises-to-ushuaia-argentina", label: "Ushuaia", countryCode: "AR", lat: -54.809, lng: -68.303, role: "homeport" },
    { slug: "cruises-to-puerto-madryn-argentina", label: "Puerto Madryn", countryCode: "AR", lat: -42.764, lng: -65.03, role: "call" },
    { slug: "cruises-to-montevideo-uruguay", label: "Montevideo", countryCode: "UY", lat: -34.901, lng: -56.212, role: "call" },
    { slug: "cruises-to-valparaiso-chile", label: "Valparaíso", countryCode: "CL", lat: -33.038, lng: -71.62, role: "homeport" },
    { slug: "cruises-to-rio-de-janeiro-brazil", label: "Río de Janeiro", countryCode: "BR", lat: -22.894, lng: -43.181, role: "call" },
    { slug: "cruises-to-barcelona-spain", label: "Barcelona", countryCode: "ES", lat: 41.362, lng: 2.183, role: "homeport" },
    { slug: "cruises-to-lisbon-portugal", label: "Lisboa", countryCode: "PT", lat: 38.712, lng: -9.122, role: "call" },
    { slug: "cruises-to-miami-florida", label: "Miami", countryCode: "US", lat: 25.778, lng: -80.177, role: "homeport" },
  ].filter((p) => {
    const only = (process.env.IH_CRUISES_PORTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return only.length === 0 || only.includes(p.label);
  }) as CruisePort[],
  windowDays: Number(process.env.IH_CRUISES_WINDOW_DAYS ?? 120),
  detail: process.env.IH_CRUISES_DETAIL !== "0",
  maxDetailPerPort: Number(process.env.IH_CRUISES_MAX_DETAIL ?? 40),
};

// ── Conciertos long-tail vía Bandsintown (spec #17) ──
// La API pública fue cerrada (2024+): requiere app_id registrado, así que el
// connector queda gated por IH_BANDSINTOWN_APP_ID y reporta degradado sin
// ella. Artist-centric: se sigue a los artistas de giras de estadio/arena —
// exactamente los shows que agotan los hoteles de una ciudad.
export interface BandsintownConfig {
  appId: string | null;
  artists: Array<{ name: string; weight: number }>;
}

const DEFAULT_ARTISTS: Array<{ name: string; weight: number }> = [
  { name: "Coldplay", weight: 1.0 },
  { name: "Taylor Swift", weight: 1.0 },
  { name: "Bad Bunny", weight: 1.0 },
  { name: "Karol G", weight: 0.95 },
  { name: "Shakira", weight: 0.95 },
  { name: "Bruno Mars", weight: 0.95 },
  { name: "The Weeknd", weight: 0.95 },
  { name: "Billie Eilish", weight: 0.9 },
  { name: "Dua Lipa", weight: 0.9 },
  { name: "Ed Sheeran", weight: 0.9 },
  { name: "Metallica", weight: 0.9 },
  { name: "AC/DC", weight: 0.9 },
  { name: "Paul McCartney", weight: 0.9 },
  { name: "Imagine Dragons", weight: 0.85 },
  { name: "Luis Miguel", weight: 0.9 },
  { name: "Daddy Yankee", weight: 0.85 },
  { name: "Rauw Alejandro", weight: 0.85 },
  { name: "Feid", weight: 0.85 },
  { name: "Duki", weight: 0.8 },
  { name: "Lali", weight: 0.75 },
  { name: "Los Fabulosos Cadillacs", weight: 0.75 },
  { name: "Green Day", weight: 0.85 },
  { name: "Linkin Park", weight: 0.9 },
  { name: "Oasis", weight: 0.95 },
];

export const BANDSINTOWN_CONFIG: BandsintownConfig = {
  appId: process.env.IH_BANDSINTOWN_APP_ID || null,
  artists: (() => {
    const raw = (process.env.IH_BANDSINTOWN_ARTISTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (raw.length === 0) return DEFAULT_ARTISTS;
    return raw.map((name) => ({ name, weight: 0.85 }));
  })(),
};

// ── Inventario de alojamiento (spec #32) ──
// El lado de la OFERTA: todo lo que compite por la misma noche, del resort
// de 500 habitaciones a la cabaña de 2 — vía OSM Overpass, mismo pipeline
// que venues. Base del compset (quién está a 300 m del hotel), de la
// densidad de oferta por zona y del futuro auto-revenue (un pico de demanda
// sobre 40 camas no se tarifa igual que sobre 4.000).
//
// El orden de este array ES la jerarquía de tamaño: de mayor a menor. La
// capa lo respeta al dibujar (radio) y al truncar por ciudad (sobreviven los
// grandes) para que "de lo más grande a lo más chico" sea literal en pantalla.
// tag/value en vez de un filtro crudo: permite agrupar todos los valores de
// una misma clave en UNA cláusula regex. Con 11 cláusulas sueltas, Overpass
// devolvía 504 sobre radios de 30 km (verificado 2026-08); agrupadas son 2
// consultas que el índice de `tourism` resuelve barato.
export interface LodgingCategory {
  key: string;
  tag: "tourism" | "leisure";
  // Magnitud cuando OSM no publica rooms/beds: el tamaño típico del tipo.
  defaultMagnitude: number;
  label: string;
}

export const LODGING_CATEGORIES: LodgingCategory[] = [
  { key: "resort", tag: "leisure", defaultMagnitude: 0.9, label: "Resort" },
  { key: "hotel", tag: "tourism", defaultMagnitude: 0.75, label: "Hotel" },
  { key: "motel", tag: "tourism", defaultMagnitude: 0.5, label: "Motel" },
  { key: "hostel", tag: "tourism", defaultMagnitude: 0.45, label: "Hostel" },
  { key: "camp_site", tag: "tourism", defaultMagnitude: 0.4, label: "Camping" },
  { key: "guest_house", tag: "tourism", defaultMagnitude: 0.35, label: "Guest house / B&B" },
  { key: "apartment", tag: "tourism", defaultMagnitude: 0.3, label: "Apart turístico" },
  { key: "caravan_site", tag: "tourism", defaultMagnitude: 0.3, label: "Caravanas" },
  { key: "chalet", tag: "tourism", defaultMagnitude: 0.25, label: "Cabaña / chalet" },
  { key: "alpine_hut", tag: "tourism", defaultMagnitude: 0.2, label: "Refugio de montaña" },
  { key: "wilderness_hut", tag: "tourism", defaultMagnitude: 0.15, label: "Refugio agreste" },
];

export interface LodgingConfig {
  overpassUrls: string[];
  categories: LodgingCategory[];
  tiers: Array<1 | 2>;
  // Alto a propósito: el pedido es inventariar TODO el alojamiento, no una
  // muestra. Si una ciudad lo supera, se loggea el recorte en meta.
  maxPerCity: number;
  maxRadiusKm: number;
  delayMs: number;
}

export const LODGING_CONFIG: LodgingConfig = {
  overpassUrls: resolveOverpassUrls(),
  categories: LODGING_CATEGORIES,
  tiers: ((process.env.IH_LODGING_TIERS ?? "1,2")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n === 1 || n === 2)) as Array<1 | 2>,
  maxPerCity: Number(process.env.IH_LODGING_MAX_PER_CITY ?? 1500),
  maxRadiusKm: Number(process.env.IH_LODGING_MAX_RADIUS_KM ?? 30),
  delayMs: Number(process.env.IH_LODGING_DELAY_MS ?? 5_000),
};

// ── Tarifas aéreas por corredor (spec #15) ──
// Amadeus Self-Service (key+secret gratis en developers.amadeus.com; el
// entorno test tiene data cacheada/limitada, production requiere aprobación
// simple). Sin keys el connector reporta degradado, como AeroDataBox.
// Semántica: la tarifa más barata HOY para volar en +14/+30/+60 días,
// comparada contra el rolling propio del corredor — cara = avión llenándose.
export interface FlightPricesConfig {
  apiKey: string | null;
  apiSecret: string | null;
  baseUrl: string;
  horizonsDays: number[];
  currency: string;
}

export const FLIGHT_PRICES_CONFIG: FlightPricesConfig = {
  apiKey: process.env.AMADEUS_API_KEY || null,
  apiSecret: process.env.AMADEUS_API_SECRET || null,
  baseUrl:
    (process.env.AMADEUS_ENV ?? "test") === "production"
      ? "https://api.amadeus.com"
      : "https://test.api.amadeus.com",
  horizonsDays: (process.env.IH_FLIGHT_PRICE_HORIZONS ?? "14,30,60")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  currency: process.env.IH_FLIGHT_PRICE_CURRENCY ?? "USD",
};

// ── Presión STR / Airbnb por barrio (spec #13) ──
// InsideAirbnb publica dumps trimestrales por ciudad (gratis, sin key). El
// slug es el segmento de ciudad en data.insideairbnb.com/<país>/<región>/
// <slug>/<fecha>/visualisations/listings.csv; la fecha del último snapshot
// se descubre scrapeando get-the-data. reviews_per_month es el proxy de
// ocupación estándar de la propia fuente.
export interface StrCity {
  slug: string;
  label: string;
  countryCode: string;
}

export interface StrConfig {
  cities: StrCity[];
  minListingsPerHood: number;
  windowDays: number; // vigencia del snapshot hasta el próximo trimestre
}

export const STR_CONFIG: StrConfig = {
  cities: [
    { slug: "buenos-aires", label: "Buenos Aires", countryCode: "AR" },
    { slug: "santiago", label: "Santiago", countryCode: "CL" },
    { slug: "rio-de-janeiro", label: "Río de Janeiro", countryCode: "BR" },
    { slug: "mexico-city", label: "Ciudad de México", countryCode: "MX" },
    { slug: "barcelona", label: "Barcelona", countryCode: "ES" },
    { slug: "madrid", label: "Madrid", countryCode: "ES" },
    { slug: "lisbon", label: "Lisboa", countryCode: "PT" },
    { slug: "paris", label: "París", countryCode: "FR" },
    { slug: "rome", label: "Roma", countryCode: "IT" },
    { slug: "amsterdam", label: "Ámsterdam", countryCode: "NL" },
    { slug: "berlin", label: "Berlín", countryCode: "DE" },
    { slug: "new-york-city", label: "Nueva York", countryCode: "US" },
  ].filter((c) => {
    const only = (process.env.IH_STR_CITIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return only.length === 0 || only.includes(c.label) || only.includes(c.slug);
  }),
  minListingsPerHood: Number(process.env.IH_STR_MIN_LISTINGS ?? 5),
  windowDays: Number(process.env.IH_STR_WINDOW_DAYS ?? 150),
};

// ── Alertas sanitarias WHO (spec #23) ──
// Disease Outbreak News vía la API JSON del sitio de WHO (gratis, sin key).
// Cancelador de demanda: pondera por severidad percibida del patógeno (lo
// que asusta al viajero, no la letalidad clínica).
export interface HealthConfig {
  windowDays: number; // vigencia de la alerta desde su publicación
  maxItems: number;
  severityByKeyword: Array<{ pattern: RegExp; weight: number }>;
  defaultSeverity: number;
}

export const HEALTH_CONFIG: HealthConfig = {
  windowDays: Number(process.env.IH_HEALTH_WINDOW_DAYS ?? 60),
  maxItems: Number(process.env.IH_HEALTH_MAX_ITEMS ?? 40),
  severityByKeyword: [
    { pattern: /ebola|marburg|mers|nipah|plague|anthrax|lassa/i, weight: 0.9 },
    { pattern: /cholera|yellow fever|measles|polio|diphtheria|hantavirus|rabies/i, weight: 0.7 },
    { pattern: /dengue|zika|chikungunya|influenza|mpox|monkeypox|oropouche/i, weight: 0.55 },
  ],
  defaultSeverity: 0.5,
};

// ── Feeds iCal genéricos (spec #11) ──
// Cualquier portal regional que publique agenda .ics entra por acá sin código:
// una entrada en este array o en IH_ICS_FEEDS (JSON) por env. lat/lng es la
// referencia urbana para eventos sin GEO propio.
export interface IcsFeed {
  label: string; // Signal.source = 'ih-scraper-ics-<label>'
  url: string;
  city: string;
  countryCode: string;
  lat: number;
  lng: number;
  spreadKm?: number;
  enabled?: boolean;
}

export const ICS_FEEDS: IcsFeed[] = [
  // Ejemplo (deshabilitado): agenda cultural municipal con feed iCal.
  // { label: "gijon-agenda", url: "https://www.gijon.es/es/eventos.ics",
  //   city: "Gijón", countryCode: "ES", lat: 43.5322, lng: -5.6611, spreadKm: 3, enabled: false },
];

export function activeIcsFeeds(): IcsFeed[] {
  const fromEnv = (() => {
    try {
      const raw = process.env.IH_ICS_FEEDS;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as IcsFeed[]) : [];
    } catch {
      console.error("[intelligence] IH_ICS_FEEDS no es JSON válido; se ignora");
      return [];
    }
  })();
  return [...ICS_FEEDS, ...fromEnv].filter((f) => f.enabled !== false && f.url && f.label);
}

export interface TrendsKeyword {
  keyword: string;
  geo: string; // país emisor donde se mide el interés de búsqueda
}

export interface TrendsConfig {
  keywords: TrendsKeyword[];
}

export const TRENDS_CONFIG: TrendsConfig = {
  keywords: [
    { keyword: "vuelos a argentina", geo: "ES" },
    { keyword: "hotel buenos aires", geo: "ES" },
    { keyword: "hotel mendoza", geo: "ES" },
    { keyword: "passagens argentina", geo: "BR" },
    { keyword: "hotel buenos aires", geo: "BR" },
    { keyword: "hotel bariloche", geo: "BR" },
    { keyword: "hotel mendoza", geo: "CL" },
    { keyword: "vuelos a buenos aires", geo: "CL" },
    { keyword: "hotel buenos aires", geo: "UY" },
    { keyword: "flights to argentina", geo: "US" },
    { keyword: "hotel buenos aires", geo: "US" },
  ],
};
