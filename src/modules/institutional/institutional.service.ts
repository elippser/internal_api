// Hub de factores educativos y migratorios internos (event-list.md §15).
//
// LA DEMANDA QUE NO ES TURISMO
// Todos los hubs anteriores miran al viajero de ocio o de negocios. Esta
// categoria mira la otra demanda, la que no elige el destino: el familiar que
// viene a una graduacion, el acompaniante de un paciente internado, el
// peregrino, el que llega a un velatorio. No tiene temporada alta ni responde
// a la tarifa, y por eso es la mas estable que puede tener un hotel.
//
// SE MIDE POR SUS ANCLAS, NO POR SUS VIAJEROS
// No hay estadistica abierta de turismo medico ni de mudanzas corporativas. Lo
// que si se puede censar es la INFRAESTRUCTURA que genera esa demanda: una
// universidad grande a diez cuadras produce graduaciones todos los anios, y un
// hospital de alta complejidad produce acompaniantes todos los dias. El hub
// cuenta anclas y dice explicitamente que no cuenta personas.

import { around, overpass, positionOf } from "../shared/overpass";
import { haversineKm } from "../connectivity/airports";
import { fetchJson } from "../intelligence/core/http";
import { ISO3 } from "../economy/reference";
import { ACADEMIC_CALENDAR, type AcademicWindow } from "./academic";
import type {
  Anchor,
  AnchorGroup,
  InstitutionalCoverage,
  InstitutionalPointPayload,
} from "./institutional.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const WB_BASE = "https://api.worldbank.org/v2";
const UA = "roombir-internal-institutional-hub/1.0 (+https://roombir.com)";

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 300;
const TTL_OK = 7 * 24 * 60 * 60 * 1000;
const TTL_EMPTY = 5 * 60 * 1000;
const TTL_GEO = 30 * 24 * 60 * 60 * 1000;
const TTL_WB = 7 * 24 * 60 * 60 * 1000;

async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await load();
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { ts: Date.now(), value });
  return value;
}

const CAP = 600;

/** Cada grupo con su etiqueta y por que genera demanda hotelera. */
const GROUPS: Array<{ key: AnchorGroup; label: string; why: string }> = [
  { key: "university", label: "Universidades", why: "Graduaciones, ingresos, congresos academicos" },
  { key: "hospital", label: "Hospitales y clinicas", why: "Acompaniantes de pacientes, turismo medico" },
  { key: "worship", label: "Sitios religiosos", why: "Peregrinacion y festividades del calendario" },
  { key: "wellness", label: "Spas y bienestar", why: "Retiros y estadias de bienestar" },
  { key: "funeral", label: "Cementerios y casas velatorias", why: "Demanda funeraria, corta y sin aviso" },
];

function query(lat: number, lng: number, radiusM: number): string {
  const a = around(radiusM, lat, lng);
  return (
    "[out:json][timeout:60];(" +
    'nwr["amenity"~"^(university|college)$"]' + a + ";" +
    'nwr["amenity"~"^(hospital|clinic)$"]' + a + ";" +
    'nwr["amenity"="place_of_worship"]' + a + ";" +
    'nwr["leisure"="spa"]' + a + ";" +
    'nwr["amenity"="spa"]' + a + ";" +
    'nwr["amenity"~"^(funeral_hall|crematorium)$"]' + a + ";" +
    'nwr["landuse"="cemetery"]' + a + ";" +
    ");out tags center " + CAP + ";"
  );
}

function groupOf(tags: Record<string, string>): AnchorGroup | null {
  const a = tags.amenity;
  if (a === "university" || a === "college") return "university";
  if (a === "hospital" || a === "clinic") return "hospital";
  if (a === "place_of_worship") return "worship";
  if (a === "spa" || tags.leisure === "spa") return "wellness";
  if (a === "funeral_hall" || a === "crematorium" || tags.landuse === "cemetery") return "funeral";
  return null;
}

async function resolveCountry(lat: number, lng: number): Promise<string> {
  return memo("geo:" + lat.toFixed(1) + ":" + lng.toFixed(1), TTL_GEO, async () => {
    try {
      const d = await fetchJson<{ address?: Record<string, string> }>(
        NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=5&addressdetails=1",
        { headers: { "user-agent": UA }, timeoutMs: 12_000, retries: 1 },
      );
      return (d.address?.country_code ?? "").toUpperCase();
    } catch {
      return "";
    }
  });
}

interface WbRow { countryiso3code: string; date: string; value: number | null }

/** Migracion neta del pais: el saldo de gente que entra menos la que sale. */
async function netMigration(iso3: string): Promise<{ value: number; year: number } | null> {
  return memo("wb:migration", TTL_WB, async () => {
    try {
      const raw = await fetchJson<[unknown, WbRow[] | null]>(
        WB_BASE + "/country/all/indicator/SM.POP.NETM?format=json&mrv=1&per_page=400",
        { timeoutMs: 25_000, retries: 1 },
      );
      const rows = Array.isArray(raw) ? raw[1] ?? [] : [];
      const m = new Map<string, { value: number; year: number }>();
      for (const r of rows) {
        if (!r || r.value === null || !Number.isFinite(r.value)) continue;
        m.set(r.countryiso3code, { value: r.value, year: Number(r.date) });
      }
      return m;
    } catch {
      return new Map<string, { value: number; year: number }>();
    }
  }).then((m) => m.get(iso3) ?? null);
}

/** Ventana academica vigente o proxima, del calendario curado. */
function academicWindow(cc: string, lat: number): AcademicWindow | null {
  const entry = ACADEMIC_CALENDAR[cc];
  if (entry) return entry;
  // Sin entrada propia: el hemisferio define el grueso del ciclo lectivo.
  return lat < 0 ? ACADEMIC_CALENDAR.__south : ACADEMIC_CALENDAR.__north;
}

export async function getInstitutionalPoint(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<InstitutionalPointPayload> {
  const gaps: string[] = [];
  const radiusM = Math.min(30_000, Math.round(radiusKm * 1000));

  const cacheKey = "inst:" + lat.toFixed(2) + ":" + lng.toFixed(2) + ":" + radiusM;
  const hit = store.get(cacheKey) as CacheEntry<Awaited<ReturnType<typeof overpass>>> | undefined;
  let elements: Awaited<ReturnType<typeof overpass>>;
  if (hit && Date.now() - hit.ts < (hit.value && hit.value.length ? TTL_OK : TTL_EMPTY)) {
    elements = hit.value;
  } else {
    elements = await overpass(query(lat, lng, radiusM));
    store.set(cacheKey, { ts: Date.now(), value: elements });
  }

  const cc = await resolveCountry(lat, lng);
  const iso3 = ISO3[cc] ?? "";
  const migration = iso3 ? await netMigration(iso3) : null;

  const counts = new Map<AnchorGroup, number>();
  const nearest = new Map<AnchorGroup, Anchor>();

  if (elements) {
    for (const e of elements) {
      const tags = e.tags ?? {};
      const g = groupOf(tags);
      if (!g) continue;
      const pos = positionOf(e);
      if (!pos) continue;
      const d = haversineKm(lat, lng, pos.lat, pos.lon);
      if (d > radiusKm) continue;

      counts.set(g, (counts.get(g) ?? 0) + 1);
      const current = nearest.get(g);
      const distanceM = Math.round(d * 1000);
      if (!current || distanceM < current.distanceM) {
        nearest.set(g, {
          group: g,
          name: tags.name ?? null,
          distanceM,
          detail: tags.religion ?? tags.healthcare ?? null,
        });
      }
    }
  } else {
    gaps.push("Overpass no respondio: sin censo de anclas institucionales");
  }

  const groups = GROUPS.map((g) => ({
    group: g.key,
    label: g.label,
    why: g.why,
    count: counts.get(g.key) ?? 0,
    nearest: nearest.get(g.key) ?? null,
  })).filter((g) => g.count > 0);

  const academic = academicWindow(cc, lat);

  const total = groups.reduce((s, g) => s + g.count, 0);
  const dominant = groups.slice().sort((a, b) => b.count - a.count)[0] ?? null;

  gaps.push("Turismo medico: no hay estadistica abierta de volumen; se censa el hospital, no al paciente");
  gaps.push("Mudanzas laborales masivas: las empresas no publican transferencias");
  gaps.push("Turismo religioso: se ve el sitio, no la peregrinacion. Las festividades estan en el §2");
  gaps.push("El calendario academico es curado y aproximado: cada universidad fija su propia fecha");

  const coverage: InstitutionalCoverage = {
    census: elements !== null,
    academic: academic !== null,
    migration: migration !== null,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    country: cc,
    groups,
    totalAnchors: total,
    dominant: dominant ? dominant.label : null,
    academic,
    netMigration: migration,
    coverage,
    sources: [
      "OpenStreetMap Overpass (anclas institucionales)",
      "Calendario academico curado",
      "Banco Mundial (migracion neta)",
    ],
    timestamp: new Date().toISOString(),
  };
}
