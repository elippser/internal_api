import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Consolidados diarios del modulo Usabilidad (USABILIDAD-SPEC.md §5).
 *
 * Los crudos (`ui_*` en analytics_events) viven 30 dias; esto vive 18 meses
 * (TTL sobre `expiresAt`). Todo lo que necesita percentiles se guarda como
 * HISTOGRAMA con bordes fijos y no como promedio: asi el p50/p75/p90 de un
 * rango de varios dias sale de sumar histogramas, no de promediar promedios.
 */

const RETENTION_MS = 548 * 86_400_000; // ~18 meses

/** Bordes de los histogramas (el ultimo tramo es "mas que el ultimo borde"). */
export const HIST_EDGES = {
  /** Tiempo activo por vista de pantalla, en segundos. */
  activeSec: [5, 10, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1800],
  lcpMs: [500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000],
  inpMs: [50, 100, 150, 200, 300, 500, 800, 1500],
  cls: [0.02, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
} as const;

const num = { type: Number, default: 0 };
const hist = { type: [Number], default: undefined };
const mixed = { type: Schema.Types.Mixed, default: {} };

const screenDailySchema = new Schema(
  {
    day: { type: String, required: true },
    /** companyId real, o "*" para el total global (distintos contados de verdad). */
    companyId: { type: String, required: true },
    appId: { type: String, required: true },
    screenKey: { type: String, required: true },

    /** Vistas = pantallas cerradas (ui_screen_left). */
    views: num,
    /** Vistas por tamaño de pantalla: { m, t, d }. */
    viewsByBucket: mixed,
    users: num,
    sessions: num,
    activeMs: num,
    idleMs: num,
    activeHist: hist,
    /** Profundidad de scroll maxima por vista, en 10 tramos de 10%. */
    scrollHist: hist,

    clicks: num,
    /** Episodios de frustracion (un ui_click con rage >= 3 = 1 episodio). */
    rage: num,
    dead: num,
    errorsShown: num,
    /** { alert, inline, boundary, toast } */
    errorsByKind: mixed,
    /** { codigo: n } (solo los que mandan codigo) */
    errorCodes: mixed,
    formInvalid: num,
    jsErrors: num,
    /** { firma: n } */
    jsSigs: mixed,
    /** A → esta → A en ≤ 20 s: entraron y se volvieron. */
    backtracks: num,
    /** Ultima pantalla de la sesion (en su capa). */
    exits: num,
    entries: num,

    lcpHist: hist,
    inpHist: hist,
    clsHist: hist,

    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { collection: "usability_screen_daily", versionKey: false },
);
screenDailySchema.index({ day: 1, companyId: 1, screenKey: 1 }, { unique: true });
screenDailySchema.index({ companyId: 1, day: 1 });
screenDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const heatDailySchema = new Schema(
  {
    day: { type: String, required: true },
    screenKey: { type: String, required: true },
    vwBucket: { type: String, enum: ["m", "t", "d"], required: true },
    clicks: num,
    /** Celdas: x en 48 columnas (relativo al ancho), y en filas de 40 px de pagina. */
    cells: { type: [{ c: Number, r: Number, n: Number, rage: Number, dead: Number, _id: false }], default: [] },
    /** Elementos mas tocados (firma estructural, sin texto). */
    elements: {
      type: [
        {
          sig: String,
          tag: String,
          role: String,
          track: String,
          n: Number,
          rage: Number,
          dead: Number,
          /** Posicion media (px de pagina) para ubicarlo sobre el esqueleto. */
          x: Number,
          y: Number,
          _id: false,
        },
      ],
      default: [],
    },
    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { collection: "usability_heat_daily", versionKey: false },
);
heatDailySchema.index({ day: 1, screenKey: 1, vwBucket: 1 }, { unique: true });
heatDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const flowDailySchema = new Schema(
  {
    day: { type: String, required: true },
    companyId: { type: String, required: true },
    /** Capa: "pms" o el prefijo de la app embebida (booking, rooms, rms). */
    layer: { type: String, required: true },
    from: { type: String, required: true }, // screenKey o "__entry"
    to: { type: String, required: true }, // screenKey o "__exit"
    n: num,
    expiresAt: { type: Date, default: () => new Date(Date.now() + RETENTION_MS) },
  },
  { collection: "usability_flow_daily", versionKey: false },
);
flowDailySchema.index({ day: 1, companyId: 1, layer: 1, from: 1, to: 1 }, { unique: true });
flowDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** El esqueleto mas reciente de cada pantalla y tamaño (se pisa). */
const layoutSchema = new Schema(
  {
    screenKey: { type: String, required: true },
    vwBucket: { type: String, enum: ["m", "t", "d"], required: true },
    vw: Number,
    docH: Number,
    rects: { type: [{ x: Number, y: Number, w: Number, h: Number, k: String, _id: false }], default: [] },
    capturedAt: { type: Date, required: true },
  },
  { collection: "usability_layout", versionKey: false },
);
layoutSchema.index({ screenKey: 1, vwBucket: 1 }, { unique: true });

const jobStateSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true },
    lastRunAt: Date,
    lastSuccessAt: Date,
    lastError: { type: String, default: null },
    lastDays: [String],
    lastDurationMs: Number,
  },
  { collection: "usability_job_state", versionKey: false },
);

export const UsabilityScreenDaily = model("UsabilityScreenDaily", screenDailySchema);
export const UsabilityHeatDaily = model("UsabilityHeatDaily", heatDailySchema);
export const UsabilityFlowDaily = model("UsabilityFlowDaily", flowDailySchema);
export const UsabilityLayout = model("UsabilityLayout", layoutSchema);
export const UsabilityJobState = model("UsabilityJobState", jobStateSchema);

export type ScreenDailyDoc = InferSchemaType<typeof screenDailySchema>;
