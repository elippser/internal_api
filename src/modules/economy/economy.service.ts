// Hub de factores economicos y financieros (event-list.md §6).
//
// LA PREGUNTA QUE CONTESTA
// Un hotel no necesita un tablero de macro: necesita saber si se esta
// volviendo caro o barato para el turista que efectivamente lo visita. Por eso
// todo el hub esta armado alrededor del cruce destino <-> mercado emisor, y no
// alrededor del pais aislado.
//
// POR QUE EL TIPO DE CAMBIO NOMINAL NO ALCANZA
// Es el error clasico de leer estos datos: "devaluamos 40%, somos baratos".
// Falso si la inflacion local fue 45%. Lo que el turista compara es el precio
// en SU moneda, o sea el tipo de cambio real:
//
//   costo relativo = (1 + inflacion_destino) / (1 + inflacion_emisor) x cruce
//
// De ahi salen los dos numeros de cada emisor: nominalChangePct (lo que se ve)
// y realChangePct (lo que importa). Cuando difieren mucho, el destino esta en
// el fenomeno de "caro en dolares" y conviene verlo antes de tarifar.
//
// PRESUPUESTO DE REQUESTS
// El FMI ignora el filtro de pais y devuelve los 122 paises de una: se pide
// UNA vez por indicador y sirve para el destino y para todos los emisores.
// Cacheado global, no por punto. Lo unico que escala con el punto es el
// geocoding (grilla de 0.5 grados) y el cruce cambiario.

import { fetchJson } from "../intelligence/core/http";
import {
  CURRENCY,
  COUNTRY_NAME,
  ECB_CURRENCIES,
  ISO3,
  emittersFor,
  hasCuratedEmitters,
} from "./reference";
import type {
  EconomyCoverage,
  EconomyPointPayload,
  EmitterView,
  Indicator,
  MacroSnapshot,
  ParallelMarket,
  Verdict,
} from "./economy.types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const IMF_BASE = "https://www.imf.org/external/datamapper/api/v1";
const WB_BASE = "https://api.worldbank.org/v2";
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";
const ERAPI_BASE = "https://open.er-api.com/v6/latest";
const DOLARAPI_BASE = "https://dolarapi.com/v1/dolares";
const ARGDATOS_BASE = "https://api.argentinadatos.com/v1";

// ── Cache con TTL ─────────────────────────────────────────────────────────

interface CacheEntry<T> { ts: number; value: T }
const store = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 300;

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

// El WEO del FMI sale dos veces al ano; el Banco Mundial actualiza por lotes.
// El tipo de cambio si se mueve todos los dias.
const TTL_GEO = 30 * 24 * 60 * 60 * 1000;
const TTL_MACRO = 7 * 24 * 60 * 60 * 1000;
const TTL_FX = 60 * 60 * 1000;
const TTL_PARALLEL = 30 * 60 * 1000;

const round = (n: number, d = 2): number => Number(n.toFixed(d));
const nullIndicator = (unit: string): Indicator => ({
  value: null,
  year: null,
  projected: false,
  unit,
});

// ── Geocoding inverso ─────────────────────────────────────────────────────

async function resolveCountry(lat: number, lng: number) {
  // Misma grilla que los otros hubs: un pais no cambia dentro de 0.5 grados
  // salvo en frontera, y Nominatim topea en 1 req/s.
  const key = "geo:" + lat.toFixed(1) + ":" + lng.toFixed(1);
  return memo(key, TTL_GEO, async () => {
    const data = await fetchJson<{ address?: Record<string, string> }>(
      NOMINATIM_BASE + "?lat=" + lat + "&lon=" + lng + "&format=json&zoom=5&addressdetails=1",
      {
        headers: { "user-agent": "roombir-internal-economy-hub/1.0" },
        timeoutMs: 12_000,
        retries: 1,
      },
    );
    const addr = data.address ?? {};
    return {
      countryCode: (addr.country_code ?? "").toUpperCase(),
      countryName: addr.country ?? "",
      region: addr.state ?? addr.region ?? null,
    };
  });
}

// ── FMI (World Economic Outlook) ──────────────────────────────────────────

interface ImfResponse {
  values?: Record<string, Record<string, Record<string, number>>>;
}

/**
 * Serie de un indicador del WEO para TODOS los paises. El path pide un pais
 * pero la API lo ignora y devuelve los 122; se aprovecha para no repetir la
 * llamada por cada emisor.
 */
async function imfIndicator(code: string): Promise<Record<string, Record<string, number>>> {
  return memo("imf:" + code, TTL_MACRO, async () => {
    // El WEO devuelve los 122 paises con toda su serie historica: son ~120 KB
    // por indicador y el servidor del FMI tarda. Con 20 s se cortaba solo.
    const data = await fetchJson<ImfResponse>(IMF_BASE + "/" + code + "/ARG", {
      timeoutMs: 45_000,
      retries: 2,
    });
    return data.values?.[code] ?? {};
  });
}

/**
 * Ultimo valor de la serie y si es observado o proyectado. El WEO publica
 * proyecciones varios anios adelante: se toma el mas reciente que no supere el
 * anio corriente, y se marca `projected` cuando cae en el anio en curso (el
 * FMI no distingue observado de proyectado en el payload, pero esa es la
 * frontera real).
 */
function latestFrom(series: Record<string, number> | undefined, unit: string): Indicator {
  if (!series) return nullIndicator(unit);
  const currentYear = new Date().getUTCFullYear();
  const years = Object.keys(series)
    .map(Number)
    .filter((y) => Number.isFinite(y) && y <= currentYear)
    .sort((a, b) => b - a);
  for (const y of years) {
    const v = series[String(y)];
    if (typeof v === "number" && Number.isFinite(v)) {
      return { value: round(v, 2), year: y, projected: y >= currentYear, unit };
    }
  }
  return nullIndicator(unit);
}

// ── Banco Mundial: nivel de precios derivado ──────────────────────────────

interface WbRow {
  countryiso3code: string;
  date: string;
  value: number | null;
}

async function wbIndicator(code: string): Promise<Record<string, { value: number; year: number }>> {
  return memo("wb:" + code, TTL_MACRO, async () => {
    // mrv=1 = most recent value; per_page alto para traer todos los paises en
    // una sola pagina.
    const raw = await fetchJson<[unknown, WbRow[] | null]>(
      WB_BASE + "/country/all/indicator/" + code + "?format=json&mrv=1&per_page=400",
      { timeoutMs: 25_000, retries: 1 },
    );
    const rows = Array.isArray(raw) ? raw[1] ?? [] : [];
    const out: Record<string, { value: number; year: number }> = {};
    for (const r of rows) {
      if (!r || r.value === null || !Number.isFinite(r.value)) continue;
      out[r.countryiso3code] = { value: r.value, year: Number(r.date) };
    }
    return out;
  });
}

/**
 * Nivel de precios relativo a EE.UU.: factor PPA / tipo de cambio de mercado.
 * El Banco Mundial archivo el indicador que lo publicaba directo
 * (PA.NUS.PPPC.RF), asi que se deriva de sus dos componentes.
 * Control de sanidad: EE.UU. da exactamente 1.0 por definicion.
 */
async function priceLevels(): Promise<Record<string, { value: number; year: number }>> {
  const [ppp, fx] = await Promise.all([wbIndicator("PA.NUS.PPP"), wbIndicator("PA.NUS.FCRF")]);
  const out: Record<string, { value: number; year: number }> = {};
  for (const [iso3, p] of Object.entries(ppp)) {
    const f = fx[iso3];
    if (!f || f.value === 0) continue;
    out[iso3] = { value: p.value / f.value, year: Math.min(p.year, f.year) };
  }
  return out;
}

// ── Tipo de cambio ────────────────────────────────────────────────────────

interface FrankfurterSeries {
  rates?: Record<string, Record<string, number>>;
}

/** Spot contra USD. Cubre ~160 monedas, incluidas las que el BCE no publica. */
async function spotRatesUsd(): Promise<Record<string, number>> {
  return memo("fx:spot:usd", TTL_FX, async () => {
    const data = await fetchJson<{ rates?: Record<string, number> }>(ERAPI_BASE + "/USD", {
      timeoutMs: 15_000,
      retries: 1,
    });
    return data.rates ?? {};
  });
}

/**
 * Cruce de hace 12 meses entre dos monedas del BCE. Se pide una ventana de una
 * semana y se toma el primer dia con dato: asi no importa si el aniversario
 * cae feriado o fin de semana.
 */
async function crossYearAgo(base: string, quote: string): Promise<number | null> {
  if (base === quote) return 1;
  if (!ECB_CURRENCIES.has(base) || !ECB_CURRENCIES.has(quote)) return null;
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  const start = from.toISOString().slice(0, 10);
  const end = new Date(from.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  return memo("fx:hist:" + base + ":" + quote + ":" + start, TTL_FX, async () => {
    const data = await fetchJson<FrankfurterSeries>(
      FRANKFURTER_BASE + "/" + start + ".." + end + "?base=" + base + "&symbols=" + quote,
      { timeoutMs: 15_000, retries: 1 },
    );
    const days = Object.keys(data.rates ?? {}).sort();
    if (!days.length) return null;
    const v = data.rates?.[days[0]]?.[quote];
    return typeof v === "number" ? v : null;
  });
}

/**
 * Unidades de la moneda del destino por 1 USD hace 12 meses.
 *
 * Existe para poder medir destinos que el BCE no publica. Frankfurter cubre 30
 * monedas; el resto de America Latina (ARS, CLP, UYU, PEN, COP) queda afuera y
 * se pierde justo la mitad mas volatil del mapa. Cuando el banco central local
 * expone una serie abierta se la puentea por USD.
 *
 * Hoy solo esta cableada Argentina, que es el mercado propio y el de moneda
 * mas movediza. Sumar otro pais es agregar una rama aca.
 */
async function destPerUsdYearAgo(cc: string, currency: string): Promise<number | null> {
  if (currency === "USD") return 1;
  if (cc !== "AR") return null;
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return memo("fx:ars:" + y + m + day, TTL_FX, async () => {
    try {
      const row = await fetchJson<{ venta?: number }>(
        ARGDATOS_BASE + "/cotizaciones/dolares/oficial/" + y + "/" + m + "/" + day,
        { timeoutMs: 12_000, retries: 1 },
      );
      return row?.venta ?? null;
    } catch {
      return null;
    }
  });
}

// ── Mercado paralelo (control de capitales) ───────────────────────────────

interface DolarRow {
  casa: string;
  nombre: string;
  compra: number;
  venta: number;
  fechaActualizacion: string;
}

interface ArgInflationRow {
  fecha: string;
  valor: number;
}

/**
 * Argentina es el unico caso del mercado propio con brecha cambiaria y APIs
 * publicas para medirla. El turista no liquida al oficial: liquida al MEP o al
 * informal, asi que el oficial subestima cuanto le rinde la plata.
 */
async function argentineParallel(): Promise<ParallelMarket | null> {
  return memo("parallel:AR", TTL_PARALLEL, async () => {
    const rows = await fetchJson<DolarRow[]>(DOLARAPI_BASE, { timeoutMs: 12_000, retries: 1 });
    const oficial = rows.find((r) => r.casa === "oficial");
    // El MEP ("bolsa") es la via legal por la que un extranjero liquida, asi
    // que representa su tipo de cambio efectivo mejor que el informal.
    const alt = rows.find((r) => r.casa === "bolsa") ?? rows.find((r) => r.casa === "blue");
    if (!oficial || !alt) return null;

    const official = oficial.venta;
    const parallel = alt.venta;

    const [officialChange12mPct, inflation12mPct] = await Promise.all([
      argOfficialChange12m(official),
      argInflation12m(),
    ]);

    // Tipo de cambio real: si la inflacion le gano a la devaluacion, el pais
    // se encarecio en dolares aunque el numero del dolar haya subido.
    const realChange12mPct =
      officialChange12mPct !== null && inflation12mPct !== null
        ? round(((1 + inflation12mPct / 100) / (1 + officialChange12mPct / 100) - 1) * 100, 1)
        : null;

    return {
      official,
      parallel,
      parallelName: alt.nombre,
      gapPct: round((parallel / official - 1) * 100, 1),
      officialChange12mPct,
      inflation12mPct,
      realChange12mPct,
      asOf: alt.fechaActualizacion?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      source: "dolarapi.com + argentinadatos.com",
    };
  });
}

async function argOfficialChange12m(current: number): Promise<number | null> {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  try {
    const row = await fetchJson<{ venta?: number }>(
      ARGDATOS_BASE + "/cotizaciones/dolares/oficial/" + y + "/" + m + "/" + day,
      { timeoutMs: 12_000, retries: 1 },
    );
    if (!row?.venta) return null;
    return round((current / row.venta - 1) * 100, 1);
  } catch {
    return null;
  }
}

/** Inflacion acumulada de los ultimos 12 meses publicados por el INDEC. */
async function argInflation12m(): Promise<number | null> {
  return memo("infl12m:AR", TTL_PARALLEL, async () => {
    try {
      const rows = await fetchJson<ArgInflationRow[]>(
        ARGDATOS_BASE + "/finanzas/indices/inflacion",
        { timeoutMs: 12_000, retries: 1 },
      );
      const last12 = rows.slice(-12);
      if (last12.length < 12) return null;
      const factor = last12.reduce((acc, r) => acc * (1 + r.valor / 100), 1);
      return round((factor - 1) * 100, 1);
    } catch {
      return null;
    }
  });
}

/**
 * Inflacion de los ultimos 12 meses, que es la ventana que mide el cruce.
 *
 * El WEO publica el promedio ANUAL, que se le parece mientras la inflacion sea
 * estable. Donde esta cayendo a pique deja de parecerse: en Argentina el
 * promedio 2026 del FMI y el acumulado real del INDEC difieren varios puntos,
 * y el que corresponde a una ventana de 12 meses es el segundo. Se prefiere la
 * serie mensual local cuando existe.
 */
async function trailingInflation12m(cc: string, weoAnnual: number | null): Promise<number | null> {
  if (cc === "AR") {
    const indec = await argInflation12m();
    if (indec !== null) return indec;
  }
  return weoAnnual;
}

// ── Lectura del cambio real ───────────────────────────────────────────────

function verdictOf(realChangePct: number | null): Verdict | null {
  if (realChangePct === null) return null;
  // +-3% en un anio es ruido cambiario, no un cambio de competitividad.
  if (realChangePct < -3) return "cheaper";
  if (realChangePct > 3) return "pricier";
  return "stable";
}

// ── Endpoint ──────────────────────────────────────────────────────────────

export async function getEconomyPoint(lat: number, lng: number): Promise<EconomyPointPayload> {
  const geo = await resolveCountry(lat, lng);
  const cc = geo.countryCode;
  const gaps: string[] = [];

  if (!cc) {
    throw new Error("No se pudo resolver el pais del punto (probablemente oceano)");
  }

  const iso3 = ISO3[cc] ?? null;
  const currency = CURRENCY[cc] ?? null;

  // allSettled y no all: si el FMI se cae o tarda, el hub sigue sirviendo el
  // nivel de precios y el tipo de cambio en vez de devolver 502 entero. Lo que
  // falte se declara abajo como gap, nunca queda vacio y sin explicacion.
  const settled = await Promise.allSettled([
    imfIndicator("PCPIPCH"),
    imfIndicator("NGDP_RPCH"),
    imfIndicator("LUR"),
    imfIndicator("PPPPC"),
    priceLevels(),
    spotRatesUsd(),
  ]);

  const failedSources: string[] = [];
  const took = <T>(i: number, label: string, fallback: T): T => {
    const r = settled[i];
    if (r.status === "fulfilled") return r.value as T;
    if (!failedSources.includes(label)) failedSources.push(label);
    return fallback;
  };

  const empty: Record<string, Record<string, number>> = {};
  const inflation = took(0, "FMI", empty);
  const gdpGrowth = took(1, "FMI", empty);
  const unemployment = took(2, "FMI", empty);
  const gdpPc = took(3, "FMI", empty);
  const levels = took<Record<string, { value: number; year: number }>>(4, "Banco Mundial", {});
  const spot = took<Record<string, number>>(5, "open.er-api.com", {});

  for (const s of failedSources) {
    gaps.push(s + " no respondio: los indicadores que dependen de esa fuente quedan sin dato");
  }

  const macro: MacroSnapshot = {
    inflation: iso3 ? latestFrom(inflation[iso3], "% anual") : nullIndicator("% anual"),
    inflationTrailing12m: nullIndicator("% 12m"),
    gdpGrowth: iso3 ? latestFrom(gdpGrowth[iso3], "% anual") : nullIndicator("% anual"),
    unemployment: iso3 ? latestFrom(unemployment[iso3], "% PEA") : nullIndicator("% PEA"),
    gdpPerCapitaPpp: iso3 ? latestFrom(gdpPc[iso3], "USD PPA") : nullIndicator("USD PPA"),
    priceLevel: nullIndicator("EE.UU. = 1.0"),
  };

  const destLevel = iso3 ? levels[iso3] : undefined;
  if (destLevel) {
    macro.priceLevel = {
      value: round(destLevel.value, 3),
      year: destLevel.year,
      projected: false,
      unit: "EE.UU. = 1.0",
    };
  }

  if (!iso3) gaps.push("Sin mapeo ISO3 para " + cc + ": no hay macro del FMI ni del Banco Mundial");
  if (!currency) gaps.push("Sin moneda conocida para " + cc + ": no se puede cruzar contra emisores");

  // ── Emisores ──
  const emitterCodes = emittersFor(cc);
  const destInflation = await trailingInflation12m(cc, macro.inflation.value);

  // Si el acumulado local difiere del promedio anual del FMI, se muestra:
  // el cambio real de la tabla se calcula con este, no con el otro.
  if (destInflation !== null && destInflation !== macro.inflation.value) {
    macro.inflationTrailing12m = {
      value: destInflation,
      year: new Date().getUTCFullYear(),
      projected: false,
      unit: "% 12m",
    };
  }

  // Serie del destino contra USD hace 12 meses: habilita medir destinos que el
  // BCE no publica. null = no hay forma de fechar el cruce hacia atras.
  const destPastPerUsd = currency ? await destPerUsdYearAgo(cc, currency) : null;
  const destSeries = Boolean(currency && (ECB_CURRENCIES.has(currency) || destPastPerUsd));
  const emitters: EmitterView[] = [];

  for (const ec of emitterCodes) {
    const eIso3 = ISO3[ec] ?? null;
    const eCur = CURRENCY[ec] ?? null;
    const eLevel = eIso3 ? levels[eIso3] : undefined;

    const view: EmitterView = {
      countryCode: ec,
      countryName: COUNTRY_NAME[ec] ?? ec,
      currency: eCur ?? "?",
      relativePriceLevel:
        destLevel && eLevel && eLevel.value !== 0
          ? round(destLevel.value / eLevel.value, 3)
          : null,
      fxCross: null,
      nominalChangePct: null,
      realChangePct: null,
      verdict: null,
    };

    if (currency && eCur) {
      // Cruce spot: unidades del emisor por 1 del destino, puenteado por USD.
      const dPerUsd = currency === "USD" ? 1 : spot[currency];
      const ePerUsd = eCur === "USD" ? 1 : spot[eCur];
      if (dPerUsd && ePerUsd) view.fxCross = round(ePerUsd / dPerUsd, 6);

      // El cruce de hace 12 meses sale del BCE cuando publica las dos monedas;
      // si no, se puentea por USD con la serie local del destino.
      let past: number | null = null;
      if (ECB_CURRENCIES.has(currency) && ECB_CURRENCIES.has(eCur)) {
        past = await crossYearAgo(currency, eCur);
      } else if (destPastPerUsd && ECB_CURRENCIES.has(eCur)) {
        const ePerUsdPast = await crossYearAgo("USD", eCur);
        if (ePerUsdPast) past = ePerUsdPast / destPastPerUsd;
      }

      if (past && view.fxCross) {
        view.nominalChangePct = round((view.fxCross / past - 1) * 100, 1);

        const eInflation = eIso3 ? latestFrom(inflation[eIso3], "%").value : null;
        if (destInflation !== null && eInflation !== null) {
          // Costo real para el viajero del emisor: el cruce ajustado por la
          // inflacion de los dos paises.
          const real =
            ((1 + destInflation / 100) / (1 + eInflation / 100)) * (view.fxCross / past) - 1;
          view.realChangePct = round(real * 100, 1);
        }
      } else if (currency === eCur) {
        view.note = "Misma moneda que el destino";
      } else if (!destSeries) {
        // La que falta es la del DESTINO, asi que ningun emisor va a tener
        // serie. Decirlo bien evita que parezca un problema del emisor.
        view.note = "Sin serie historica de " + currency + ": no se puede fechar el cruce";
      } else {
        view.note = "El BCE no publica " + eCur + ": solo spot, sin serie de 12 meses";
      }
    }

    view.verdict = verdictOf(view.realChangePct);
    emitters.push(view);
  }

  // Primero para quien mas se abarato el destino: es el mercado que conviene
  // atacar. Los que no tienen serie van al final, no mezclados en el medio.
  emitters.sort((a, b) => {
    if (a.realChangePct === null && b.realChangePct === null) return 0;
    if (a.realChangePct === null) return 1;
    if (b.realChangePct === null) return -1;
    return a.realChangePct - b.realChangePct;
  });

  const measured = emitters.filter((e) => e.verdict !== null);
  const cheaperFor = measured.filter((e) => e.verdict === "cheaper").length;
  const pricierFor = measured.filter((e) => e.verdict === "pricier").length;
  const best = measured.find((e) => e.verdict === "cheaper") ?? null;

  // Mitad universal del titular: el NIVEL no necesita serie cambiaria, sale
  // del cociente de paridades. Es lo unico que se puede decir de un destino
  // cuyo banco central no publica el BCE (CLP, ARS, UYU, PEN, COP...).
  const withLevel = emitters.filter((e) => e.relativePriceLevel !== null);
  const cheaperThanHome = withLevel.filter((e) => (e.relativePriceLevel as number) < 0.95).length;

  const parallelMarket = cc === "AR" ? await argentineParallel() : null;

  if (!measured.length && emitterCodes.length) {
    gaps.push(
      !destSeries
        ? "Sin serie historica de " +
          currency +
          ": no hay cambio a 12 meses. Queda el nivel de precios, que si es comparable"
        : "Ningun emisor tiene serie cambiaria de 12 meses contra esta moneda",
    );
  }
  if (!hasCuratedEmitters(cc)) {
    gaps.push("Emisores estimados por region: no hay tabla curada para este destino");
  }
  if (cc !== "AR") {
    gaps.push("Brecha cambiaria: solo instrumentada para Argentina");
  }
  gaps.push("Precio de combustible y tarifas aereas: sin API abierta por pais");
  gaps.push("Confianza del consumidor: la OCDE la publica solo para sus miembros");
  gaps.push("Impuestos y subsidios al turismo: no hay registro global, son municipales");

  const coverage: EconomyCoverage = {
    macro: macro.inflation.value !== null,
    fx: emitters.some((e) => e.fxCross !== null),
    emitters: emitters.length > 0,
    curatedEmitters: hasCuratedEmitters(cc),
    parallelMarket: parallelMarket !== null,
    gaps,
  };

  return {
    location: { lat, lng },
    country: {
      code: cc,
      name: COUNTRY_NAME[cc] ?? geo.countryName ?? cc,
      currency: currency ?? "?",
      region: geo.region,
    },
    macro,
    emitters,
    parallelMarket,
    headline: {
      cheaperFor,
      pricierFor,
      measuredAgainst: measured.length,
      bestMarket: best ? best.countryName : null,
      cheaperThanHome,
      levelComparedAgainst: withLevel.length,
    },
    coverage,
    sources: [
      "FMI World Economic Outlook (DataMapper)",
      "Banco Mundial (PPA y tipo de cambio oficial)",
      "BCE via Frankfurter (series cambiarias)",
      "open.er-api.com (spot de monedas fuera del BCE)",
      ...(parallelMarket ? ["dolarapi.com", "argentinadatos.com (INDEC)"] : []),
      "OpenStreetMap Nominatim",
    ],
    timestamp: new Date().toISOString(),
  };
}
