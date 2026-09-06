// Tipos del hub de factores economicos y financieros (event-list.md §6).
//
// A diferencia de §1-§5, esta categoria no describe eventos en un lugar sino
// series macro de un pais. El punto del mapa solo sirve para resolver de que
// pais estamos hablando; el radio no aplica.

/** Como quedo el destino para el viajero de un emisor. */
export type Verdict = "cheaper" | "stable" | "pricier";

export interface Indicator {
  /** Valor del indicador. null si la fuente no lo publica para ese pais. */
  value: number | null;
  /** Anio al que corresponde. */
  year: number | null;
  /** true si es proyeccion del FMI, no dato observado. */
  projected: boolean;
  unit: string;
}

/** Foto macro del pais: lo que responde "como esta la economia de acá". */
export interface MacroSnapshot {
  inflation: Indicator;
  /**
   * Inflacion acumulada de los ultimos 12 meses, de la serie mensual local
   * cuando existe. Es la que se usa para el cambio real de los emisores,
   * porque coincide con la ventana que mide el cruce; `inflation` (promedio
   * anual del FMI) puede diferir varios puntos donde la inflacion se mueve
   * rapido. Se publica aparte para que no haya un numero calculado con un
   * dato que la pantalla no muestra.
   */
  inflationTrailing12m: Indicator;
  gdpGrowth: Indicator;
  unemployment: Indicator;
  gdpPerCapitaPpp: Indicator;
  /**
   * Nivel de precios relativo a EE.UU. (1.0 = igual de caro que EE.UU.).
   * Derivado: factor PPA / tipo de cambio oficial, ambos del Banco Mundial.
   * Es la respuesta a "costo de vida relativo del destino" de la lista.
   */
  priceLevel: Indicator;
}

/**
 * El destino medido contra UN mercado emisor. Es el corazon del hub: un
 * hotel no compite en el vacio, compite contra lo que le cuesta el viaje al
 * turista que efectivamente lo visita.
 */
export interface EmitterView {
  countryCode: string;
  countryName: string;
  currency: string;
  /**
   * Cuanto mas caro es el destino que la casa del emisor, hoy.
   * 1.0 = igual; 0.6 = el destino esta 40% mas barato. Sale del cociente de
   * niveles de precio, asi que existe para TODO par de paises: no depende de
   * que haya serie cambiaria.
   */
  relativePriceLevel: number | null;
  /** Unidades de la moneda del emisor por 1 del destino. */
  fxCross: number | null;
  /**
   * Variacion nominal del cruce a 12 meses. Negativo = el destino se abarato
   * en la moneda del emisor. Solo si el BCE publica ambas monedas.
   */
  nominalChangePct: number | null;
  /**
   * Lo mismo pero descontando la inflacion de los dos paises. Es el numero
   * que manda: una devaluacion del 40% con 40% de inflacion no abarata nada.
   */
  realChangePct: number | null;
  verdict: Verdict | null;
  /** Por que falta la serie, cuando falta. */
  note?: string;
}

/**
 * Mercado cambiario paralelo. Solo existe donde hay control de capitales;
 * es el item "cepo / restricciones cambiarias" de la lista, y para el turista
 * define el tipo de cambio que realmente recibe.
 */
export interface ParallelMarket {
  official: number;
  parallel: number;
  parallelName: string;
  /** Brecha porcentual entre el paralelo y el oficial. */
  gapPct: number;
  /** Devaluacion nominal del oficial a 12 meses, si hay serie. */
  officialChange12mPct: number | null;
  /** Inflacion acumulada 12m del pais, si hay serie mensual. */
  inflation12mPct: number | null;
  /**
   * Tipo de cambio real: devaluacion menos inflacion. Positivo = el pais se
   * encarecio en dolares pese a devaluar.
   */
  realChange12mPct: number | null;
  asOf: string;
  source: string;
}

export interface EconomyCoverage {
  macro: boolean;
  fx: boolean;
  emitters: boolean;
  /** true si los emisores salen de tabla curada y no del fallback regional. */
  curatedEmitters: boolean;
  parallelMarket: boolean;
  gaps: string[];
}

export interface EconomyPointPayload {
  location: { lat: number; lng: number };
  country: { code: string; name: string; currency: string; region: string | null };
  macro: MacroSnapshot;
  /** Los emisores ordenados por cuanto se abarato el destino para ellos. */
  emitters: EmitterView[];
  parallelMarket: ParallelMarket | null;
  /**
   * Lectura de una linea, sin abrir la tabla. Tiene dos mitades a proposito:
   * el CAMBIO a 12 meses solo existe donde el BCE publica la moneda, pero el
   * NIVEL sale del cociente de paridades y existe para cualquier par. Asi el
   * titular dice algo util incluso en los destinos sin serie cambiaria.
   */
  headline: {
    /** Emisores para los que el destino se abarato en terminos reales. */
    cheaperFor: number;
    pricierFor: number;
    /** Cuantos emisores tienen serie de 12 meses (puede ser 0). */
    measuredAgainst: number;
    /** Emisor para el que mas se abarato el destino. */
    bestMarket: string | null;
    /** Emisores que hoy ven el destino mas barato que su propia casa. */
    cheaperThanHome: number;
    /** Sobre cuantos emisores se pudo comparar el nivel de precios. */
    levelComparedAgainst: number;
  };
  coverage: EconomyCoverage;
  sources: string[];
  timestamp: string;
}
