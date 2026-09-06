// Calendario productivo curado (event-list.md §16).
//
// El hemisferio manda: la vendimia cae en marzo al sur y en septiembre al
// norte. No es un detalle de almanaque, son seis meses de diferencia, y un hub
// que ignore eso pone la temporada alta justo al reves para media America.
//
// Todas las ventanas son TIPICAS, no la veda vigente: la pesca y la caza las
// fija cada provincia y cambian todos los anios. Se marca `approximate` y se
// dice en pantalla, en vez de dar una fecha falsa con cara de exacta.

export interface Season {
  /** Meses (1-12) de la temporada. */
  months: number[];
  note: string;
  approximate: boolean;
}

export const SEASONS: Record<string, { south: Season; north: Season }> = {
  wine: {
    south: {
      months: [2, 3, 4],
      note: "Vendimia de febrero a abril; la Fiesta de la Vendimia en Mendoza es el pico",
      approximate: false,
    },
    north: {
      months: [8, 9, 10],
      note: "Vendimia de agosto a octubre segun latitud y variedad",
      approximate: false,
    },
  },
  agriculture: {
    south: {
      months: [11, 12, 1, 2, 3],
      note: "Cosecha gruesa de noviembre a marzo; las ferias rurales acompanian",
      approximate: true,
    },
    north: {
      months: [6, 7, 8, 9],
      note: "Cosecha de verano y principios de otonio",
      approximate: true,
    },
  },
  fishing: {
    south: {
      months: [11, 12, 1, 2, 3, 4],
      note: "Temporada de pesca deportiva de noviembre a abril; la veda la fija cada provincia",
      approximate: true,
    },
    north: {
      months: [5, 6, 7, 8, 9, 10],
      note: "Temporada de mayo a octubre; la veda la fija cada jurisdiccion",
      approximate: true,
    },
  },
  forestry: {
    south: {
      months: [4, 5, 6, 7, 8, 9],
      note: "Aprovechamiento forestal en la mitad seca del anio",
      approximate: true,
    },
    north: {
      months: [10, 11, 12, 1, 2, 3],
      note: "Aprovechamiento forestal en la mitad fria del anio",
      approximate: true,
    },
  },
  // Mineria e industria no tienen temporada: son turnos rotativos todo el anio,
  // y eso es justamente lo que las vuelve la demanda mas estable de todas.
};
