// @ts-nocheck
/* Portado desde elippser-gl — no editar a mano, ver tools/port-elippser/port-backend.js */
/**
 * elippser — Hotel/Demand Intelligence
 *
 * Client for the internal-laupser intelligence-hub API (lh-conectors-spec.md):
 * demand signals for hospitality — scheduled flight capacity, events, FX
 * attractiveness, public holidays, weather favorability and search trends,
 * normalized into layer-ready arrays for the map.
 *
 * Env: INTELLIGENCE_API_URL (e.g. http://localhost:8600) and
 * INTELLIGENCE_API_SECRET (must equal PMS_INTERNAL_SECRET on the API side).
 * Server-side only — the secret never reaches the browser.
 */

import { centroidFor } from './countryCentroids';

interface RawSignal {
  signalId: string;
  type: string;
  source: string;
  scope: { geo?: { lat?: number; lng?: number; airportCode?: string; countryCode?: string; city?: string }; radiusKm?: number };
  timeWindow: { start: string; end: string };
  magnitude: number;
  confidence: number;
  rawPayload: Record<string, any>;
}

interface RawSummary {
  fx: RawSignal[];
  holidays: RawSignal[];
  events: RawSignal[];
  weather: RawSignal[];
  flights: RawSignal[];
  trends: RawSignal[];
  schoolHolidays?: RawSignal[];
  venues?: RawSignal[];
  flightPrices?: RawSignal[];
  strSupply?: RawSignal[];
  healthAlerts?: RawSignal[];
  lodging?: RawSignal[];
  config?: Record<string, any>;
  generatedAt: string;
}

export interface IntelEvent {
  lat: number; lng: number;
  name: string; venue: string | null;
  start: string; end: string;
  source: string; magnitude: number; confidence: number;
  url: string | null; city: string | null; country: string | null;
  segment: string | null;
}

export interface IntelAirport {
  lat: number; lng: number;
  airport: string; city: string | null; country: string | null;
  days: Array<{ day: string; flightCount: number; magnitude: number; confidence: number }>;
  totalFlights: number;
  corridors: Array<{ origin: string; destination: string; flights: number }>;
  byOriginCountry: Record<string, number>;
  // Amadeus: tarifa más barata hoy por corredor entrante y horizonte,
  // comparada con el rolling de 90 días del corredor.
  fares: Array<{ origin: string; departureDate: string; horizonDays: number; price: number; currency: string; magnitude: number; vsAvgPct: number | null }>;
}

export interface IntelWeather {
  lat: number; lng: number;
  destination: string; profile: string; country: string | null;
  days: Array<{ day: string; tMax: number | null; tMin: number | null; precipitationMm: number | null; weatherCode: number | null; windMaxKmh: number | null; magnitude: number; confidence: number }>;
  avgFavorability7d: number;
}

export interface IntelOrigin {
  lat: number; lng: number;
  countryCode: string;
  fx: Array<{ base: string; quote: string; rate: number; officialRate: number | null; parallelRate: number | null; magnitude: number }>;
  trends: Array<{ keyword: string; value: number; weekStart: string }>;
  holidays: Array<{ date: string; name: string; global: boolean }>;
  schoolHolidays: Array<{ start: string; end: string; name: string; nationwide: boolean }>;
  healthAlerts: Array<{ date: string; title: string; url: string | null; magnitude: number }>;
}

export interface IntelVenue {
  lat: number; lng: number;
  name: string; category: string;
  capacity: number | null;
  city: string | null; country: string | null;
  magnitude: number;
  url: string | null;
}

export interface IntelStr {
  lat: number; lng: number;
  city: string | null; country: string | null;
  neighbourhood: string;
  listings: number;
  medianPriceLocal: number | null;
  occupancyProxy: number; // avg reviews/mes (proxy estándar InsideAirbnb)
  availability365: number | null;
  entireHomeShare: number | null;
  magnitude: number;
  snapshotDate: string | null;
}

export interface IntelLodging {
  lat: number; lng: number;
  name: string;
  category: string;
  sizeClass: string;
  rooms: number | null;
  beds: number | null;
  units: number | null;
  stars: number | null;
  brand: string | null;
  city: string | null; country: string | null;
  magnitude: number;
  url: string | null;
}

export interface IntelligenceResult {
  events: IntelEvent[];
  airports: IntelAirport[];
  weather: IntelWeather[];
  origins: IntelOrigin[];
  venues: IntelVenue[];
  str: IntelStr[];
  lodging: IntelLodging[];
  generatedAt: string;
}

// Pilot corridor emitters: currency → emitter country whose centroid anchors
// the FX signal on the map. EUR is multi-country; the pilot emitter is Spain.
const CURRENCY_COUNTRY: Record<string, string> = {
  EUR: 'ES', BRL: 'BR', CLP: 'CL', UYU: 'UY', USD: 'US',
};

export function isConfigured(): boolean {
  return Boolean(process.env.INTELLIGENCE_API_URL);
}

export async function fetchIntelligence(): Promise<IntelligenceResult> {
  const base = process.env.INTELLIGENCE_API_URL;
  if (!base) throw new Error('INTELLIGENCE_API_URL not configured');

  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/intelligence/summary`, {
    headers: {
      accept: 'application/json',
      ...(process.env.INTELLIGENCE_API_SECRET
        ? { 'x-internal-secret': process.env.INTELLIGENCE_API_SECRET }
        : {}),
    },
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`intelligence API ${res.status}`);
  const summary = (await res.json()) as RawSummary;

  return {
    events: transformEvents(summary.events ?? []),
    airports: transformFlights(summary.flights ?? [], summary.flightPrices ?? []),
    weather: transformWeather(summary.weather ?? []),
    origins: transformOrigins(
      summary.fx ?? [],
      summary.trends ?? [],
      summary.holidays ?? [],
      summary.schoolHolidays ?? [],
      summary.healthAlerts ?? [],
    ),
    venues: transformVenues(summary.venues ?? []),
    str: transformStr(summary.strSupply ?? []),
    lodging: transformLodging(summary.lodging ?? []),
    generatedAt: summary.generatedAt,
  };
}

function transformLodging(signals: RawSignal[]): IntelLodging[] {
  const out: IntelLodging[] = [];
  for (const s of signals) {
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const num = (v: unknown) => (v != null ? Number(v) : null);
    out.push({
      lat, lng,
      name: String(s.rawPayload.name ?? 'Unnamed lodging'),
      category: String(s.rawPayload.category ?? 'hotel'),
      sizeClass: String(s.rawPayload.sizeClass ?? 'unknown'),
      rooms: num(s.rawPayload.rooms),
      beds: num(s.rawPayload.beds),
      units: num(s.rawPayload.units),
      stars: num(s.rawPayload.stars),
      brand: s.rawPayload.brand ?? null,
      city: s.scope.geo?.city ?? null,
      country: s.scope.geo?.countryCode ?? null,
      magnitude: s.magnitude,
      url: s.rawPayload.website ?? s.rawPayload.osmUrl ?? null,
    });
  }
  return out;
}

function transformStr(signals: RawSignal[]): IntelStr[] {
  const out: IntelStr[] = [];
  for (const s of signals) {
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({
      lat, lng,
      city: s.scope.geo?.city ?? null,
      country: s.scope.geo?.countryCode ?? null,
      neighbourhood: String(s.rawPayload.neighbourhood ?? '—'),
      listings: Number(s.rawPayload.listings ?? 0),
      medianPriceLocal: s.rawPayload.medianPriceLocal != null ? Number(s.rawPayload.medianPriceLocal) : null,
      occupancyProxy: Number(s.rawPayload.avgReviewsPerMonth ?? 0),
      availability365: s.rawPayload.avgAvailability365 != null ? Number(s.rawPayload.avgAvailability365) : null,
      entireHomeShare: s.rawPayload.entireHomeShare != null ? Number(s.rawPayload.entireHomeShare) : null,
      magnitude: s.magnitude,
      snapshotDate: s.rawPayload.snapshotDate ?? null,
    });
  }
  return out;
}

function transformVenues(signals: RawSignal[]): IntelVenue[] {
  const out: IntelVenue[] = [];
  for (const s of signals) {
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({
      lat, lng,
      name: String(s.rawPayload.name ?? 'Unnamed venue'),
      category: String(s.rawPayload.category ?? 'venue'),
      capacity: s.rawPayload.capacity != null ? Number(s.rawPayload.capacity) : null,
      city: s.scope.geo?.city ?? null,
      country: s.scope.geo?.countryCode ?? null,
      magnitude: s.magnitude,
      url: s.rawPayload.website ?? s.rawPayload.osmUrl ?? null,
    });
  }
  return out;
}

function transformEvents(signals: RawSignal[]): IntelEvent[] {
  const out: IntelEvent[] = [];
  for (const s of signals) {
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({
      lat, lng,
      name: String(s.rawPayload.name ?? 'Unnamed event'),
      venue: s.rawPayload.venue ?? null,
      start: s.timeWindow.start,
      end: s.timeWindow.end,
      source: s.source,
      magnitude: s.magnitude,
      confidence: s.confidence,
      url: s.rawPayload.url ?? null,
      city: s.scope.geo?.city ?? null,
      country: s.scope.geo?.countryCode ?? null,
      segment: s.rawPayload.segment ?? s.rawPayload.category ?? null,
    });
  }
  return out;
}

function transformFlights(signals: RawSignal[], priceSignals: RawSignal[]): IntelAirport[] {
  const byAirport = new Map<string, IntelAirport>();
  const ensureAirport = (s: RawSignal): IntelAirport | null => {
    const code = s.scope.geo?.airportCode;
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (!code || typeof lat !== 'number' || typeof lng !== 'number') return null;
    let entry = byAirport.get(code);
    if (!entry) {
      entry = {
        lat, lng, airport: code,
        city: s.scope.geo?.city ?? null,
        country: s.scope.geo?.countryCode ?? null,
        days: [], totalFlights: 0, corridors: [], byOriginCountry: {}, fares: [],
      };
      byAirport.set(code, entry);
    }
    return entry;
  };

  for (const s of signals) {
    const entry = ensureAirport(s);
    if (!entry) continue;
    const flightCount = Number(s.rawPayload.flightCount ?? 0);
    entry.days.push({
      day: s.timeWindow.start.slice(0, 10),
      flightCount,
      magnitude: s.magnitude,
      confidence: s.confidence,
    });
    entry.totalFlights += flightCount;
    for (const c of s.rawPayload.corridors ?? []) {
      const existing = entry.corridors.find(x => x.origin === c.origin);
      if (existing) existing.flights += Number(c.flights ?? 0);
      else entry.corridors.push({ origin: c.origin, destination: c.destination, flights: Number(c.flights ?? 0) });
    }
    for (const [country, n] of Object.entries(s.rawPayload.byOriginCountry ?? {})) {
      entry.byOriginCountry[country] = (entry.byOriginCountry[country] ?? 0) + Number(n);
    }
  }

  // Tarifas Amadeus ancladas al aeropuerto receptor. ensureAirport crea la
  // entrada si AeroDataBox no corrió (sin key de flights igual hay puntos).
  for (const s of priceSignals) {
    const entry = ensureAirport(s);
    if (!entry) continue;
    const price = Number(s.rawPayload.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ratio = s.rawPayload.ratio != null ? Number(s.rawPayload.ratio) : null;
    entry.fares.push({
      origin: String(s.rawPayload.origin ?? '?'),
      departureDate: String(s.rawPayload.departureDate ?? s.timeWindow.start.slice(0, 10)),
      horizonDays: Number(s.rawPayload.horizonDays ?? 0),
      price,
      currency: String(s.rawPayload.currency ?? 'USD'),
      magnitude: s.magnitude,
      vsAvgPct: ratio !== null && Number.isFinite(ratio) ? Math.round((ratio - 1) * 100) : null,
    });
  }

  for (const entry of byAirport.values()) {
    entry.days.sort((a, b) => a.day.localeCompare(b.day));
    entry.fares.sort((a, b) => a.origin.localeCompare(b.origin) || a.horizonDays - b.horizonDays);
  }
  return [...byAirport.values()];
}

function transformWeather(signals: RawSignal[]): IntelWeather[] {
  const byDest = new Map<string, IntelWeather>();
  for (const s of signals) {
    const dest = String(s.rawPayload.destination ?? s.scope.geo?.city ?? '');
    const lat = s.scope.geo?.lat;
    const lng = s.scope.geo?.lng;
    if (!dest || typeof lat !== 'number' || typeof lng !== 'number') continue;
    let entry = byDest.get(dest);
    if (!entry) {
      entry = {
        lat, lng, destination: dest,
        profile: String(s.rawPayload.profile ?? 'urban'),
        country: s.scope.geo?.countryCode ?? null,
        days: [], avgFavorability7d: 0,
      };
      byDest.set(dest, entry);
    }
    entry.days.push({
      day: s.timeWindow.start.slice(0, 10),
      tMax: s.rawPayload.tMax ?? null,
      tMin: s.rawPayload.tMin ?? null,
      precipitationMm: s.rawPayload.precipitationMm ?? null,
      weatherCode: s.rawPayload.weatherCode ?? null,
      windMaxKmh: s.rawPayload.windMaxKmh ?? null,
      magnitude: s.magnitude,
      confidence: s.confidence,
    });
  }
  for (const entry of byDest.values()) {
    entry.days.sort((a, b) => a.day.localeCompare(b.day));
    const next7 = entry.days.slice(0, 7);
    entry.avgFavorability7d = next7.length
      ? Number((next7.reduce((sum, d) => sum + d.magnitude, 0) / next7.length).toFixed(2))
      : 0;
  }
  return [...byDest.values()];
}

function transformOrigins(fx: RawSignal[], trends: RawSignal[], holidays: RawSignal[], schoolHolidays: RawSignal[], healthAlerts: RawSignal[]): IntelOrigin[] {
  const byCountry = new Map<string, IntelOrigin>();
  const ensure = (countryCode: string): IntelOrigin | null => {
    let entry = byCountry.get(countryCode);
    if (entry) return entry;
    const centroid = centroidFor(countryCode);
    if (!centroid) return null;
    entry = { lat: centroid[1], lng: centroid[0], countryCode, fx: [], trends: [], holidays: [], schoolHolidays: [], healthAlerts: [] };
    byCountry.set(countryCode, entry);
    return entry;
  };

  for (const s of fx) {
    const base = String(s.rawPayload.base ?? '');
    const country = CURRENCY_COUNTRY[base];
    if (!country) continue;
    const entry = ensure(country);
    if (!entry) continue;
    entry.fx.push({
      base,
      quote: String(s.rawPayload.quote ?? ''),
      rate: Number(s.rawPayload.rate ?? 0),
      officialRate: s.rawPayload.officialRate ?? null,
      parallelRate: s.rawPayload.parallelRate ?? null,
      magnitude: s.magnitude,
    });
  }

  for (const s of trends) {
    const geo = String(s.rawPayload.geo ?? s.scope.geo?.countryCode ?? '');
    const entry = geo ? ensure(geo) : null;
    if (!entry) continue;
    entry.trends.push({
      keyword: String(s.rawPayload.keyword ?? ''),
      value: Number(s.rawPayload.value ?? Math.round(s.magnitude * 100)),
      weekStart: s.timeWindow.start.slice(0, 10),
    });
  }

  // Only upcoming 45 days of holidays, and only for countries already on the
  // map as emitters (plus AR shown on its own centroid as the receiver).
  const cutoff = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  for (const s of holidays) {
    const country = s.scope.geo?.countryCode;
    if (!country) continue;
    const date = s.timeWindow.start.slice(0, 10);
    if (date > cutoff) continue;
    const entry = ensure(country);
    if (!entry) continue;
    entry.holidays.push({
      date,
      name: String(s.rawPayload.localName ?? s.rawPayload.name ?? 'Holiday'),
      global: Boolean(s.rawPayload.global),
    });
  }

  // School holidays: mismo ancla de centroide emisor. Ventana más larga que
  // los feriados (120d): planifican el viaje familiar con meses de lead.
  const schoolCutoff = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  for (const s of schoolHolidays) {
    const country = s.scope.geo?.countryCode;
    if (!country) continue;
    const start = s.timeWindow.start.slice(0, 10);
    if (start > schoolCutoff) continue;
    const entry = ensure(country);
    if (!entry) continue;
    entry.schoolHolidays.push({
      start,
      end: s.timeWindow.end.slice(0, 10),
      name: String(s.rawPayload.name ?? 'School holiday'),
      nationwide: Boolean(s.rawPayload.nationwide),
    });
  }

  // Alertas WHO vigentes en el centroide del país afectado. Cancelador de
  // demanda del receptor, pero también avisa cuando un emisor entra en brote.
  for (const s of healthAlerts) {
    const country = s.scope.geo?.countryCode;
    if (!country) continue;
    const entry = ensure(country);
    if (!entry) continue;
    entry.healthAlerts.push({
      date: String(s.rawPayload.published ?? s.timeWindow.start.slice(0, 10)),
      title: String(s.rawPayload.title ?? 'Health alert'),
      url: s.rawPayload.url ?? null,
      magnitude: s.magnitude,
    });
  }

  for (const entry of byCountry.values()) {
    entry.holidays.sort((a, b) => a.date.localeCompare(b.date));
    entry.trends.sort((a, b) => b.value - a.value);
    entry.schoolHolidays.sort((a, b) => a.start.localeCompare(b.start));
    entry.schoolHolidays = entry.schoolHolidays.slice(0, 6);
    entry.healthAlerts.sort((a, b) => b.date.localeCompare(a.date));
    entry.healthAlerts = entry.healthAlerts.slice(0, 3);
  }
  return [...byCountry.values()];
}
