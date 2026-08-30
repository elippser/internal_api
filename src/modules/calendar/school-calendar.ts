// Calendario escolar curado de los mercados que OpenHolidays NO cubre
// (event-list.md §2: vacaciones de verano / invierno / mitad de año).
//
// POR QUÉ ESTÁ CURADO: OpenHolidays no tiene a Argentina, Chile ni Uruguay, y
// a Brasil lo lista pero devuelve 0 recesos. Es justo el mercado propio, y las
// vacaciones de invierno de julio son el segundo pico del año en el Cono Sur.
// No existe API: cada jurisdicción publica su calendario por resolución.
//
// CÓMO ESTÁ MODELADO — y por qué no son fechas fijas por año: los ministerios
// publican el año siguiente recién sobre fin de año, así que hardcodear
// "2026-07-06" dejaría el hub ciego apenas cambie el ciclo. En cambio se curan
// las REGLAS ("bloque 1 arranca el 1er lunes de julio, 2 semanas"), que son
// estables, y se verifican contra las fechas oficiales del último ciclo
// publicado. Cada bloque declara si su regla está `verified` contra el
// calendario oficial o si es `approximate`.
//
// El escalonamiento NO es ruido: es el ítem "calendario escolar par vs. impar
// (regiones con distinto receso)" del §2. En Argentina reparte la demanda de
// invierno en tres oleadas de dos semanas cada una.
//
// MANTENIMIENTO: revisar una vez al año contra la resolución de cada
// ministerio. Si un país cambia el esquema (Uruguay amplió el receso de
// primavera de 3 días a una semana en 2026), se ajusta la regla acá.

import { resolveRule, type DateRule } from "./observances";

export interface CuratedBreakBlock {
  /** Qué jurisdicciones toman este bloque. */
  label: string;
  subdivisions: string[];
  start: DateRule;
  /** Semanas de receso; el fin cae el viernes de la última. */
  weeks?: number;
  /** Alternativa a `weeks` para recesos que no son múltiplos de semana
   *  (el verano cruza el año: si el fin queda antes del inicio, rueda +1). */
  end?: DateRule;
}

export interface CuratedBreakDef {
  key: string;
  name: string;
  season: "summer" | "winter" | "spring" | "mid";
  blocks: CuratedBreakBlock[];
  /** `verified` = la regla reproduce el calendario oficial del último ciclo. */
  precision: "verified" | "approximate";
  note: string;
}

const MS_DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Lunes de la semana N de un mes; -1 = el último. */
const monday = (month: number, nth: number): DateRule => ({
  kind: "nthWeekday", month, weekday: 1, nth,
});

// ── Argentina ─────────────────────────────────────────────────────────────
// Receso invernal 2026 oficial: tres bloques, 6-17, 13-24 y 20-31 de julio.
// Julio 2026 arranca miércoles, así que esos lunes son el 1º, 2º y 3º del mes
// — la regla reproduce los tres bloques exactos.
// Ciclo lectivo 2026: inicio entre el 18/2 y el 2/3; cierre entre el 11 y el
// 18/12 (190 días de clase, Ministerio de Capital Humano).
const AR: CuratedBreakDef[] = [
  {
    key: "ar-invierno",
    name: "Vacaciones de invierno",
    season: "winter",
    precision: "verified",
    note: "Tres bloques escalonados; cada jurisdicción elige el suyo",
    blocks: [
      {
        label: "Bloque 1",
        subdivisions: ["Córdoba", "Entre Ríos", "Mendoza", "San Juan", "San Luis", "Santa Fe"],
        start: monday(7, 1),
        weeks: 2,
      },
      {
        label: "Bloque 2 (mayoría de provincias)",
        subdivisions: ["Salta", "Tucumán", "Misiones", "Corrientes", "Neuquén", "Río Negro", "y otras"],
        start: monday(7, 2),
        weeks: 2,
      },
      {
        label: "Bloque 3",
        subdivisions: ["Buenos Aires", "CABA", "Chaco", "Santiago del Estero"],
        start: monday(7, 3),
        weeks: 2,
      },
    ],
  },
  {
    key: "ar-verano",
    name: "Vacaciones de verano",
    season: "summer",
    precision: "approximate",
    note: "Cierre del ciclo entre el 11 y el 18/12; inicio entre el 18/2 y el 2/3",
    blocks: [
      {
        label: "Nacional (varía por provincia)",
        subdivisions: [],
        start: { kind: "fixed", month: 12, day: 15 },
        end: { kind: "fixed", month: 2, day: 25 },
      },
    ],
  },
];

// ── Chile ─────────────────────────────────────────────────────────────────
// Vacaciones de invierno 2026 (Mineduc, escalonadas por región):
//   Atacama–Los Ríos + RM: 22/6 al 3/7  → 4º lunes de junio, 2 semanas
//   Antofagasta y Los Lagos: 6 al 17/7  → 1er lunes de julio, 2 semanas
//   Arica/Parinacota y Tarapacá: 13 al 24/7 → 2º lunes de julio, 2 semanas
//   Aysén y Magallanes: 29/6 al 17/7    → último lunes de junio, 3 semanas
// Inicio del año escolar 2026: estudiantes el 4 de marzo.
const CL: CuratedBreakDef[] = [
  {
    key: "cl-invierno",
    name: "Vacaciones de invierno",
    season: "winter",
    precision: "verified",
    note: "Mineduc escalona por región; Aysén y Magallanes tienen 3 semanas",
    blocks: [
      {
        label: "Atacama a Los Ríos (incl. Metropolitana)",
        subdivisions: ["Metropolitana", "Valparaíso", "Maule", "Biobío", "Araucanía", "Los Ríos", "Atacama", "Coquimbo"],
        start: monday(6, 4),
        weeks: 2,
      },
      {
        label: "Antofagasta y Los Lagos",
        subdivisions: ["Antofagasta", "Los Lagos"],
        start: monday(7, 1),
        weeks: 2,
      },
      {
        label: "Arica y Parinacota, Tarapacá",
        subdivisions: ["Arica y Parinacota", "Tarapacá"],
        start: monday(7, 2),
        weeks: 2,
      },
      {
        label: "Aysén y Magallanes (3 semanas)",
        subdivisions: ["Aysén", "Magallanes"],
        start: monday(6, -1),
        weeks: 3,
      },
    ],
  },
  {
    key: "cl-verano",
    name: "Vacaciones de verano",
    season: "summer",
    precision: "approximate",
    note: "Cierre a fines de noviembre/principios de diciembre; ingreso de estudiantes el 4/3",
    blocks: [
      {
        label: "Nacional",
        subdivisions: [],
        start: { kind: "fixed", month: 12, day: 5 },
        end: { kind: "fixed", month: 3, day: 3 },
      },
    ],
  },
];

// ── Uruguay ───────────────────────────────────────────────────────────────
// Calendario ANEP 2026: receso de invierno del 29/6 al 3/7 (una semana, no
// dos como en Argentina), y receso de primavera del 21 al 25/9 — ampliado ese
// año de tres días a una semana completa. Cierre: 18/12 en inicial y primaria.
const UY: CuratedBreakDef[] = [
  {
    key: "uy-invierno",
    name: "Vacaciones de invierno",
    season: "winter",
    precision: "verified",
    note: "ANEP: una sola semana, más corta que la de Argentina",
    blocks: [
      { label: "Nacional", subdivisions: [], start: monday(6, -1), weeks: 1 },
    ],
  },
  {
    key: "uy-primavera",
    name: "Vacaciones de primavera",
    season: "spring",
    precision: "verified",
    note: "ANEP la amplió a una semana completa en 2026",
    blocks: [
      { label: "Nacional", subdivisions: [], start: monday(9, 3), weeks: 1 },
    ],
  },
  {
    key: "uy-verano",
    name: "Vacaciones de verano",
    season: "summer",
    precision: "approximate",
    note: "Cierre de inicial y primaria el 18/12; inicio de clases el 2/3",
    blocks: [
      {
        label: "Nacional",
        subdivisions: [],
        start: { kind: "fixed", month: 12, day: 18 },
        end: { kind: "fixed", month: 3, day: 1 },
      },
    ],
  },
];

// ── Brasil ────────────────────────────────────────────────────────────────
// Cada Secretaria Estadual define su calendario. Verificado 2026: São Paulo
// 6-17/7, Minas Gerais 20-31/7, Pernambuco 17-31/7. Vuelta a clases el 4/2
// (red municipal de SP y red estadual de MG).
const BR: CuratedBreakDef[] = [
  {
    key: "br-julho",
    name: "Férias de julho",
    season: "winter",
    precision: "verified",
    note: "Cada estado define el suyo; las privadas pueden diferir",
    blocks: [
      { label: "São Paulo", subdivisions: ["São Paulo"], start: monday(7, 1), weeks: 2 },
      { label: "Pernambuco y similares", subdivisions: ["Pernambuco"], start: monday(7, 3), weeks: 2 },
      { label: "Minas Gerais", subdivisions: ["Minas Gerais"], start: monday(7, 3), weeks: 2 },
    ],
  },
  {
    key: "br-verao",
    name: "Férias de verão",
    season: "summer",
    precision: "approximate",
    note: "Vuelta a clases alrededor del 4/2 en SP y MG",
    blocks: [
      {
        label: "Nacional (varía por estado)",
        subdivisions: [],
        start: { kind: "fixed", month: 12, day: 20 },
        end: { kind: "fixed", month: 2, day: 3 },
      },
    ],
  },
];

const CURATED: Record<string, CuratedBreakDef[]> = { AR, CL, UY, BR };

/** Países con calendario escolar curado (los que OpenHolidays no cubre). */
export const CURATED_SCHOOL_COUNTRIES = new Set(Object.keys(CURATED));

export interface ResolvedBreak {
  startDate: string;
  endDate: string;
  name: string;
  blockLabel: string;
  subdivisions: string[];
  season: CuratedBreakDef["season"];
  precision: CuratedBreakDef["precision"];
  note: string;
}

/**
 * Resuelve los recesos curados de un país para los años dados. El verano
 * cruza el año calendario: si el fin cae antes del inicio, rueda al siguiente.
 */
export function curatedSchoolBreaks(countryCode: string, years: number[]): ResolvedBreak[] {
  const defs = CURATED[countryCode.toUpperCase()];
  if (!defs) return [];

  const out: ResolvedBreak[] = [];
  for (const year of years) {
    for (const def of defs) {
      for (const block of def.blocks) {
        const startDate = resolveRule(block.start, year);
        let endDate: string;

        if (block.weeks !== undefined) {
          // El inicio siempre es lunes: +7n-3 días cae el viernes del final.
          const s = new Date(`${startDate}T00:00:00Z`);
          endDate = iso(new Date(s.getTime() + (block.weeks * 7 - 3) * MS_DAY));
        } else if (block.end) {
          const sameYear = resolveRule(block.end, year);
          endDate = sameYear >= startDate ? sameYear : resolveRule(block.end, year + 1);
        } else {
          continue;
        }

        out.push({
          startDate,
          endDate,
          name: def.name,
          blockLabel: block.label,
          subdivisions: block.subdivisions,
          season: def.season,
          precision: def.precision,
          note: def.note,
        });
      }
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}
