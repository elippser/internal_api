/**
 * Formateo de la tarjeta y del bloque del modelo.
 *
 * Los valores salen del servidor YA formateados: el front no redondea ni
 * convierte nada, y el modelo recibe exactamente lo mismo que se ve. Así no
 * existen dos versiones del mismo número.
 */

export const MS_DAY = 86_400_000;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const MONTH_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export function addDaysIso(isoDate: string, days: number): string {
  return isoDay(new Date(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) + days * MS_DAY));
}

export const deaccent = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function parts(isoDate: string): { y: number; m: number; d: number } {
  return {
    y: Number(isoDate.slice(0, 4)),
    m: Number(isoDate.slice(5, 7)),
    d: Number(isoDate.slice(8, 10)),
  };
}

/** "12 oct" */
export function dayMonth(isoDate: string): string {
  const { m, d } = parts(isoDate);
  return `${d} ${MONTHS[m - 1] ?? "?"}`;
}

/** "10–13 oct", "30 sep – 2 oct", "12 oct" */
export function dateRange(start: string, end?: string | null): string {
  if (!end || end.slice(0, 10) === start.slice(0, 10)) return dayMonth(start);
  const a = parts(start);
  const b = parts(end);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1] ?? "?"}`;
  return `${dayMonth(start)} – ${dayMonth(end)}`;
}

/**
 * Meses sueltos a tramos legibles: [12,1,2] → "dic–feb", [3,4,10,11] →
 * "mar–abr · oct–nov". El tramo que cruza el año se une.
 */
export function monthSpans(months: readonly number[]): string {
  const set = [...new Set(months.filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
  if (set.length === 0) return "";
  if (set.length === 12) return "todo el año";
  const runs: number[][] = [];
  for (const m of set) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === m - 1) last.push(m);
    else runs.push([m]);
  }
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][runs[runs.length - 1].length - 1] === 12) {
    const first = runs.shift() as number[];
    runs[runs.length - 1].push(...first);
  }
  return runs
    .map((r) => (r.length === 1 ? MONTHS[r[0] - 1] : `${MONTHS[r[0] - 1]}–${MONTHS[r[r.length - 1] - 1]}`))
    .join(" · ");
}

/** "180 m", "1,2 km", "13 km" */
export function distanceText(meters: number): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1).replace(".", ",")} km` : `${Math.round(km)} km`;
}

/** Distancia de un evento, en km enteros: "a 12 km", o "en la misma zona" si cae encima. */
export function kmAway(km: number): string {
  return km < 1 ? "en la misma zona" : `a ${km} km`;
}

/** "12.400" */
export function thousands(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "+32%", "−12%" (signo menos tipográfico), "0%" */
export function signedPct(n: number): string {
  if (n > 0) return `+${n}%`;
  if (n < 0) return `−${Math.abs(n)}%`;
  return "0%";
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** "hace 12 min", "hace 3 h", "hace 2 días" */
export function ageText(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso));
  const min = Math.round(ms / 60_000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

export function impactLabel(impact: number): "alto" | "medio" | "bajo" {
  return impact >= 0.8 ? "alto" : impact >= 0.5 ? "medio" : "bajo";
}
