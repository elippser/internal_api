// Calendario academico curado (event-list.md §15).
//
// No hay API de calendarios universitarios: cada casa de estudios fija sus
// fechas y las publica en su propio sitio. Lo que si es estable es la ESTACION:
// en el hemisferio sur el ciclo va de marzo a diciembre y las colaciones caen
// entre noviembre y abril; en el norte, de septiembre a junio con graduaciones
// en mayo y junio.
//
// Esas dos ventanas explican la mayor parte de la demanda por graduaciones, que
// es lo que le interesa a un hotel: familias que viajan en fecha fija y reservan
// con meses de anticipacion. Mismo criterio que el calendario escolar del §2:
// curado, fechado y con lo aproximado declarado como tal.

export interface AcademicWindow {
  /** Meses (1-12) del ciclo lectivo. */
  termMonths: number[];
  /** Meses con colaciones y actos de graduacion. */
  graduationMonths: number[];
  /** Meses de ingreso y examenes de admision. */
  admissionMonths: number[];
  note: string;
  approximate: boolean;
}

const SOUTH: AcademicWindow = {
  termMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  graduationMonths: [11, 12, 3, 4],
  admissionMonths: [11, 12, 2],
  note: "Ciclo de marzo a diciembre; colaciones al cierre y al inicio del siguiente",
  approximate: true,
};

const NORTH: AcademicWindow = {
  termMonths: [9, 10, 11, 12, 1, 2, 3, 4, 5, 6],
  graduationMonths: [5, 6],
  admissionMonths: [1, 3, 4],
  note: "Ciclo de septiembre a junio; graduaciones concentradas en mayo y junio",
  approximate: true,
};

/**
 * Por pais donde el calendario se aparta del patron de su hemisferio, y dos
 * entradas de respaldo por hemisferio.
 */
export const ACADEMIC_CALENDAR: Record<string, AcademicWindow> = {
  __south: SOUTH,
  __north: NORTH,
  AR: SOUTH,
  CL: SOUTH,
  UY: SOUTH,
  PY: SOUTH,
  BR: {
    ...SOUTH,
    graduationMonths: [12, 1, 7, 8],
    note: "Dos ingresos por anio: colaciones en diciembre-enero y en julio-agosto",
  },
  AU: SOUTH,
  NZ: SOUTH,
  ZA: SOUTH,
  US: NORTH,
  CA: NORTH,
  ES: NORTH,
  MX: {
    ...NORTH,
    graduationMonths: [6, 7, 12],
    note: "Ciclo de agosto a junio, con egresos tambien en diciembre",
  },
  GB: NORTH,
  FR: NORTH,
  DE: NORTH,
  IT: NORTH,
  JP: {
    termMonths: [4, 5, 6, 7, 9, 10, 11, 12, 1, 2],
    graduationMonths: [3],
    admissionMonths: [1, 2],
    note: "Ciclo de abril a marzo: las graduaciones caen todas en marzo",
    approximate: true,
  },
  IN: {
    ...NORTH,
    termMonths: [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4],
    graduationMonths: [4, 5],
    note: "Ciclo de junio a abril; convocatorias en abril y mayo",
  },
};
