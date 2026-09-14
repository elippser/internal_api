/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DIAGNÓSTICO DEL CALENDARIO DEL MOTOR DE RESERVAS — lo que ve el huésped.
 *
 * Por qué existe: el 13-09-2026 un hotelero preguntó por qué en su web no podía
 * elegir noviembre. El agente leyó engine-settings, restricciones, tarifas y el
 * calendario interno —todo "bien"— y terminó culpando a la web sin poder decir
 * qué la bloqueaba. Lo que bloqueaba era una REGLA DEL FRONT: con la llegada ya
 * elegida, el datepicker validaba los días posteriores como salida y la estadía
 * máxima del motor (30 noches) los dejaba deshabilitados, con precio y cupo a la
 * vista. Ningún endpoint del PMS expone esa regla, así que ninguna tool la veía.
 *
 * Esta tool lee lo mismo que la web (GET /api/v1/availability/public-calendar,
 * el endpoint público del motor) y aplica las MISMAS reglas del datepicker para
 * contestar, en tramos de días: ¿se puede llegar?, ¿hasta cuándo se puede salir?
 * y, si no, POR QUÉ y qué ajuste lo gobierna.
 *
 * Las reglas son ESPEJO de `calendarInfo.ts` del web-renderer (el original) y de
 * sus copias en el builder y en web-engine-public. `npm run
 * verify:engine-calendar-mirror` corre una matriz de escenarios contra las
 * copias del front y contra esta, y falla si alguna decide distinto.
 */
import { pmsRequest } from "../../../shared/middleware/pmsProxy";

export const ENGINE_DIAGNOSIS_TOOLS = new Set(["diagnose_booking_calendar"]);

export class EngineDiagnosisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineDiagnosisError";
  }
}

// ── Contrato del calendario público (espejo de calendarInfo.ts) ──────────────

export interface PublicCalendarDay {
  date: string;
  available: boolean;
  units: number | null;
  closed: boolean;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  min_stay: number | null;
  max_stay: number | null;
  rate_from: number | null;
}

export interface CalendarDisplay {
  enabled: boolean;
  showPrices: boolean;
  showUnits: boolean;
  showRestrictionFlags: boolean;
  showStayHints: boolean;
  minDate: string;
  engineMinNights: number;
  engineMaxNights: number;
}

export interface PublicCalendarData {
  currency: string;
  display: CalendarDisplay;
  days: Record<string, PublicCalendarDay>;
}

/** Suma `n` días a un ISO YYYY-MM-DD (día civil local). */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + n);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** ¿Se puede INICIAR una estadía este día? (check-in). */
export function canStartStay(iso: string, data: PublicCalendarData): boolean {
  const d = data.days[iso];
  if (!d) return true; // sin dato = no bloquear (mejora progresiva)
  return d.available && !d.closed_to_arrival;
}

/** Ventana de salidas válidas para una entrada dada. */
export function checkoutBounds(
  ciIso: string,
  data: PublicCalendarData,
): { minCo: string; maxCo: string } {
  const ci = data.days[ciIso];
  const engineMin = data.display.engineMinNights || 1;
  const engineMax = data.display.engineMaxNights || 365;
  const minNights = Math.max(ci?.min_stay ?? 1, engineMin, 1);
  const maxNights = Math.min(ci?.max_stay ?? Infinity, engineMax);
  const cappedMax = Number.isFinite(maxNights) ? (maxNights as number) : 365;

  let maxCo = addDaysIso(ciIso, cappedMax);
  for (let i = 1; i < cappedMax; i++) {
    const nightIso = addDaysIso(ciIso, i);
    const night = data.days[nightIso];
    if (night && !night.available) {
      maxCo = nightIso;
      break;
    }
  }
  return { minCo: addDaysIso(ciIso, minNights), maxCo };
}

/** ¿Es un check-out válido para la entrada dada? */
export function isValidCheckout(iso: string, ciIso: string, data: PublicCalendarData): boolean {
  if (iso <= ciIso) return false;
  const d = data.days[iso];
  if (d?.closed_to_departure) return false;
  const { minCo, maxCo } = checkoutBounds(ciIso, data);
  return iso >= minCo && iso <= maxCo;
}

/** ¿Un click en este día, con la entrada fijada, elige la SALIDA? */
export function picksCheckout(
  iso: string,
  ciIso: string | null | undefined,
  data: PublicCalendarData | null | undefined,
): boolean {
  if (!ciIso || iso <= ciIso) return false;
  if (!data) return true;
  return iso <= checkoutBounds(ciIso, data).maxCo;
}

/**
 * Lo que hace el datepicker de la web con un día: la composición de
 * BookingEngineRenderer (fecha mínima + gating informativo). `ciIso` es la
 * entrada ya fijada (modo salida) o null (modo llegada).
 */
export function dayDecision(
  iso: string,
  ciIso: string | null,
  data: PublicCalendarData,
): { blocked: boolean; as: "arrival" | "departure" } {
  const as = ciIso && picksCheckout(iso, ciIso, data) ? "departure" : "arrival";
  const beforeMin = iso < data.display.minDate;
  let vxBlocked = false;
  if (data.days[iso]) {
    vxBlocked = as === "departure"
      ? !isValidCheckout(iso, ciIso as string, data)
      : !canStartStay(iso, data);
  }
  return { blocked: beforeMin || vxBlocked, as };
}

// ── Motivos ──────────────────────────────────────────────────────────────────

const REASONS = {
  before_min_date: "antes de la primera fecha reservable (anticipación mínima)",
  no_availability: "sin cupo o cerrado a la venta",
  closed_to_arrival: "llegada cerrada ese día (CTA)",
  closed_to_departure: "salida cerrada ese día (CTD)",
  before_min_stay: "no llega a la estadía mínima",
} as const;
type ReasonCode = keyof typeof REASONS;

function arrivalReason(iso: string, data: PublicCalendarData): ReasonCode | null {
  if (iso < data.display.minDate) return "before_min_date";
  const d = data.days[iso];
  if (!d) return null;
  if (!d.available) return "no_availability";
  if (d.closed_to_arrival) return "closed_to_arrival";
  return null;
}

/** Solo para días que `picksCheckout` toma como salida. */
function departureReason(iso: string, ciIso: string, data: PublicCalendarData): ReasonCode | null {
  const d = data.days[iso];
  if (!d) return null;
  if (d.closed_to_departure) return "closed_to_departure";
  if (iso < checkoutBounds(ciIso, data).minCo) return "before_min_stay";
  return null;
}

interface DayRow {
  date: string;
  key: string;
  selectable: boolean;
  as: "arrival" | "departure";
  reason?: string;
}

interface Span {
  from: string;
  to: string;
  days: number;
  selectable: boolean;
  as: "arrival" | "departure";
  reason?: string;
}

const MAX_SPANS = 40;

function toSpans(rows: DayRow[]): { spans: Span[]; truncated: boolean } {
  const spans: Span[] = [];
  let current: (Span & { key: string }) | null = null;
  for (const r of rows) {
    if (current && current.key === r.key && addDaysIso(current.to, 1) === r.date) {
      current.to = r.date;
      current.days++;
      continue;
    }
    if (current) {
      const { key: _key, ...span } = current;
      spans.push(span);
    }
    current = { key: r.key, from: r.date, to: r.date, days: 1, selectable: r.selectable, as: r.as, ...(r.reason ? { reason: r.reason } : {}) };
  }
  if (current) {
    const { key: _key, ...span } = current;
    spans.push(span);
  }
  return { spans: spans.slice(0, MAX_SPANS), truncated: spans.length > MAX_SPANS };
}

// ── Lecturas ─────────────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/** El endpoint público acepta hasta 120 días de diferencia entre start y end. */
const CHUNK_DAYS = 120;
const MAX_SPAN_DAYS = 366;

function isoArg(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !ISO_RE.test(v.trim())) {
    throw new EngineDiagnosisError(`"${name}" tiene que ser una fecha YYYY-MM-DD. Recibido: ${JSON.stringify(v)}.`);
  }
  return v.trim();
}

function intArg(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function localTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000);
}

interface Ctx {
  propertyId?: string;
  agentJwt?: string;
}

async function loadPublicCalendar(
  propertyId: string,
  from: string,
  to: string,
  adults: number,
  children: number,
): Promise<PublicCalendarData | null> {
  const days: Record<string, PublicCalendarDay> = {};
  let display: CalendarDisplay | null = null;
  let currency = "";
  for (let start = from; start <= to; ) {
    const candidate = addDaysIso(start, CHUNK_DAYS);
    const end = candidate < to ? candidate : to;
    const resp = await pmsRequest<any>({
      service: "booking-app",
      method: "GET",
      path: "/api/v1/availability/public-calendar",
      query: { propertyId, start, end, adults, children },
      timeoutMs: 20000,
    });
    // enabled:false = calendario informativo apagado o migración activa.
    if (!resp || resp.enabled === false) return null;
    display = resp.display ?? display;
    currency = resp.currency ?? currency;
    for (const d of Array.isArray(resp.days) ? resp.days : []) days[d.date] = d;
    start = addDaysIso(end, 1);
  }
  return display ? { currency, display, days } : null;
}

async function readEngineSettings(propertyId: string, ctx: Ctx): Promise<any | null> {
  if (!ctx.agentJwt) return null;
  try {
    return await pmsRequest<any>({
      service: "booking-app",
      method: "GET",
      path: "/api/v1/engine-settings",
      query: { propertyId },
      agentJwt: ctx.agentJwt,
      timeoutMs: 10000,
    });
  } catch {
    return null;
  }
}

/**
 * Config del Estudio del Motor de un sitio con los defaults aplicados.
 *
 * El GET devuelve `null` cuando el hotelero nunca personalizó el estudio, y el
 * 13-09-2026 el agente lo leyó como "la consulta devolvió vacío, no pude leer la
 * configuración". No es un error: rigen los defaults. Espejo del bloque
 * `calendar` de `normalizeEngineStudioConfig` (engine-studio/engineStudioTypes.ts
 * del web-renderer); lo cubre verify:engine-calendar-mirror.
 */
export function describeEngineStudio(raw: unknown): {
  configured: boolean;
  note: string;
  effective: { calendar: Record<string, boolean> };
  config: Record<string, unknown> | null;
} {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const cal =
    cfg?.calendar && typeof cfg.calendar === "object" && !Array.isArray(cfg.calendar)
      ? (cfg.calendar as Record<string, unknown>)
      : {};
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const calendar = {
    enabled: bool(cal.enabled, true),
    showPrices: bool(cal.showPrices, true),
    showUnits: bool(cal.showUnits, true),
    showStatusDots: bool(cal.showStatusDots, true),
    showRestrictionFlags: bool(cal.showRestrictionFlags, true),
    showStayHints: bool(cal.showStayHints, true),
  };
  return {
    configured: Boolean(cfg),
    note: cfg
      ? "Config guardada del Estudio del Motor. `effective` es como se comporta la web con los valores por defecto aplicados a lo que no está guardado."
      : "Este sitio nunca personalizó el Estudio del Motor: la lectura funcionó y devolvió vacío, NO es un error. La web usa los valores por defecto que muestra `effective`.",
    effective: { calendar },
    config: cfg,
  };
}

async function readEngineStudio(siteId: string, subSiteId: string, ctx: Ctx): Promise<unknown> {
  try {
    const raw = await pmsRequest<any>({
      service: "pms-core",
      method: "GET",
      path: `/site-data/subsite/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}/engine-studio`,
      agentJwt: ctx.agentJwt,
      timeoutMs: 10000,
    });
    return describeEngineStudio(raw);
  } catch (err) {
    return { error: `No se pudo leer el Estudio del Motor del sitio: ${(err as Error).message}` };
  }
}

// ── Explicación de la ventana de estadía ─────────────────────────────────────

function explainWindow(ciIso: string, data: PublicCalendarData, bounds: { minCo: string; maxCo: string }) {
  const ciDay = data.days[ciIso];
  const engineMin = data.display.engineMinNights || 1;
  const engineMax = data.display.engineMaxNights || 365;
  const dayMin = ciDay?.min_stay ?? null;
  const dayMax = ciDay?.max_stay ?? null;
  const minNights = daysBetween(ciIso, bounds.minCo);
  const maxNights = daysBetween(ciIso, bounds.maxCo);
  const cap = Math.min(dayMax ?? Infinity, engineMax);
  const capped = Number.isFinite(cap) ? cap : 365;

  let maxLimit: string;
  if (maxNights < capped) {
    maxLimit =
      `la noche del ${bounds.maxCo} no tiene cupo o está cerrada a la venta y una estadía no puede atravesarla ` +
      `(ver get_availability_calendar y list_day_restrictions)`;
  } else if (dayMax != null && dayMax < engineMax) {
    maxLimit = `la estadía máxima cargada para llegadas el ${ciIso}: ${dayMax} noches (list_day_restrictions)`;
  } else {
    maxLimit = `la estadía máxima del motor: ${engineMax} noches (ajuste maxNights de update_engine_settings)`;
  }

  let minLimit: string | null = null;
  if (minNights > 1) {
    minLimit =
      dayMin != null && dayMin >= engineMin
        ? `la estadía mínima cargada para llegadas el ${ciIso}: ${dayMin} noches (list_day_restrictions)`
        : `la estadía mínima del motor: ${engineMin} noches (ajuste minNights)`;
  }
  return { minNights, maxNights, minLimit, maxLimit };
}

function listSpans(spans: Span[], max = 5): string {
  const shown = spans.slice(0, max).map((s) =>
    `${s.from === s.to ? s.from : `${s.from} a ${s.to}`}${s.reason ? ` (${s.reason})` : ""}`,
  );
  return shown.join("; ") + (spans.length > max ? `; y ${spans.length - max} tramo(s) más` : "");
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export async function runEngineDiagnosisTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  ctx: Ctx,
): Promise<unknown> {
  if (!ENGINE_DIAGNOSIS_TOOLS.has(toolName)) {
    throw new EngineDiagnosisError(`Diagnóstico desconocido: ${toolName}`);
  }
  const args = rawArgs ?? {};
  const propertyId =
    (typeof args.propertyId === "string" && args.propertyId.trim()) || ctx.propertyId;
  if (!propertyId) {
    throw new EngineDiagnosisError(
      "Falta la propiedad. Usá list_properties y confirmá con el usuario cuál revisar.",
    );
  }

  const today = localTodayIso();
  const checkInArg = isoArg(args.checkIn, "checkIn");
  const from = isoArg(args.from, "from") ?? (checkInArg && checkInArg < today ? checkInArg : today);
  const to = isoArg(args.to, "to") ?? addDaysIso(from, 182);
  if (to < from) throw new EngineDiagnosisError(`"to" (${to}) es anterior a "from" (${from}).`);
  if (daysBetween(from, to) > MAX_SPAN_DAYS) {
    throw new EngineDiagnosisError(`El tramo máximo es de ${MAX_SPAN_DAYS} días. Acotá "from"/"to".`);
  }
  const adults = intArg(args.adults, 2, 1, 50);
  const children = intArg(args.children, 0, 0, 50);
  const siteId = typeof args.siteId === "string" ? args.siteId.trim() : "";
  const subSiteId = typeof args.subSiteId === "string" ? args.subSiteId.trim() : "";

  const [data, settings, site] = await Promise.all([
    loadPublicCalendar(propertyId, from, to, adults, children),
    readEngineSettings(propertyId, ctx),
    siteId && subSiteId ? readEngineStudio(siteId, subSiteId, ctx) : Promise.resolve(null),
  ]);

  const findings: string[] = [];
  const siteCalendarOff = (site as any)?.effective?.calendar?.enabled === false;
  if (siteCalendarOff) {
    findings.push(
      "El Estudio del Motor de este sitio tiene APAGADO el calendario informativo: la web no muestra cupo ni precio por día y no bloquea fechas por disponibilidad ni por estadía.",
    );
  }
  const siteInfo = site ?? "no revisado: pasá siteId y subSiteId (list_property_sites) para ver el Estudio del Motor del sitio";

  if (!data) {
    findings.unshift(
      "El calendario informativo del motor está APAGADO (engine-settings calendarInfo.enabled = false) o hay una migración estructural en curso: " +
        "la web muestra un selector de fechas común que no bloquea días por cupo, cierres ni estadía. Si el huésped igual no puede elegir fechas, la causa no está en la disponibilidad.",
    );
    return {
      propertyId,
      range: { from, to },
      guests: { adults, children },
      engine: { informativeCalendar: false, settings },
      site: siteInfo,
      findings,
    };
  }

  const minDate = data.display.minDate;
  const anticipation = typeof settings?.minAnticipationHours === "number" ? settings.minAnticipationHours : null;
  if (anticipation && anticipation > 0) {
    findings.push(`La primera llegada posible es el ${minDate} por la anticipación mínima de ${anticipation} h (minAnticipationHours).`);
  }

  // Llegada: qué días admiten iniciar una estadía.
  const arrivalRows: DayRow[] = [];
  for (let iso = from; iso <= to; iso = addDaysIso(iso, 1)) {
    const r = arrivalReason(iso, data);
    arrivalRows.push({ date: iso, key: r ?? "ok", selectable: !r, as: "arrival", ...(r ? { reason: REASONS[r] } : {}) });
  }
  const arrival = toSpans(arrivalRows);
  const blockedArrival = arrival.spans.filter((s) => !s.selectable);
  findings.push(
    blockedArrival.length === 0
      ? `Llegada: se puede elegir cualquier día del ${from} al ${to}.`
      : `Llegada: estos días no se pueden elegir — ${listSpans(blockedArrival)}.`,
  );

  // Estadía desde la llegada elegida (o la de la web por defecto: hoy).
  const checkIn = checkInArg ?? (minDate > today ? minDate : today);
  const usingDefault = !checkInArg;
  const ciReason = arrivalReason(checkIn, data);
  if (ciReason) {
    findings.push(`La llegada ${checkIn} no se puede elegir: ${REASONS[ciReason]}.`);
  }
  const bounds = checkoutBounds(checkIn, data);
  const limits = explainWindow(checkIn, data, bounds);
  const departureRows: DayRow[] = [];
  for (let iso = addDaysIso(checkIn, 1); iso <= to; iso = addDaysIso(iso, 1)) {
    if (picksCheckout(iso, checkIn, data)) {
      const r = departureReason(iso, checkIn, data);
      departureRows.push({ date: iso, key: r ?? "departure_ok", selectable: !r, as: "departure", ...(r ? { reason: REASONS[r] } : {}) });
    } else {
      const r = arrivalReason(iso, data);
      departureRows.push({
        date: iso,
        key: `new_arrival:${r ?? "ok"}`,
        selectable: !r,
        as: "arrival",
        reason: r
          ? `fuera de la estadía máxima de esa llegada y tampoco admite llegada: ${REASONS[r]}`
          : "fuera de la estadía máxima de esa llegada: un click arranca una estadía nueva",
      });
    }
  }
  const departures = toSpans(departureRows);

  findings.push(
    `${usingDefault ? `Con la llegada por defecto de la web (${checkIn})` : `Con llegada el ${checkIn}`}, ` +
      `la salida puede ir del ${bounds.minCo} al ${bounds.maxCo} (máximo ${limits.maxNights} noches). El tope lo pone ${limits.maxLimit}.`,
  );
  if (limits.minLimit) findings.push(`La salida mínima es el ${bounds.minCo} por ${limits.minLimit}.`);
  if (bounds.maxCo < to) {
    findings.push(
      `Después del ${bounds.maxCo} ningún día sirve como salida de esa llegada. Con el calendario actual del motor, tocar uno de esos días arranca una estadía nueva; ` +
        `en las versiones anteriores al 13-09-2026 esos días quedaban DESHABILITADOS mostrando precio y cupo, y el huésped tenía que volver a tocar "Llegada" para elegirlos. ` +
        `Si el hotel quiere permitir estadías más largas, el ajuste es la estadía máxima.`,
    );
  }

  return {
    propertyId,
    range: { from, to },
    guests: { adults, children },
    engine: {
      informativeCalendar: true,
      minDate,
      minNights: data.display.engineMinNights,
      maxNights: data.display.engineMaxNights,
      minAnticipationHours: anticipation,
      currency: data.currency,
    },
    site: siteInfo,
    arrival: { spans: arrival.spans, truncated: arrival.truncated },
    stay: {
      checkIn,
      defaultCheckIn: usingDefault,
      minCheckout: bounds.minCo,
      maxCheckout: bounds.maxCo,
      maxNights: limits.maxNights,
      maxLimit: limits.maxLimit,
      minLimit: limits.minLimit,
      spans: departures.spans,
      truncated: departures.truncated,
    },
    findings,
  };
}
