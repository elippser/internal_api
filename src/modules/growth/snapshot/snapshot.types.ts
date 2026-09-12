/**
 * PropertySnapshot — la foto comercial de una propiedad.
 *
 * Es la pieza que cambia la calidad del turno estratégico. Reemplaza "el modelo
 * llama 8 tools de a una" por "el código lee 10 fuentes en paralelo y entrega
 * ~40 indicadores derivados en ~700 tokens".
 *
 * REGLA QUE NO SE NEGOCIA: un bloque que no se pudo leer vale `null` y su nombre
 * entra en `missing`. Nunca se rellena con ceros ni defaults: un dato inventado
 * es peor que ninguno, porque el modelo lo cita como evidencia.
 */

export const SNAPSHOT_BLOCKS = [
  "identity",
  "demand",
  "ops",
  "direct",
  "presence",
  "reputation",
  "market",
  "revenue",
] as const;
export type SnapshotBlock = (typeof SNAPSHOT_BLOCKS)[number];

export type Season = "alta" | "media" | "baja";

/** Identidad de la propiedad. Único bloque que NO puede faltar. */
export interface IdentityBlock {
  propertyId: string;
  name: string;
  type: string;
  city: string;
  countryCode: string;
  currency: string;
  lat: number | null;
  lng: number | null;
  /** "unit_based" | "category_based" */
  salesModel: string;
  units: number;
  categories: number;
  /** Meses desde que la propiedad existe en la plataforma. */
  monthsOnPlatform: number;
}

/**
 * Demanda futura (rms-app / pace).
 *
 * Acá viven los números COMERCIALES (ocupación, tarifa, ingresos), y son
 * mirando hacia adelante: lo vendido para los próximos 30 días. El reporte de
 * dashboard de booking-app no los trae — es operativo.
 */
export interface DemandBlock {
  /** Hay suficientes fotos de pace para que el índice signifique algo. */
  hasHistory: boolean;
  historyDays: number;
  /** Noches on-the-books en los próximos N días. */
  otb30: number;
  otb60: number;
  otb90: number;
  /** Ocupación 0..1 de los próximos 30 días. null si no hay capacidad cargada. */
  occ30: number | null;
  /** Tarifa promedio de lo vendido para los próximos 30 días. */
  adr: number | null;
  /** Ingresos ya comprometidos para los próximos 30 días. */
  revenueOtb30: number;
  /** Promedio del pace_index de las fechas con benchmark REAL. null si no hay. */
  paceIndexAvg: number | null;
  /** Noches ganadas en los últimos 7 días para estadías futuras. */
  pickup7d: number;
  /** Fechas futuras por debajo del umbral "lento" del hotel. */
  datesAtRisk: number;
}

/**
 * Operación (booking-app / reports/dashboard).
 *
 * Reporte OPERATIVO: cuántas reservas entran, cuántas se caen, por qué canal y
 * qué está trabado. La mezcla de canales es lo más valioso — es la única
 * medición real de la dependencia de intermediarios.
 */
export interface OpsBlock {
  /** Reservas del período actual y del anterior, para ver la tendencia. */
  reservationsCurrent: number;
  reservationsPrevious: number;
  /** Variación en %, tal como la calcula el reporte. */
  reservationsDeltaPct: number | null;
  activeToday: number;
  incomingThisWeek: number;
  /** % de cancelación. null si no hubo reservas en el período. */
  cancellationRatePct: number | null;
  lastMinuteCancellations: number;
  /** % de reservas por canal directo. null si no hay reservas que repartir. */
  directSharePct: number | null;
  /** Cuántos canales distintos trajeron reservas. */
  channels: number;
  avgStayNights: number | null;
  /** Reservas pendientes vencidas: fricción que cuesta plata. */
  pendingOverdue: number;
}

/** Canal directo: el motor de reservas propio. */
export interface DirectBlock {
  engineActive: boolean;
  ratePlans: number;
  promosActive: number;
  /** Hay al menos una promo pensada para la web propia. */
  webOnlyPromo: boolean;
  hasRestrictions: boolean;
}

/** Presencia digital: sitio, LinkHub, GBP, OTAs, redes. */
export interface PresenceBlock {
  sitePublished: boolean;
  siteLanguages: number;
  linkhubPublished: boolean;
  /** 0..100, del último VisibilitySnapshot. null si nunca se computó. */
  visibilityScore: number | null;
  seoScore: number | null;
  geoScore: number | null;
  /** 0..1 */
  gbpCompleteness: number;
  /** 0..1, promedio de las fichas OTA cargadas. */
  otaCompleteness: number;
  otaPlatforms: string[];
  socialConnected: number;
}

/** Reputación: reseñas propias e importadas. */
export interface ReputationBlock {
  /** Promedio 1..5. null si no hay reseñas. */
  rating: number | null;
  reviews: number;
  responded: number;
  last90d: number;
}

/** Mercado alrededor de la propiedad (intelligence-hub). */
export interface MarketBlock {
  season: Season;
  eventsNext90d: number;
  topEvents: Array<{ name: string; date: string; magnitude: number }>;
  longWeekendsNext90d: number;
  /** Radio en km con el que se buscó (para que el prompt no exagere el alcance). */
  radiusKm: number;
}

/** Configuración de revenue (rms-app). */
export interface RevenueBlock {
  rulesActive: number;
  recommendationsPending: number;
  compsetConfigured: boolean;
  competitors: number;
  /** Las recomendaciones se aplican solas: cambia qué tiene sentido proponer. */
  autoApply: boolean;
}

export interface PropertySnapshot {
  propertyId: string;
  companyId: string;
  takenAt: string;
  /** Bloques que no se pudieron leer. El prompt los declara. */
  missing: SnapshotBlock[];
  /** Cuánto tardó la recolección completa, para telemetría. */
  collectedInMs: number;
  identity: IdentityBlock;
  demand: DemandBlock | null;
  ops: OpsBlock | null;
  direct: DirectBlock | null;
  presence: PresenceBlock | null;
  reputation: ReputationBlock | null;
  market: MarketBlock | null;
  revenue: RevenueBlock | null;
}

/**
 * Vista plana del snapshot: `"ops.occ30" -> 0.41`.
 *
 * Es lo que consumen las reglas de aplicabilidad de los playbooks y los KPI de
 * un plan. Se genera con `flattenSnapshot`; un bloque ausente NO aporta claves
 * (así `{ path, op: "missing" }` distingue "no hay dato" de "el dato es 0").
 */
export type FlatSnapshot = Record<string, string | number | boolean | null>;
