/**
 * Ubicación y encabezado de la propiedad.
 *
 * `address.lat/lng` es OPCIONAL en pms-core y nadie lo geocodifica: en el alta
 * son dos campos de texto que el hotelero copia de Google Maps
 * (`Step2Property.tsx`). Una buena parte de las propiedades no los tiene.
 * Mismo problema que resolvió el RMS (`rms-app configService.syncLocationIfStale`):
 * si faltan, se geocodifica la dirección con Nominatim y se guarda.
 *
 * Tres niveles, y no dan lo mismo:
 *  - coordenadas cargadas         → todo
 *  - dirección ubicada (calle)    → todo, marcado "ubicación aproximada"
 *  - sólo la ciudad               → eventos, calendario, clima y alertas; el
 *                                   entorno a pie NO (el centro de la ciudad no
 *                                   es la cuadra del hotel)
 */

import { createHash } from "crypto";
import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../shared/pmsDb";
import { fetchJson } from "../intelligence/core/http";
import { createLimiter } from "./limiter";
import type { PropertyHeader } from "./tourism.types";

export interface PropertyAddress {
  street?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  lat?: unknown;
  lng?: unknown;
}

export interface PropertyDoc {
  propertyId: string;
  companyId?: string;
  name?: string;
  type?: string;
  timezone?: string;
  images?: unknown;
  address?: PropertyAddress;
  brand?: { assets?: Record<string, { url?: string } | null | undefined> };
}

const TYPE_LABEL: Record<string, string> = {
  hotel: "hotel",
  resort: "resort",
  aparthotel: "apart hotel",
  hostel: "hostel",
  cabin: "cabañas",
  villa: "villa",
  vacation_rental: "alquiler temporario",
  glamping: "glamping",
  motel: "motel",
  apartment: "departamentos",
  hybrid: "alojamiento mixto",
};

export const typeLabelOf = (type: string | undefined): string =>
  TYPE_LABEL[type ?? ""] ?? "alojamiento";

const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/** Mismo orden que el web-renderer (`getAuthBranding.ts`): hero, fondo, galería, foto, logo. */
export function pickPhotoUrl(doc: PropertyDoc): string | null {
  const a = doc.brand?.assets ?? {};
  const images = Array.isArray(doc.images) ? doc.images : [];
  const candidates: unknown[] = [a.hero?.url, a.background?.url, images[0], a.photo1?.url, a.logo?.url];
  return candidates.find(isHttpUrl) ?? null;
}

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function buildHeader(doc: PropertyDoc): PropertyHeader {
  const address = doc.address ?? {};
  const city = clean(address.city);
  const state = clean(address.stateProvince) || null;
  const cc = clean(address.countryCode).toUpperCase() || null;
  const place = [city, state].filter(Boolean).join(", ");
  return {
    propertyId: doc.propertyId,
    name: clean(doc.name) || "Tu propiedad",
    type: clean(doc.type) || "hotel",
    typeLabel: typeLabelOf(doc.type),
    photoUrl: pickPhotoUrl(doc),
    addressShort: cc ? (place ? `${place} · ${cc}` : cc) : place,
    city,
    stateProvince: state,
    countryCode: cc,
    timezone: clean(doc.timezone) || null,
  };
}

/** Coordenadas cargadas y válidas. (0, 0) es un formulario vacío, no el golfo de Guinea. */
export function coordsFromAddress(address?: PropertyAddress): { lat: number; lng: number } | null {
  const num = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  const lat = num(address?.lat);
  const lng = num(address?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** Si la dirección cambia, la ubicación resuelta (y los sobres) dejan de valer. */
export function addressHashOf(address?: PropertyAddress): string {
  const norm = (v: unknown) => clean(v).toLowerCase();
  const parts = [
    norm(address?.addressLine1) || norm(address?.street),
    norm(address?.city),
    norm(address?.stateProvince),
    norm(address?.countryCode) || norm(address?.country),
    String(address?.lat ?? ""),
    String(address?.lng ?? ""),
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

// ── Lectura de la propiedad (DB del PMS, sólo lectura) ───────────────────────

let propertyModel: Model<Record<string, unknown>> | null = null;
const propertyMemo = new Map<string, { ts: number; doc: PropertyDoc | null }>();
const PROPERTY_TTL_MS = 5 * 60 * 1000;

export async function loadPropertyDoc(propertyId: string): Promise<PropertyDoc | null> {
  const hit = propertyMemo.get(propertyId);
  if (hit && Date.now() - hit.ts < PROPERTY_TTL_MS) return hit.doc;

  if (!propertyModel) {
    const conn = await getPmsConnection();
    propertyModel =
      (conn.models.TourismProperty as Model<Record<string, unknown>> | undefined) ??
      conn.model<Record<string, unknown>>(
        "TourismProperty",
        new Schema({}, { strict: false, collection: "properties" }),
      );
  }
  const doc = (await propertyModel
    .findOne(
      { propertyId },
      { _id: 0, propertyId: 1, companyId: 1, name: 1, type: 1, timezone: 1, images: 1, address: 1, "brand.assets": 1 },
    )
    .lean()) as PropertyDoc | null;

  if (propertyMemo.size > 500) propertyMemo.clear();
  propertyMemo.set(propertyId, { ts: Date.now(), doc });
  return doc;
}

// ── Geocodificación (Nominatim) ──────────────────────────────────────────────

const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
const UA = "roombir-internal-tourism/1.0 (+https://roombir.com)";
/** Política de uso de Nominatim: 1 request por segundo como techo absoluto. */
const nominatim = createLimiter(1, 1100);

/** Resultados que son una zona entera, no una dirección. */
const CITY_LEVEL = new Set([
  "city", "town", "village", "hamlet", "municipality", "county", "state",
  "state_district", "region", "province", "country", "administrative",
]);

export interface GeocodeResult {
  lat: number;
  lng: number;
  source: "geocoded" | "city";
  from: string;
}

interface NominatimRow {
  lat?: string;
  lon?: string;
  addresstype?: string;
  type?: string;
  display_name?: string;
}

export function geocodeQueries(address?: PropertyAddress): Array<{ q: string; level: "address" | "city" }> {
  const street = clean(address?.addressLine1) || clean(address?.street);
  const city = clean(address?.city);
  const tail = [city, clean(address?.stateProvince), clean(address?.country)].filter(Boolean).join(", ");
  const out: Array<{ q: string; level: "address" | "city" }> = [];
  if (street && city) out.push({ q: `${street}, ${tail}`, level: "address" });
  if (city) out.push({ q: tail, level: "city" });
  return out;
}

export async function geocodeAddress(address?: PropertyAddress): Promise<GeocodeResult | null> {
  const cc = clean(address?.countryCode);
  const countryParam = /^[a-z]{2}$/i.test(cc) ? `&countrycodes=${cc.toLowerCase()}` : "";

  for (const { q, level } of geocodeQueries(address)) {
    let rows: NominatimRow[];
    try {
      rows = await nominatim(() =>
        fetchJson<NominatimRow[]>(
          `${NOMINATIM_SEARCH}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}${countryParam}`,
          { headers: { "user-agent": UA, "accept-language": "es" }, timeoutMs: 10_000, retries: 0 },
        ),
      );
    } catch (err) {
      // Una caída de Nominatim no se reintenta con la consulta más gruesa: sería
      // pegarle otra vez a un servicio que ya no responde.
      console.warn("[tourism] geocodificación falló:", err instanceof Error ? err.message : err);
      return null;
    }
    const row = rows[0];
    if (!row) continue;
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const cityLevel = level === "city" || CITY_LEVEL.has(String(row.addresstype ?? row.type ?? ""));
    return { lat, lng, source: cityLevel ? "city" : "geocoded", from: row.display_name ?? q };
  }
  return null;
}
