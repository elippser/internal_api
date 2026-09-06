// Hub de politicas migratorias y regulatorias (event-list.md §8).
//
// CIERRA EL HILO DE LOS EMISORES
// El §6 dice para quien el destino esta barato, el §7 quien puede volar hasta
// aca, y este a quien lo dejan entrar sin tramite. Los tres usan la MISMA
// lista de emisores (economy/reference.ts) a proposito: se abren los tres
// paneles sobre el mismo punto y se lee la respuesta completa a "que mercado
// conviene atacar". Barato + vuelo directo + sin visa es la unica combinacion
// que convierte sola.
//
// LA FRESCURA ES PARTE DEL DATO
// No hay API de visados: la unica fuente abierta es un CSV mantenido a mano.
// Hoy tiene mas de un ano. Eso no lo vuelve inservible —Mercosur y Schengen
// son tratados y no se mueven— pero si vuelve obligatorio mostrar la fecha:
// una politica que cambio despues no esta aca. El payload la lleva siempre y
// el panel la muestra arriba de todo cuando pasa el ano.
//
// CONTRADICCIONES ENTRE FUENTES
// Los bloques curados son tratados; la matriz es comunitaria. Cuando el
// tratado dice libre transito y la matriz pide visa, gana el tratado y la fila
// queda marcada con `conflict` para revisarla. Es la unica validacion cruzada
// que tiene este hub. Hoy no dispara en ningun caso probado, que es lo
// esperable: sirve de alarma para cuando el dataset se desactualice mas.

import { fetchJson } from "../intelligence/core/http";
import { COUNTRY_NAME, emittersFor } from "../economy/reference";
import { haversineKm } from "../connectivity/airports";
import { FRICTION, monthsOld, visaMatrix, type VisaCategory } from "./visa";
import {
  BLOCS,
  ENTRY_FEES,
  PENDING_REGULATION,
  YELLOW_FEVER_ALL,
  YELLOW_FEVER_IF_FROM_ENDEMIC,
  blocsFor,
  strRulesNear,
} from "./regulation";
import type {
  EmitterEntry,
  HealthEntry,
  PolicyCoverage,
  PolicyPointPayload,
  StrRegulation,
} from "./policy.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";

// ── Cache con TTL ─────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 500;

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

const TTL_GEO = 30 * 24 * 60 * 60 * 1000;

async function resolveCountry(lat: number, lng: number) {
  const key = "geo:" + lat.toFixed(1) + ":" + lng.toFixed(1);
  return memo(key, TTL_GEO, async () => {
    const data = await fetchJson<{ address?: Record<string, string> }>(
      NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=5&addressdetails=1",
      {
        headers: { "user-agent": "roombir-internal-policy-hub/1.0" },
        timeoutMs: 12_000,
        retries: 1,
      },
    );
    const addr = data.address ?? {};
    return {
      countryCode: (addr.country_code ?? "").toUpperCase(),
      countryName: addr.country ?? "",
    };
  });
}

/** Exigencia de fiebre amarilla del destino. */
function healthFor(cc: string): HealthEntry {
  if (YELLOW_FEVER_ALL.includes(cc)) {
    return {
      yellowFever: "all-travellers",
      note: "Exige certificado de fiebre amarilla a todo viajero: es una barrera real de entrada",
    };
  }
  if (YELLOW_FEVER_IF_FROM_ENDEMIC.includes(cc)) {
    return {
      yellowFever: "from-endemic-areas",
      note: "Exige certificado solo a quien llega desde una zona endemica",
    };
  }
  return { yellowFever: "none", note: "Sin exigencia sanitaria estable de entrada" };
}

// El dataset se considera viejo pasado el ano: es el plazo en el que suele
// haber al menos un cambio de politica relevante en la region.
const STALE_MONTHS = 12;

export async function getPolicyPoint(lat: number, lng: number): Promise<PolicyPointPayload> {
  const gaps: string[] = [];
  const geo = await resolveCountry(lat, lng);
  const cc = geo.countryCode;

  if (!cc) {
    throw new Error("No se pudo resolver el pais del punto (probablemente oceano)");
  }

  let matrix: Awaited<ReturnType<typeof visaMatrix>> | null = null;
  try {
    matrix = await visaMatrix();
  } catch (err) {
    gaps.push(
      "No se pudo cargar la matriz de visados: " +
        (err instanceof Error ? err.message : "fuente no disponible"),
    );
  }

  // ── Emisores ──
  const emitters: EmitterEntry[] = emittersFor(cc).map((ec) => {
    const rule = matrix?.get(ec, cc) ?? null;
    const shared = blocsFor(cc, ec);
    const category: VisaCategory = rule?.category ?? "unknown";

    // El tratado manda sobre la matriz comunitaria: si comparten bloque de
    // libre transito, no puede hacer falta visa. Se marca la contradiccion.
    const conflict =
      shared.length > 0 && (category === "visa-required" || category === "no-admission");
    const effective: VisaCategory = conflict ? "visa-free" : category;

    return {
      countryCode: ec,
      countryName: COUNTRY_NAME[ec] ?? ec,
      category: effective,
      days: rule?.days ?? null,
      friction: FRICTION[effective],
      blocs: shared.map((b) => b.name),
      raw: rule?.raw ?? "",
      conflict,
    };
  });

  // De menor a mayor friccion: arriba queda el mercado que entra sin nada.
  emitters.sort((a, b) => a.friction - b.friction || a.countryName.localeCompare(b.countryName));

  // Agrupado por tramite PREVIO al viaje: una visa que se saca en la frontera
  // no frena una reserva, una que pide un mes de anticipacion si.
  const NO_PRIOR: VisaCategory[] = ["visa-free", "visa-on-arrival", "same-country"];
  const PRIOR: VisaCategory[] = ["eta", "e-visa", "visa-required"];
  const noPriorPaperwork = emitters.filter((e) => NO_PRIOR.includes(e.category)).length;
  const priorPaperwork = emitters.filter((e) => PRIOR.includes(e.category)).length;
  const blocked = emitters.filter((e) => e.category === "no-admission").length;
  const sameBloc = emitters.filter((e) => e.blocs.length > 0).length;

  const strRegulation: StrRegulation[] = strRulesNear(lat, lng, haversineKm).map((r) => ({
    city: r.city,
    severity: r.severity,
    summary: r.summary,
    asOf: r.asOf,
    distanceKm: r.distanceKm,
  }));

  const destinationBlocs = BLOCS.filter((b) => b.members.includes(cc)).map((b) => ({
    key: b.key,
    name: b.name,
    effect: b.effect,
  }));

  const dataDate = matrix?.dataDate ?? "";
  const age = dataDate ? monthsOld(dataDate) : 0;
  const stale = age >= STALE_MONTHS;

  if (stale) {
    gaps.push(
      "La matriz de visados tiene " +
        age +
        " meses: los cambios de politica posteriores a " +
        dataDate +
        " no estan reflejados",
    );
  }
  const conflicts = emitters.filter((e) => e.conflict);
  if (conflicts.length) {
    gaps.push(
      "Contradiccion entre tratado y matriz en " +
        conflicts.map((c) => c.countryCode).join(", ") +
        ": se tomo el tratado, conviene verificar",
    );
  }
  if (!strRegulation.length) {
    gaps.push(
      "Sin norma de alquiler temporario relevada para este punto: la tabla cubre las plazas grandes, no todas",
    );
  }
  for (const p of PENDING_REGULATION) gaps.push(p);

  const coverage: PolicyCoverage = {
    visaMatrix: matrix !== null,
    blocs: true,
    strRegulation: strRegulation.length > 0,
    gaps,
  };

  return {
    location: { lat, lng },
    country: { code: cc, name: COUNTRY_NAME[cc] ?? geo.countryName ?? cc },
    emitters,
    headline: { noPriorPaperwork, priorPaperwork, blocked, total: emitters.length, sameBloc },
    destinationBlocs,
    health: healthFor(cc),
    strRegulation,
    entryFees: ENTRY_FEES.filter((f) => f.country === cc).map((f) => ({
      name: f.name,
      amount: f.amount,
      appliesTo: f.appliesTo,
      asOf: f.asOf,
    })),
    dataset: {
      source: "passport-index-dataset",
      dataDate,
      monthsOld: age,
      stale,
    },
    coverage,
    sources: [
      "passport-index-dataset (matriz de visados)",
      "Tablas curadas: bloques de libre transito, alquiler temporario, fiebre amarilla",
      "OpenStreetMap Nominatim",
    ],
    timestamp: new Date().toISOString(),
  };
}
