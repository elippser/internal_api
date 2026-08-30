// Efemérides comerciales y fechas de cobro, por país (event-list.md §2).
//
// POR QUÉ ESTÁ CURADO A MANO: ninguna API gratuita las trae. Nager.Date sólo
// devuelve `type: "Public"` (verificado contra AR/2026: 16 feriados, todos
// Public), y estas fechas no dan asueto — pero mueven restaurantes, spa y
// escapadas de fin de semana tanto o más que un feriado.
//
// Y no se pueden derivar de una regla única: el Día de la Madre es el 3er
// domingo de octubre en Argentina, el 1er domingo de mayo en España, el 10 de
// mayo fijo en México y el 4to domingo de Cuaresma en el Reino Unido. El Día
// del Padre cae el 19 de marzo en España e Italia y el 2do domingo de agosto
// en Brasil.
//
// CÓMO MANTENERLO: cada entrada lleva su regla explícita. Si se agrega un
// país, agregar también su fila en OBSERVANCES y PAYDAYS o el hub reportará
// el hueco en `coverage.gaps` (que es el comportamiento correcto: mejor decir
// "no lo sé" que inventar el 2do domingo de mayo para todos).

/** Regla de cálculo de una fecha que no es fija en el calendario gregoriano. */
export type DateRule =
  | { kind: "fixed"; month: number; day: number }
  /** nth: 1-5, o -1 para "el último" del mes. weekday: 0=domingo. */
  | { kind: "nthWeekday"; month: number; weekday: number; nth: number }
  /** Desplazamiento en días respecto del Domingo de Pascua. */
  | { kind: "easterOffset"; days: number };

export interface ObservanceDef {
  key: string;
  name: string;
  rule: DateRule;
  note?: string;
}

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher, calendario gregoriano). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Resuelve una regla a una fecha concreta (YYYY-MM-DD) de ese año. */
export function resolveRule(rule: DateRule, year: number): string {
  if (rule.kind === "fixed") {
    return iso(new Date(Date.UTC(year, rule.month - 1, rule.day)));
  }
  if (rule.kind === "easterOffset") {
    const e = easterSunday(year);
    return iso(new Date(e.getTime() + rule.days * 86_400_000));
  }
  // nthWeekday
  if (rule.nth === -1) {
    const last = new Date(Date.UTC(year, rule.month, 0)); // último día del mes
    const diff = (last.getUTCDay() - rule.weekday + 7) % 7;
    return iso(new Date(last.getTime() - diff * 86_400_000));
  }
  const first = new Date(Date.UTC(year, rule.month - 1, 1));
  const offset = (rule.weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (rule.nth - 1) * 7;
  return iso(new Date(Date.UTC(year, rule.month - 1, day)));
}

// ── Efemérides comerciales por país ───────────────────────────────────────
// Sólo se listan países donde la fecha está verificada. Un país ausente sale
// como hueco declarado, no como una suposición.

const MOTHERS: Record<string, DateRule> = {
  AR: { kind: "nthWeekday", month: 10, weekday: 0, nth: 3 },
  ES: { kind: "nthWeekday", month: 5, weekday: 0, nth: 1 },
  PT: { kind: "nthWeekday", month: 5, weekday: 0, nth: 1 },
  MX: { kind: "fixed", month: 5, day: 10 },
  BR: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  CL: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  UY: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  CO: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  PE: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  US: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  DE: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  IT: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  NL: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  BE: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  AT: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  CH: { kind: "nthWeekday", month: 5, weekday: 0, nth: 2 },
  FR: { kind: "nthWeekday", month: 5, weekday: 0, nth: -1 },
  // Mothering Sunday: 4to domingo de Cuaresma = Pascua − 21 días.
  GB: { kind: "easterOffset", days: -21 },
};

const FATHERS: Record<string, DateRule> = {
  AR: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  ES: { kind: "fixed", month: 3, day: 19 },
  IT: { kind: "fixed", month: 3, day: 19 },
  PT: { kind: "fixed", month: 3, day: 19 },
  BR: { kind: "nthWeekday", month: 8, weekday: 0, nth: 2 },
  MX: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  CL: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  UY: { kind: "nthWeekday", month: 7, weekday: 0, nth: 2 },
  CO: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  PE: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  US: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  GB: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  FR: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  NL: { kind: "nthWeekday", month: 6, weekday: 0, nth: 3 },
  // Vatertag alemán: coincide con la Ascensión (Pascua + 39).
  DE: { kind: "easterOffset", days: 39 },
  AT: { kind: "nthWeekday", month: 6, weekday: 0, nth: 2 },
  BE: { kind: "nthWeekday", month: 6, weekday: 0, nth: 2 },
  CH: { kind: "easterOffset", days: 39 },
};

const CHILDREN: Record<string, DateRule> = {
  AR: { kind: "nthWeekday", month: 8, weekday: 0, nth: 3 },
  MX: { kind: "fixed", month: 4, day: 30 },
  BR: { kind: "fixed", month: 10, day: 12 },
  CL: { kind: "nthWeekday", month: 8, weekday: 0, nth: 2 },
  CO: { kind: "nthWeekday", month: 4, weekday: 6, nth: -1 },
  UY: { kind: "fixed", month: 1, day: 6 },
};

/** San Valentín. Brasil no lo celebra: su fecha es Dia dos Namorados. */
const LOVERS: Record<string, DateRule> = {
  BR: { kind: "fixed", month: 6, day: 12 },
};
const LOVERS_DEFAULT: DateRule = { kind: "fixed", month: 2, day: 14 };

/** Países donde el calendario comercial está verificado. */
export const OBSERVANCE_COUNTRIES = new Set([
  ...Object.keys(MOTHERS),
  ...Object.keys(FATHERS),
  ...Object.keys(CHILDREN),
]);

export function observancesFor(countryCode: string): ObservanceDef[] {
  const cc = countryCode.toUpperCase();
  const out: ObservanceDef[] = [];

  const mother = MOTHERS[cc];
  if (mother) out.push({ key: "mothers-day", name: "Día de la Madre", rule: mother });

  const father = FATHERS[cc];
  if (father) out.push({ key: "fathers-day", name: "Día del Padre", rule: father });

  const child = CHILDREN[cc];
  if (child) out.push({ key: "childrens-day", name: "Día del Niño", rule: child });

  if (OBSERVANCE_COUNTRIES.has(cc)) {
    const lovers = LOVERS[cc] ?? LOVERS_DEFAULT;
    out.push({
      key: "valentines",
      name: cc === "BR" ? "Dia dos Namorados" : "San Valentín",
      rule: lovers,
    });
  }

  return out;
}

// ── Fechas de cobro / aguinaldo ───────────────────────────────────────────
// El aguinaldo es dinero disponible con fecha conocida: mueve escapadas
// cortas en la ventana inmediatamente posterior. Las fechas son las legales
// (tope de pago), no la fecha efectiva de cada empleador.

export interface PaydayDef {
  key: string;
  name: string;
  rule: DateRule;
  note: string;
}

const PAYDAYS: Record<string, PaydayDef[]> = {
  AR: [
    { key: "sac-1", name: "Aguinaldo (1ª cuota)", rule: { kind: "fixed", month: 6, day: 30 }, note: "SAC, tope legal de pago" },
    { key: "sac-2", name: "Aguinaldo (2ª cuota)", rule: { kind: "fixed", month: 12, day: 18 }, note: "SAC, tope legal de pago" },
  ],
  BR: [
    { key: "13-1", name: "13º salário (1ª parcela)", rule: { kind: "fixed", month: 11, day: 30 }, note: "Tope legal de pago" },
    { key: "13-2", name: "13º salário (2ª parcela)", rule: { kind: "fixed", month: 12, day: 20 }, note: "Tope legal de pago" },
  ],
  MX: [
    { key: "aguinaldo", name: "Aguinaldo", rule: { kind: "fixed", month: 12, day: 20 }, note: "Tope legal de pago" },
  ],
  UY: [
    { key: "aguinaldo-1", name: "Aguinaldo (1ª cuota)", rule: { kind: "fixed", month: 6, day: 30 }, note: "Tope legal de pago" },
    { key: "aguinaldo-2", name: "Aguinaldo (2ª cuota)", rule: { kind: "fixed", month: 12, day: 24 }, note: "Tope legal de pago" },
  ],
  CO: [
    { key: "prima-1", name: "Prima de servicios (1ª)", rule: { kind: "fixed", month: 6, day: 30 }, note: "Tope legal de pago" },
    { key: "prima-2", name: "Prima de servicios (2ª)", rule: { kind: "fixed", month: 12, day: 20 }, note: "Tope legal de pago" },
  ],
  PE: [
    { key: "grati-1", name: "Gratificación (Fiestas Patrias)", rule: { kind: "fixed", month: 7, day: 15 }, note: "Tope legal de pago" },
    { key: "grati-2", name: "Gratificación (Navidad)", rule: { kind: "fixed", month: 12, day: 15 }, note: "Tope legal de pago" },
  ],
  ES: [
    { key: "extra-verano", name: "Paga extra de verano", rule: { kind: "fixed", month: 6, day: 30 }, note: "Habitual por convenio, no fecha única legal" },
    { key: "extra-navidad", name: "Paga extra de Navidad", rule: { kind: "fixed", month: 12, day: 22 }, note: "Habitual por convenio, no fecha única legal" },
  ],
};

export function paydaysFor(countryCode: string): PaydayDef[] {
  return PAYDAYS[countryCode.toUpperCase()] ?? [];
}

export const PAYDAY_COUNTRIES = new Set(Object.keys(PAYDAYS));
