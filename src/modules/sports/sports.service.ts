// Hub de eventos deportivos (event-list.md §3).
//
// Tercero de la serie, y el que cambia de eje: clima (§1) es dato local del
// punto y calendario (§2) es dato del pais, pero un evento deportivo ocurre en
// una SEDE y mueve la ocupacion a su alrededor. Por eso este hub filtra por
// distancia: se clickea un punto y devuelve que se juega cerca, cuando, y con
// cuanta antelacion se sabe.
//
// Cuatro origenes que se complementan:
//
//   1. Mega-eventos curados (mega-events.ts) — JJOO, mundiales, Eurocopa,
//      Super Bowl. No hay API libre y es lo mas valioso de la categoria: se
//      adjudican con 6-8 anios de antelacion.
//   2. Formula 1 en vivo via Jolpica (sucesor de Ergast, gratis y sin key).
//      Trae lat/lng del circuito, asi que cae directo en el filtro por radio.
//   3. Anuales de sede fija por regla (recurring.ts) — maratones Major, Grand
//      Slams, Dakar, Masters, grandes vueltas.
//   4. Fixtures de liga ya ingestados por el intelligence-hub, leidos con su
//      propio helper fetchIntelligence() en vez de volver a pegarle a
//      TheSportsDB (que ademas rate-limitea fuerte con la key gratis).

import { fetchJson } from "../intelligence/core/http";
// El modulo portado ya exporta estas dos con tipos utiles.
import { fetchIntelligence, isConfigured } from "../global/lib/intelligence";
import { MEGA_EVENTS, PENDING_HOSTS } from "./mega-events";
import { recurringEvents } from "./recurring";
import type {
  SportsCoverage,
  SportsEvent,
  SportsPointPayload,
} from "./sports.types";

const JOLPICA_BASE = "https://api.jolpi.ca/ergast/f1";
const MS_DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

// ── Cache ─────────────────────────────────────────────────────────────────
// Por catalogo, no por punto: el calendario de F1 y los fixtures son los
// mismos para todo el planeta, solo cambia el filtro por distancia.

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const TTL_CATALOG = 6 * 60 * 60 * 1000;

async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;
  const value = await load();
  store.set(key, { ts: Date.now(), value });
  return value;
}

// ── Geometria ─────────────────────────────────────────────────────────────

/** Distancia haversine en km. */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Formula 1 (Jolpica) ───────────────────────────────────────────────────

interface JolpicaRace {
  season: string;
  round: string;
  raceName: string;
  date: string;
  url?: string;
  Circuit: {
    circuitName: string;
    Location: { lat: string; long: string; locality: string; country: string };
  };
}

async function formulaOne(years: number[]): Promise<SportsEvent[]> {
  const out: SportsEvent[] = [];
  for (const year of years) {
    try {
      const races = await memo(`f1:${year}`, TTL_CATALOG, async () => {
        const json = await fetchJson<{
          MRData?: { RaceTable?: { Races?: JolpicaRace[] } };
        }>(`${JOLPICA_BASE}/${year}/races/?format=json`, { timeoutMs: 15_000 });
        return json.MRData?.RaceTable?.Races ?? [];
      });
      for (const r of races) {
        const lat = Number(r.Circuit.Location.lat);
        const lng = Number(r.Circuit.Location.long);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        out.push({
          id: `f1-${r.season}-${r.round}`,
          name: r.raceName,
          category: "motorsport",
          sport: "Formula 1",
          // Un GP mueve el fin de semana entero, no solo el domingo.
          startDate: iso(new Date(new Date(`${r.date}T00:00:00Z`).getTime() - 2 * MS_DAY)),
          endDate: r.date,
          city: r.Circuit.Location.locality,
          country: r.Circuit.Location.country,
          venue: r.Circuit.circuitName,
          lat, lng,
          distanceKm: 0,
          leadDays: 0,
          impact: 0.85,
          nightsHint: 4,
          source: "Jolpica (Ergast F1)",
          curated: false,
          ...(r.url ? { url: r.url } : {}),
        });
      }
    } catch {
      /* un anio sin publicar no invalida el resto */
    }
  }
  return out;
}

// ── Fixtures del intelligence-hub ─────────────────────────────────────────

/**
 * Fixtures ya ingestados por el intelligence-hub. Se leen con el MISMO helper
 * que alimenta la capa ih_events del mapa (`fetchIntelligence`), en vez de
 * rearmar la llamada: ese helper ya sabe el path real
 * (`/api/v1/intelligence/summary`, no `/summary`), el header
 * x-internal-secret y la normalizacion de los signals a lat/lng.
 */
async function leagueFixtures(): Promise<SportsEvent[]> {
  if (!isConfigured()) return [];
  try {
    const data = await memo("intel:events", 30 * 60 * 1000, () => fetchIntelligence());
    return (data.events ?? [])
      .filter(
        (e: any) =>
          e.segment === "sports" &&
          typeof e.lat === "number" &&
          typeof e.lng === "number",
      )
      .map((e: any, i: number) => ({
        id: `fixture-${i}-${String(e.name).slice(0, 24)}`,
        name: String(e.name ?? "Partido"),
        category: "league" as const,
        sport: "Futbol",
        startDate: String(e.start ?? "").slice(0, 10),
        endDate: String(e.end ?? e.start ?? "").slice(0, 10),
        city: e.city ?? "",
        country: e.country ?? "",
        venue: e.venue ?? null,
        lat: e.lat as number,
        lng: e.lng as number,
        distanceKm: 0,
        leadDays: 0,
        // Un partido de liga llena una noche, no una temporada: se acota.
        impact: Math.min(0.6, typeof e.magnitude === "number" ? e.magnitude : 0.4),
        nightsHint: 1,
        source: "Intelligence Hub (TheSportsDB)",
        curated: false,
        ...(e.url ? { url: String(e.url) } : {}),
      }))
      .filter((e: SportsEvent) => /^\d{4}-\d{2}-\d{2}$/.test(e.startDate));
  } catch {
    return [];
  }
}

// ── Servicio principal ────────────────────────────────────────────────────

export async function getSportsPoint(
  lat: number,
  lng: number,
  radiusKm = 300,
  months = 60,
): Promise<SportsPointPayload> {
  const now = new Date();
  const from = iso(now);
  const to = iso(new Date(now.getTime() + months * 30 * MS_DAY));
  const years: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(y);

  const [f1, fixtures] = await Promise.all([
    formulaOne(years).catch(() => [] as SportsEvent[]),
    leagueFixtures().catch(() => [] as SportsEvent[]),
  ]);

  const candidates: SportsEvent[] = [...f1, ...fixtures];

  // Mega-eventos curados
  for (const m of MEGA_EVENTS) {
    candidates.push({
      id: `mega-${m.tournament}-${m.city}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: m.name,
      category: "mega",
      sport: m.sport,
      startDate: m.startDate,
      endDate: m.endDate,
      city: m.city,
      country: m.country,
      venue: m.venue ?? null,
      lat: m.lat, lng: m.lng,
      distanceKm: 0, leadDays: 0,
      impact: m.impact,
      nightsHint: m.nightsHint,
      source: "Tabla curada",
      curated: true,
      ...(m.note ? { note: m.note } : {}),
    });
  }

  // Anuales de sede fija
  for (const r of recurringEvents(years)) {
    candidates.push({
      id: `rec-${r.key}-${r.startDate}`,
      name: r.name,
      category: r.category,
      sport: r.sport,
      startDate: r.startDate,
      endDate: r.endDate,
      city: r.city,
      country: r.country,
      venue: r.venue ?? null,
      lat: r.lat, lng: r.lng,
      distanceKm: 0, leadDays: 0,
      impact: r.impact,
      nightsHint: r.nightsHint,
      source: "Tabla curada",
      curated: true,
      ...(r.note || r.approximate
        ? {
            note: [r.approximate ? "Fecha estimada: la fija el organizador" : null, r.note]
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
    });
  }

  // Filtro por radio y ventana, y calculo de distancia/antelacion.
  const today = new Date(`${from}T00:00:00Z`).getTime();
  const events = candidates
    .map((e) => ({
      ...e,
      distanceKm: Math.round(distanceKm(lat, lng, e.lat, e.lng)),
      leadDays: Math.round(
        (new Date(`${e.startDate}T00:00:00Z`).getTime() - today) / MS_DAY,
      ),
    }))
    .filter((e) => e.distanceKm <= radiusKm)
    // Sigue contando si ya empezo pero no termino.
    .filter((e) => e.endDate >= from && e.startDate <= to)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const byCategory: Record<string, number> = {};
  for (const e of events) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;

  const headline =
    events.length > 0
      ? events.reduce((best, e) => (e.impact > best.impact ? e : best))
      : null;

  const gaps: string[] = [...PENDING_HOSTS];
  if (f1.length === 0) gaps.push("Jolpica no devolvio calendario de F1 para la ventana");
  if (fixtures.length === 0) {
    gaps.push(
      "Sin fixtures de liga: el intelligence-hub no esta configurado o no ingesto eventos deportivos",
    );
  }
  gaps.push(
    "Sin cobertura: MotoGP, boxeo/UFC, esports, regatas y juegos regionales (no hay API libre)",
  );

  const coverage: SportsCoverage = {
    megaEvents: true,
    formula1: f1.length > 0,
    recurring: true,
    leagueFixtures: fixtures.length > 0,
    gaps,
  };

  return {
    location: { lat, lng, radiusKm },
    window: { from, to },
    events,
    byCategory,
    headline,
    coverage,
    sources: [
      "Tabla curada (mega-eventos y anuales de sede fija)",
      "Jolpica / Ergast (Formula 1)",
      "Intelligence Hub (fixtures de liga)",
    ],
    timestamp: new Date().toISOString(),
  };
}
