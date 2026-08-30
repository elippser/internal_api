// Hub de calendario y feriados (event-list.md §2).
//
// Hermano del hub de clima: se clickea un punto del mapa y devuelve el
// calendario de demanda de ese país para los próximos 12 meses. No persiste
// nada; todo se computa on-demand y se cachea en memoria.
//
// Fuentes:
//   - Nominatim: coordenada → país.
//   - Nager.Date `/PublicHolidays`: feriados oficiales.
//   - Nager.Date `/LongWeekend`: fines de semana largos YA calculados, con
//     los días puente que hay que tomarse. Es la señal más fuerte del §2 y no
//     la estábamos usando (el connector `holidays` sólo trae fechas sueltas).
//   - OpenHolidays `/SchoolHolidays`: recesos escolares (36 países).
//   - Aladhan: Ramadán, Eid al-Fitr y Eid al-Adha del año hijri en curso.
//   - Hebcal: festividades judías mayores.
//   - Tabla curada (`observances.ts`): efemérides comerciales y aguinaldos,
//     que ninguna API gratuita trae.
//
// ESTRATEGIA DE CACHE — es lo que hace viable el hub: el cache NO es por
// punto sino por (país, año). Los feriados de Argentina 2026 son los mismos
// se clickee Salta o Ushuaia, y los mercados emisores y las fiestas móviles
// son los mismos para todos los puntos del planeta. Así el primer click paga
// las llamadas y los siguientes salen casi gratis.

import { fetchJson } from "../intelligence/core/http";
import {
  observancesFor,
  paydaysFor,
  resolveRule,
  easterSunday,
  OBSERVANCE_COUNTRIES,
  PAYDAY_COUNTRIES,
} from "./observances";
import { curatedSchoolBreaks, CURATED_SCHOOL_COUNTRIES } from "./school-calendar";
import type {
  CalendarEntry,
  CalendarCoverage,
  CalendarPointPayload,
  EmitterWindow,
  LongWeekend,
  MoveableFeasts,
  SchoolBreak,
} from "./calendar.types";

const NAGER_BASE = "https://date.nager.at/api/v3";
const OPENHOLIDAYS_BASE = "https://openholidaysapi.org";
const ALADHAN_BASE = "https://api.aladhan.com/v1";
const HEBCAL_BASE = "https://www.hebcal.com/hebcal";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";

/** Mercados emisores cuyos fines de semana largos se cruzan con el destino. */
const EMITTER_CODES = (process.env.IH_CALENDAR_EMITTERS ?? "AR,BR,CL,UY,ES,US")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

/** Latitud aproximada de cada emisor, sólo para saber en qué hemisferio cae
 *  su calendario escolar (un receso de julio es invierno en el sur y verano
 *  en el norte). */
const EMITTER_LAT: Record<string, number> = {
  AR: -34, BR: -15, CL: -33, UY: -33, PE: -10, CO: 4,
  ES: 40, US: 38, MX: 23, DE: 51, FR: 46, IT: 42, GB: 54, PT: 39,
};

/**
 * Países con recesos escolares en OpenHolidays. Verificado contra
 * `/Countries`: Brasil figura en la lista pero `/SchoolHolidays` devuelve 0,
 * así que no se lo cuenta como cubierto.
 */
const SCHOOL_COUNTRIES = new Set([
  "AD", "AL", "AT", "BE", "BG", "BY", "CH", "CZ", "DE", "EE", "ES", "FR", "HR",
  "HU", "IE", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "MT", "MX", "NL", "PL",
  "PT", "RO", "RS", "SE", "SI", "SK", "SM", "VA", "ZA",
]);

const MS_DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

// ── Cache genérico con TTL ────────────────────────────────────────────────

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

// Los feriados de un año no cambian; los decretos de puente, casi nunca.
const TTL_HOLIDAYS = 7 * 24 * 60 * 60 * 1000;
const TTL_GEO = 30 * 24 * 60 * 60 * 1000;

// ── Respuestas upstream ───────────────────────────────────────────────────

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
  counties: string[] | null;
  types?: string[];
}

interface NagerLongWeekend {
  startDate: string;
  endDate: string;
  dayCount: number;
  needBridgeDay: boolean;
  bridgeDays: string[];
}

interface OpenHolidayPeriod {
  startDate: string;
  endDate: string;
  name: Array<{ language: string; text: string }>;
  nationwide: boolean;
  subdivisions?: Array<{ code: string; shortName: string }>;
}

interface AladhanDay {
  gregorian: { date: string }; // DD-MM-YYYY
  hijri: { day: string; month: { number: number }; year: string; holidays?: string[] };
}

interface HebcalItem { date: string; title: string; category: string }

/**
 * Hebcal enumera cada día de las festividades largas: 8 entradas de
 * "Chanukah: N Candles", 9 de "Pesach I..VIII", 7 de "Sukkot". Para demanda
 * hotelera importa el festival como bloque de viaje, no cada jornada, así que
 * se normaliza el título a su nombre base para poder agruparlos en un rango.
 */
function jewishBaseName(title: string): string {
  return title
    .replace(/:\s*\d+\s+Candles?$/i, "")
    .replace(/:\s*\d+(?:st|nd|rd|th)\s+Day$/i, "")
    // El paréntesis va ANTES que el numeral romano: "Sukkot VII (Hoshana
    // Raba)" tiene el VII en el medio y no se agruparía al revés.
    .replace(/\s*\([^)]*\)$/u, "")
    .replace(/\s+[IVX]+$/, "")
    .replace(/\s+\d{4}$/, "") // "Rosh Hashana 5787"
    .trim();
}

/** Agrupa los días sueltos de Hebcal en festividades con inicio y fin. */
function collapseJewish(items: HebcalItem[]): Array<{ date: string; endDate: string; name: string }> {
  const order: string[] = [];
  const byName = new Map<string, string[]>();
  for (const i of items) {
    if (i.category !== "holiday" || /^Erev /.test(i.title)) continue;
    const name = jewishBaseName(i.title);
    if (!byName.has(name)) { byName.set(name, []); order.push(name); }
    byName.get(name)!.push(i.date.slice(0, 10));
  }
  return order.map((name) => {
    const dates = byName.get(name)!.sort();
    return { name, date: dates[0], endDate: dates[dates.length - 1] };
  });
}

// ── Geocoding inverso ─────────────────────────────────────────────────────

async function resolveCountry(lat: number, lng: number) {
  // Grilla de 0.5° (~55 km): un país no cambia dentro de esa celda salvo en
  // fronteras, y recorta muchísimo el tráfico a Nominatim (1 req/s de tope).
  const key = `geo:${lat.toFixed(1)}:${lng.toFixed(1)}`;
  return memo(key, TTL_GEO, async () => {
    const data = await fetchJson<{
      address?: Record<string, string>;
      display_name?: string;
    }>(
      `${NOMINATIM_BASE}?lat=${lat}&lon=${lng}&format=json&zoom=5&addressdetails=1`,
      {
        headers: { "user-agent": "bookfer-internal-calendar-hub/1.0" },
        timeoutMs: 12_000,
        retries: 1,
      },
    );
    const addr = data.address ?? {};
    return {
      countryCode: (addr.country_code ?? "").toUpperCase(),
      countryName: addr.country ?? "",
      region: addr.state ?? addr.region ?? null,
      displayName: data.display_name ?? null,
    };
  });
}

// ── Nager ─────────────────────────────────────────────────────────────────

const publicHolidays = (cc: string, year: number) =>
  memo(`nager:ph:${cc}:${year}`, TTL_HOLIDAYS, () =>
    fetchJson<NagerHoliday[]>(`${NAGER_BASE}/PublicHolidays/${year}/${cc}`, { timeoutMs: 12_000 }),
  );

const longWeekends = (cc: string, year: number) =>
  memo(`nager:lw:${cc}:${year}`, TTL_HOLIDAYS, () =>
    fetchJson<NagerLongWeekend[]>(`${NAGER_BASE}/LongWeekend/${year}/${cc}`, { timeoutMs: 12_000 }),
  );

// ── OpenHolidays ──────────────────────────────────────────────────────────

const pickName = (names: OpenHolidayPeriod["name"]): string =>
  names.find((n) => n.language === "EN")?.text ?? names[0]?.text ?? "School holiday";

/** Clasifica el receso por duración y por el mes en el hemisferio del país. */
function classifyBreak(start: string, days: number, lat: number): SchoolBreak["season"] {
  const month = Number(start.slice(5, 7));
  const south = lat < 0;
  const summerMonths = south ? [12, 1, 2] : [6, 7, 8];
  const winterMonths = south ? [6, 7] : [12, 1, 2];
  if (days >= 25 && summerMonths.includes(month)) return "summer";
  if (winterMonths.includes(month)) return "winter";
  if (days >= 7) return "mid";
  return "other";
}

const spanDays = (start: string, end: string): number =>
  Math.round(
    (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / MS_DAY,
  ) + 1;

/**
 * Recesos escolares del país. Dos orígenes que se complementan:
 *
 *  1. OpenHolidays, cuando cubre al país — es el dato oficial del ministerio.
 *  2. La tabla curada de `school-calendar.ts` para el Cono Sur, que
 *     OpenHolidays no cubre (AR, CL, UY) o cubre sin datos (BR).
 *
 * Si el país tiene las dos cosas gana OpenHolidays y la tabla curada no se
 * usa: no tiene sentido pisar el dato oficial con una regla aproximada.
 */
async function schoolBreaks(
  cc: string,
  lat: number,
  from: string,
  to: string,
  years: number[],
): Promise<SchoolBreak[]> {
  let official: SchoolBreak[] = [];

  if (SCHOOL_COUNTRIES.has(cc)) {
    const periods = await memo(`oh:${cc}:${from}:${to}`, TTL_HOLIDAYS, () =>
      fetchJson<OpenHolidayPeriod[]>(
        `${OPENHOLIDAYS_BASE}/SchoolHolidays?countryIsoCode=${cc}&languageIsoCode=EN&validFrom=${from}&validTo=${to}`,
        { timeoutMs: 15_000 },
      ),
    );
    official = periods
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.startDate))
      .map((p) => {
        const end = p.endDate ?? p.startDate;
        const dayCount = spanDays(p.startDate, end);
        return {
          startDate: p.startDate,
          endDate: end,
          name: pickName(p.name),
          nationwide: p.nationwide,
          subdivisions: (p.subdivisions ?? []).map((s) => s.shortName),
          season: classifyBreak(p.startDate, dayCount, lat),
          dayCount,
          source: "openholidays" as const,
        };
      });
  }

  if (official.length > 0) {
    return official.sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  // Sin dato oficial: cae a la tabla curada, acotada a la ventana.
  return curatedSchoolBreaks(cc, years)
    .filter((b) => b.endDate >= from && b.startDate <= to)
    .map((b) => ({
      startDate: b.startDate,
      endDate: b.endDate,
      name: b.name,
      nationwide: b.subdivisions.length === 0,
      subdivisions: b.subdivisions,
      season: b.season,
      dayCount: spanDays(b.startDate, b.endDate),
      source: "curado" as const,
      precision: b.precision,
      blockLabel: b.blockLabel,
      note: b.note,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ── Fiestas móviles (globales, se cachean una vez para todo el planeta) ───

/** Aladhan devuelve la fecha gregoriana como DD-MM-YYYY. */
const fromAladhan = (d: string): string => {
  const [dd, mm, yyyy] = d.split("-");
  return `${yyyy}-${mm}-${dd}`;
};

async function moveableFeasts(from: string, to: string): Promise<MoveableFeasts> {
  return memo(`moveable:${from}:${to}`, TTL_HOLIDAYS, async () => {
    const settled = await Promise.allSettled([
      // Año hijri vigente al inicio de la ventana.
      fetchJson<{ data?: { hijri?: { year?: string } } }>(
        `${ALADHAN_BASE}/gToH/${from.slice(8, 10)}-${from.slice(5, 7)}-${from.slice(0, 4)}`,
        { timeoutMs: 12_000 },
      ),
      fetchJson<{ items?: HebcalItem[] }>(
        `${HEBCAL_BASE}?v=1&cfg=json&start=${from}&end=${to}&maj=on&min=off&mod=off&nx=off&ss=off&mf=off&c=off`,
        { timeoutMs: 12_000 },
      ),
    ]);

    const hijriYear = Number(
      settled[0].status === "fulfilled" ? settled[0].value.data?.hijri?.year : NaN,
    );

    let ramadan: MoveableFeasts["ramadan"] = null;
    let eidAlFitr: string | null = null;
    let eidAlAdha: string | null = null;

    if (Number.isFinite(hijriYear)) {
      const months = await Promise.allSettled([
        fetchJson<{ data?: AladhanDay[] }>(`${ALADHAN_BASE}/hToGCalendar/9/${hijriYear}`, { timeoutMs: 15_000 }),
        fetchJson<{ data?: AladhanDay[] }>(`${ALADHAN_BASE}/hToGCalendar/10/${hijriYear}`, { timeoutMs: 15_000 }),
        fetchJson<{ data?: AladhanDay[] }>(`${ALADHAN_BASE}/hToGCalendar/12/${hijriYear}`, { timeoutMs: 15_000 }),
      ]);

      const days = (i: number): AladhanDay[] =>
        months[i].status === "fulfilled"
          ? ((months[i] as PromiseFulfilledResult<{ data?: AladhanDay[] }>).value.data ?? [])
          : [];

      const ram = days(0);
      if (ram.length) {
        ramadan = {
          start: fromAladhan(ram[0].gregorian.date),
          end: fromAladhan(ram[ram.length - 1].gregorian.date),
          hijriYear,
        };
      }
      // Eid al-Fitr = 1 de Shawwal; Eid al-Adha = 10 de Dhul Hiyya.
      const shawwal1 = days(1).find((d) => Number(d.hijri.day) === 1);
      if (shawwal1) eidAlFitr = fromAladhan(shawwal1.gregorian.date);
      const dhul10 = days(2).find((d) => Number(d.hijri.day) === 10);
      if (dhul10) eidAlAdha = fromAladhan(dhul10.gregorian.date);
    }

    const jewish =
      settled[1].status === "fulfilled"
        ? collapseJewish(settled[1].value.items ?? [])
        : [];

    // Pascua: puede caer en cualquiera de los dos años de la ventana.
    const years = [Number(from.slice(0, 4)), Number(to.slice(0, 4))];
    let easter: MoveableFeasts["easter"] = null;
    for (const y of [...new Set(years)]) {
      const e = easterSunday(y);
      const date = iso(e);
      if (date >= from && date <= to) {
        easter = {
          date,
          goodFriday: iso(new Date(e.getTime() - 2 * MS_DAY)),
          ascension: iso(new Date(e.getTime() + 39 * MS_DAY)),
          pentecost: iso(new Date(e.getTime() + 49 * MS_DAY)),
        };
        break;
      }
    }

    return { ramadan, eidAlFitr, eidAlAdha, jewish, easter };
  });
}

// ── Servicio principal ────────────────────────────────────────────────────

/** Fines de semana largos de un país acotados a la ventana. */
async function longWeekendsInWindow(
  cc: string,
  years: number[],
  from: string,
  to: string,
  holidaysByDate: Map<string, string>,
): Promise<LongWeekend[]> {
  const settled = await Promise.allSettled(years.map((y) => longWeekends(cc, y)));
  const out: LongWeekend[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const lw of r.value) {
      if (lw.endDate < from || lw.startDate > to) continue;
      // Qué feriados lo originan: recorre el rango y cruza con la lista real.
      const names: string[] = [];
      for (
        let t = new Date(`${lw.startDate}T00:00:00Z`).getTime();
        t <= new Date(`${lw.endDate}T00:00:00Z`).getTime();
        t += MS_DAY
      ) {
        const name = holidaysByDate.get(iso(new Date(t)));
        if (name && !names.includes(name)) names.push(name);
      }
      out.push({ ...lw, holidays: names });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export async function getCalendarPoint(lat: number, lng: number): Promise<CalendarPointPayload> {
  const geo = await resolveCountry(lat, lng);
  if (!geo.countryCode) {
    throw new Error("No se pudo determinar el país de esa coordenada (¿océano?)");
  }
  const cc = geo.countryCode;

  const now = new Date();
  const from = iso(now);
  const to = iso(new Date(now.getTime() + 365 * MS_DAY));
  const years = [...new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))])];

  const [phSettled, moveable, breaks] = await Promise.all([
    Promise.allSettled(years.map((y) => publicHolidays(cc, y))),
    moveableFeasts(from, to).catch(() => ({
      ramadan: null, eidAlFitr: null, eidAlAdha: null, jewish: [], easter: null,
    })),
    schoolBreaks(cc, lat, from, to, years).catch(() => [] as SchoolBreak[]),
  ]);

  // ── Feriados oficiales ──
  const entries: CalendarEntry[] = [];
  const holidaysByDate = new Map<string, string>();
  let holidaysOk = false;

  for (const r of phSettled) {
    if (r.status !== "fulfilled") continue;
    holidaysOk = true;
    for (const h of r.value) {
      if (h.date < from || h.date > to) continue;
      holidaysByDate.set(h.date, h.localName);
      entries.push({
        date: h.date,
        endDate: null,
        name: h.localName,
        kind: "public",
        nationwide: h.global,
        subdivisions: h.counties ?? undefined,
        weekday: weekdayOf(h.date),
        source: "Nager.Date",
        ...(h.localName !== h.name ? { note: h.name } : {}),
      });
    }
  }

  // ── Efemérides comerciales (curadas) ──
  const obsDefs = observancesFor(cc);
  for (const year of years) {
    for (const o of obsDefs) {
      const date = resolveRule(o.rule, year);
      if (date < from || date > to) continue;
      entries.push({
        date,
        endDate: null,
        name: o.name,
        kind: "observance",
        nationwide: true,
        weekday: weekdayOf(date),
        source: "curado",
        curated: true,
        ...(o.note ? { note: o.note } : {}),
      });
    }
  }

  // ── Fechas de cobro (curadas) ──
  const payDefs = paydaysFor(cc);
  for (const year of years) {
    for (const p of payDefs) {
      const date = resolveRule(p.rule, year);
      if (date < from || date > to) continue;
      entries.push({
        date,
        endDate: null,
        name: p.name,
        kind: "payday",
        nationwide: true,
        weekday: weekdayOf(date),
        source: "curado",
        curated: true,
        note: p.note,
      });
    }
  }

  // ── Fiestas móviles religiosas ──
  if (moveable.ramadan) {
    entries.push({
      date: moveable.ramadan.start,
      endDate: moveable.ramadan.end,
      name: `Ramadán ${moveable.ramadan.hijriYear} AH`,
      kind: "religious",
      nationwide: true,
      weekday: weekdayOf(moveable.ramadan.start),
      source: "Aladhan",
      note: "Mercados emisores musulmanes: baja durante el mes, pico en Eid",
    });
  }
  for (const [date, name] of [
    [moveable.eidAlFitr, "Eid al-Fitr"],
    [moveable.eidAlAdha, "Eid al-Adha"],
  ] as const) {
    if (!date || date < from || date > to) continue;
    entries.push({
      date, endDate: null, name, kind: "religious", nationwide: true,
      weekday: weekdayOf(date), source: "Aladhan",
    });
  }
  for (const j of moveable.jewish) {
    if (j.date < from || j.date > to) continue;
    entries.push({
      date: j.date,
      endDate: j.endDate !== j.date ? j.endDate : null,
      name: j.name,
      kind: "religious",
      nationwide: true,
      weekday: weekdayOf(j.date),
      source: "Hebcal",
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

  // ── Fines de semana largos: destino + emisores ──
  const destLongWeekends = await longWeekendsInWindow(cc, years, from, to, holidaysByDate);

  const emitterCodes = EMITTER_CODES.filter((e) => e !== cc);
  const emitters: EmitterWindow[] = [];
  await Promise.allSettled(
    emitterCodes.map(async (e) => {
      try {
        const [lws, phs] = await Promise.all([
          longWeekendsInWindow(e, years, from, to, new Map()),
          Promise.allSettled(years.map((y) => publicHolidays(e, y))),
        ]);
        // Renombra los feriados del emisor con su propia lista.
        const byDate = new Map<string, string>();
        for (const r of phs) {
          if (r.status !== "fulfilled") continue;
          for (const h of r.value) byDate.set(h.date, h.localName);
        }
        for (const lw of lws) {
          const names: string[] = [];
          for (
            let t = new Date(`${lw.startDate}T00:00:00Z`).getTime();
            t <= new Date(`${lw.endDate}T00:00:00Z`).getTime();
            t += MS_DAY
          ) {
            const n = byDate.get(iso(new Date(t)));
            if (n && !names.includes(n)) names.push(n);
          }
          lw.holidays = names;
        }
        emitters.push({
          countryCode: e,
          countryName: e,
          longWeekends: lws,
          // El emisor se clasifica por su propio hemisferio: usar lat 0 daría
          // "invierno" a un receso de julio brasileño, que es lo contrario.
          schoolBreaks: await schoolBreaks(e, EMITTER_LAT[e] ?? 0, from, to, years).catch(() => []),
        });
      } catch {
        /* un emisor caído no invalida el resto */
      }
    }),
  );
  emitters.sort((a, b) => a.countryCode.localeCompare(b.countryCode));

  // ── Cobertura declarada ──
  const gaps: string[] = [];
  if (!holidaysOk) gaps.push(`Nager.Date no tiene feriados para ${cc}`);
  const curatedSchool = breaks.some((b) => b.source === "curado");
  if (breaks.length === 0) {
    if (!SCHOOL_COUNTRIES.has(cc) && !CURATED_SCHOOL_COUNTRIES.has(cc)) {
      gaps.push(`Sin calendario escolar para ${cc}: no está en OpenHolidays ni curado`);
    } else {
      // Distinto de "no cubierto": el país está en OpenHolidays pero su
      // ministerio todavía no publicó el ciclo lectivo que cae en la ventana.
      // Medido en España: 166 períodos para 2025/26 y 1 solo desde julio 2026.
      gaps.push(
        `${cc} está en OpenHolidays pero el ciclo lectivo de esta ventana todavía no fue publicado`,
      );
    }
  } else if (curatedSchool) {
    const approx = breaks.filter((b) => b.precision === "approximate").length;
    gaps.push(
      `Calendario escolar de ${cc} por tabla curada (OpenHolidays no lo cubre)` +
        `${approx > 0 ? `; ${approx} ventana(s) de verano son estimadas` : ""}`,
    );
  }
  if (!OBSERVANCE_COUNTRIES.has(cc)) {
    gaps.push(`Sin efemérides curadas para ${cc} (día de la madre/padre/niño)`);
  }
  if (!PAYDAY_COUNTRIES.has(cc)) gaps.push(`Sin fechas de aguinaldo curadas para ${cc}`);

  const coverage: CalendarCoverage = {
    publicHolidays: holidaysOk,
    longWeekends: destLongWeekends.length > 0,
    schoolHolidays: breaks.length > 0,
    observances: OBSERVANCE_COUNTRIES.has(cc),
    paydays: PAYDAY_COUNTRIES.has(cc),
    gaps,
  };

  return {
    location: {
      lat, lng,
      countryCode: cc,
      countryName: geo.countryName,
      region: geo.region,
      displayName: geo.displayName,
    },
    window: { from, to },
    entries,
    longWeekends: destLongWeekends,
    schoolBreaks: breaks,
    emitters,
    moveable,
    coverage,
    sources: [
      "Nager.Date (feriados + fines de semana largos)",
      "OpenHolidays (recesos escolares)",
      "Aladhan (calendario hijri)",
      "Hebcal (calendario hebreo)",
      "Tabla curada (efemérides, aguinaldos y calendario escolar del Cono Sur)",
    ],
    timestamp: new Date().toISOString(),
  };
}
