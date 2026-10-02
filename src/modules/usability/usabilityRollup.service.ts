import { AnalyticsEvent } from "../analytics/analytics.model";
import {
  HIST_EDGES,
  UsabilityFlowDaily,
  UsabilityHeatDaily,
  UsabilityJobState,
  UsabilityLayout,
  UsabilityScreenDaily,
} from "./usability.model";

/**
 * Rollup diario de usabilidad (USABILIDAD-SPEC.md §5).
 *
 * Un dia = dia civil UTC por `serverTimestamp` (misma convencion que
 * metrics_daily). Lee los `ui_*` crudos del dia una sola vez (cursor) y arma en
 * memoria las pantallas (por compañia y global), el calor, los recorridos y el
 * ultimo esqueleto. Idempotente: borra el dia y lo vuelve a escribir.
 *
 * Global ("*") se arma en la misma pasada, NO sumando compañias: usuarios y
 * sesiones distintos se cuentan distinct.
 */

const UI_EVENTS = [
  "ui_click",
  "ui_screen_left",
  "ui_error_shown",
  "ui_form_invalid",
  "ui_js_error",
  "ui_vitals",
  "ui_layout",
];

/** screenKey del documento resumen del dia (no es una pantalla). */
export const DAY_KEY = "__day";

const HEAT_COLS = 48;
const HEAT_ROW_PX = 40;
const HEAT_MAX_ROWS = 200;
const BACKTRACK_MS = 20_000;
const TOP_ELEMENTS = 20;

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Indice del tramo de un histograma (el ultimo = por encima del ultimo borde). */
export function histIndex(edges: readonly number[], v: number): number {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i;
  return edges.length;
}

function bump(h: number[] | undefined, size: number, i: number): number[] {
  const out = h ?? new Array(size).fill(0);
  out[i] += 1;
  return out;
}

interface ScreenAcc {
  companyId: string;
  appId: string;
  screenKey: string;
  views: number;
  viewsByBucket: Record<string, number>;
  users: Set<string>;
  sessions: Set<string>;
  activeMs: number;
  idleMs: number;
  activeHist?: number[];
  scrollHist?: number[];
  clicks: number;
  rage: number;
  dead: number;
  errorsShown: number;
  errorsByKind: Record<string, number>;
  errorCodes: Record<string, number>;
  formInvalid: number;
  jsErrors: number;
  jsSigs: Record<string, number>;
  backtracks: number;
  exits: number;
  entries: number;
  lcpHist?: number[];
  inpHist?: number[];
  clsHist?: number[];
}

function newScreen(companyId: string, appId: string, screenKey: string): ScreenAcc {
  return {
    companyId,
    appId,
    screenKey,
    views: 0,
    viewsByBucket: {},
    users: new Set(),
    sessions: new Set(),
    activeMs: 0,
    idleMs: 0,
    clicks: 0,
    rage: 0,
    dead: 0,
    errorsShown: 0,
    errorsByKind: {},
    errorCodes: {},
    formInvalid: 0,
    jsErrors: 0,
    jsSigs: {},
    backtracks: 0,
    exits: 0,
    entries: 0,
  };
}

interface HeatAcc {
  screenKey: string;
  vwBucket: string;
  clicks: number;
  cells: Map<string, { c: number; r: number; n: number; rage: number; dead: number }>;
  elements: Map<
    string,
    { sig: string; tag?: string; role?: string; track?: string; n: number; rage: number; dead: number; sx: number; sy: number }
  >;
}

/** Capa del recorrido: las pantallas de un iframe corren a la par de las del PMS. */
export function layerOf(screenKey: string): string {
  const m = screenKey.match(/^(booking|rooms|rms):/);
  return m ? m[1] : "pms";
}

interface Visit {
  screenKey: string;
  at: number;
  durMs: number;
}

/** Computa y escribe un dia. Devuelve cuantos documentos escribio. */
export async function computeUsabilityDay(day: string): Promise<number> {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);

  const screens = new Map<string, ScreenAcc>();
  const heats = new Map<string, HeatAcc>();
  const visits = new Map<string, Visit[]>(); // `${companyId}|${sessionId}|${layer}`
  const layouts = new Map<string, { vw: number; docH: number; rects: unknown[]; at: Date }>();

  /**
   * Acumuladores que toca un evento: la pantalla y el resumen del dia
   * (`__day`), cada uno por compañia y global. El resumen existe porque una
   * sesion pasa por muchas pantallas: sumar pantallas inflaria usuarios y
   * sesiones del periodo.
   */
  const screenFor = (companyId: string, appId: string, screenKey: string): ScreenAcc[] => {
    const out: ScreenAcc[] = [];
    for (const co of [companyId, "*"]) {
      for (const [sk, ap] of [
        [screenKey, appId],
        [DAY_KEY, "*"],
      ]) {
        const k = `${co}|${sk}`;
        let s = screens.get(k);
        if (!s) {
          s = newScreen(co, ap, sk);
          screens.set(k, s);
        }
        out.push(s);
      }
    }
    return out;
  };

  const cursor = AnalyticsEvent.find(
    { eventName: { $in: UI_EVENTS }, serverTimestamp: { $gte: start, $lt: end } },
    { eventName: 1, companyId: 1, userId: 1, sessionId: 1, payload: 1, clientTimestamp: 1, serverTimestamp: 1 },
  )
    .lean()
    .cursor();

  for await (const ev of cursor) {
    const p = (ev.payload ?? {}) as Record<string, any>;
    const screenKey: string | undefined = p.screenKey;
    const appId: string | undefined = p.appId;
    if (!screenKey || !appId) continue;
    const companyId = ev.companyId;

    switch (ev.eventName) {
      case "ui_screen_left": {
        for (const s of screenFor(companyId, appId, screenKey)) {
          s.views += 1;
          s.viewsByBucket[p.vwBucket] = (s.viewsByBucket[p.vwBucket] ?? 0) + 1;
          if (ev.userId) s.users.add(ev.userId);
          s.sessions.add(ev.sessionId);
          s.activeMs += p.activeMs ?? 0;
          s.idleMs += p.idleMs ?? 0;
          s.activeHist = bump(s.activeHist, HIST_EDGES.activeSec.length + 1, histIndex(HIST_EDGES.activeSec, (p.activeMs ?? 0) / 1000));
          s.scrollHist = bump(s.scrollHist, 10, Math.min(9, Math.floor((p.maxScrollPct ?? 0) / 10)));
        }
        const layer = layerOf(screenKey);
        const key = `${companyId}|${ev.sessionId}|${layer}`;
        const list = visits.get(key) ?? [];
        list.push({
          screenKey,
          at: new Date(ev.clientTimestamp ?? ev.serverTimestamp).getTime(),
          durMs: (p.activeMs ?? 0) + (p.idleMs ?? 0),
        });
        visits.set(key, list);
        break;
      }
      case "ui_click": {
        for (const s of screenFor(companyId, appId, screenKey)) {
          s.clicks += 1;
          if (p.rage >= 3) s.rage += 1;
          if (p.dead) s.dead += 1;
        }
        const hk = `${screenKey}|${p.vwBucket}`;
        let h = heats.get(hk);
        if (!h) {
          h = { screenKey, vwBucket: p.vwBucket, clicks: 0, cells: new Map(), elements: new Map() };
          heats.set(hk, h);
        }
        h.clicks += 1;
        const c = Math.max(0, Math.min(HEAT_COLS - 1, Math.floor((p.x / Math.max(1, p.vw)) * HEAT_COLS)));
        const r = Math.max(0, Math.min(HEAT_MAX_ROWS - 1, Math.floor(p.y / HEAT_ROW_PX)));
        const ck = `${c}:${r}`;
        const cell = h.cells.get(ck) ?? { c, r, n: 0, rage: 0, dead: 0 };
        cell.n += 1;
        if (p.rage >= 3) cell.rage += 1;
        if (p.dead) cell.dead += 1;
        h.cells.set(ck, cell);
        const el = p.el ?? {};
        if (el.sig) {
          const e = h.elements.get(el.sig) ?? {
            sig: el.sig,
            tag: el.tag,
            role: el.role,
            track: el.track,
            n: 0,
            rage: 0,
            dead: 0,
            sx: 0,
            sy: 0,
          };
          e.n += 1;
          if (p.rage >= 3) e.rage += 1;
          if (p.dead) e.dead += 1;
          e.sx += p.x;
          e.sy += p.y;
          h.elements.set(el.sig, e);
        }
        break;
      }
      case "ui_error_shown":
        for (const s of screenFor(companyId, appId, screenKey)) {
          s.errorsShown += 1;
          s.errorsByKind[p.kind] = (s.errorsByKind[p.kind] ?? 0) + 1;
          if (p.code) s.errorCodes[p.code] = (s.errorCodes[p.code] ?? 0) + 1;
        }
        break;
      case "ui_form_invalid":
        for (const s of screenFor(companyId, appId, screenKey)) s.formInvalid += 1;
        break;
      case "ui_js_error":
        for (const s of screenFor(companyId, appId, screenKey)) {
          s.jsErrors += 1;
          s.jsSigs[p.sig] = (s.jsSigs[p.sig] ?? 0) + 1;
        }
        break;
      case "ui_vitals":
        for (const s of screenFor(companyId, appId, screenKey)) {
          if (typeof p.lcp === "number")
            s.lcpHist = bump(s.lcpHist, HIST_EDGES.lcpMs.length + 1, histIndex(HIST_EDGES.lcpMs, p.lcp));
          if (typeof p.inp === "number")
            s.inpHist = bump(s.inpHist, HIST_EDGES.inpMs.length + 1, histIndex(HIST_EDGES.inpMs, p.inp));
          if (typeof p.cls === "number")
            s.clsHist = bump(s.clsHist, HIST_EDGES.cls.length + 1, histIndex(HIST_EDGES.cls, p.cls));
        }
        break;
      case "ui_layout": {
        const lk = `${screenKey}|${p.vwBucket}`;
        const at = new Date(ev.serverTimestamp);
        const cur = layouts.get(lk);
        if (!cur || cur.at < at) layouts.set(lk, { vw: p.vw, docH: p.docH, rects: p.rects ?? [], at });
        break;
      }
    }
  }

  // ── Recorridos: transiciones, entradas, salidas e idas y vueltas ──────────
  const flows = new Map<string, { companyId: string; layer: string; from: string; to: string; n: number }>();
  const addFlow = (companyId: string, layer: string, from: string, to: string) => {
    for (const co of [companyId, "*"]) {
      const k = `${co}|${layer}|${from}|${to}`;
      const f = flows.get(k) ?? { companyId: co, layer, from, to, n: 0 };
      f.n += 1;
      flows.set(k, f);
    }
  };
  const screensOf = (companyId: string, screenKey: string) =>
    [screens.get(`${companyId}|${screenKey}`), screens.get(`*|${screenKey}`)].filter(Boolean) as ScreenAcc[];

  for (const [key, list] of visits) {
    const [companyId, , layer] = key.split("|");
    list.sort((a, b) => a.at - b.at);
    // Pantallas repetidas seguidas (cerrar/volver a la pestaña) son una sola visita.
    const seq = list.filter((v, i) => i === 0 || v.screenKey !== list[i - 1].screenKey);
    if (!seq.length) continue;
    addFlow(companyId, layer, "__entry", seq[0].screenKey);
    for (const s of screensOf(companyId, seq[0].screenKey)) s.entries += 1;
    for (let i = 1; i < seq.length; i++) addFlow(companyId, layer, seq[i - 1].screenKey, seq[i].screenKey);
    const last = seq[seq.length - 1];
    addFlow(companyId, layer, last.screenKey, "__exit");
    for (const s of screensOf(companyId, last.screenKey)) s.exits += 1;
    for (let i = 1; i < seq.length - 1; i++) {
      if (seq[i - 1].screenKey === seq[i + 1].screenKey && seq[i].durMs <= BACKTRACK_MS) {
        for (const s of screensOf(companyId, seq[i].screenKey)) s.backtracks += 1;
      }
    }
  }

  // ── Escritura (idempotente) ───────────────────────────────────────────────
  await Promise.all([
    UsabilityScreenDaily.deleteMany({ day }),
    UsabilityHeatDaily.deleteMany({ day }),
    UsabilityFlowDaily.deleteMany({ day }),
  ]);

  const screenDocs = [...screens.values()].map((s) => ({
    day,
    companyId: s.companyId,
    appId: s.appId,
    screenKey: s.screenKey,
    views: s.views,
    viewsByBucket: s.viewsByBucket,
    users: s.users.size,
    sessions: s.sessions.size,
    activeMs: s.activeMs,
    idleMs: s.idleMs,
    activeHist: s.activeHist,
    scrollHist: s.scrollHist,
    clicks: s.clicks,
    rage: s.rage,
    dead: s.dead,
    errorsShown: s.errorsShown,
    errorsByKind: s.errorsByKind,
    errorCodes: s.errorCodes,
    formInvalid: s.formInvalid,
    jsErrors: s.jsErrors,
    jsSigs: s.jsSigs,
    backtracks: s.backtracks,
    exits: s.exits,
    entries: s.entries,
    lcpHist: s.lcpHist,
    inpHist: s.inpHist,
    clsHist: s.clsHist,
  }));

  const heatDocs = [...heats.values()].map((h) => ({
    day,
    screenKey: h.screenKey,
    vwBucket: h.vwBucket,
    clicks: h.clicks,
    cells: [...h.cells.values()],
    elements: [...h.elements.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, TOP_ELEMENTS)
      .map(({ sx, sy, ...e }) => ({ ...e, x: Math.round(sx / e.n), y: Math.round(sy / e.n) })),
  }));

  const flowDocs = [...flows.values()].map((f) => ({ day, ...f }));

  if (screenDocs.length) await UsabilityScreenDaily.insertMany(screenDocs, { ordered: false });
  if (heatDocs.length) await UsabilityHeatDaily.insertMany(heatDocs, { ordered: false });
  if (flowDocs.length) await UsabilityFlowDaily.insertMany(flowDocs, { ordered: false });

  for (const [lk, l] of layouts) {
    const [screenKey, vwBucket] = lk.split("|");
    // Solo pisa con uno mas nuevo: recomputar un dia viejo no tiene que volver
    // a un esqueleto anterior.
    await UsabilityLayout.updateOne(
      { screenKey, vwBucket, $or: [{ capturedAt: { $lt: l.at } }, { capturedAt: { $exists: false } }] },
      { $set: { vw: l.vw, docH: l.docH, rects: l.rects, capturedAt: l.at } },
      { upsert: true },
    ).catch((err: { code?: number }) => {
      // Ya hay uno mas nuevo: el upsert choca con el indice unico. Es lo esperado.
      if (err?.code !== 11000) throw err;
    });
  }

  return screenDocs.length + heatDocs.length + flowDocs.length;
}

/**
 * Corre el rollup. Por defecto ayer y hoy (hoy queda parcial y se completa en
 * la corrida siguiente). `from`/`to` (YYYY-MM-DD) para recomputar un rango; los
 * crudos viven 30 dias, mas atras no hay nada que leer.
 */
export async function runUsabilityRollup(
  options: { from?: string; to?: string; days?: number } = {},
): Promise<{ days: string[]; docs: number }> {
  const started = Date.now();
  const days: string[] = [];
  if (options.from) {
    const to = options.to ?? dayKey(new Date());
    for (let d = new Date(`${options.from}T00:00:00Z`); dayKey(d) <= to; d = new Date(d.getTime() + 86_400_000)) {
      days.push(dayKey(d));
      if (days.length > 31) break;
    }
  } else {
    const window = options.days ?? 1;
    for (let i = window; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }

  let docs = 0;
  try {
    for (const day of days) docs += await computeUsabilityDay(day);
    await UsabilityJobState.updateOne(
      { jobId: "usability_rollup" },
      {
        $set: {
          lastRunAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
          lastDays: days,
          lastDurationMs: Date.now() - started,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    await UsabilityJobState.updateOne(
      { jobId: "usability_rollup" },
      { $set: { lastRunAt: new Date(), lastError: err instanceof Error ? err.message : String(err) } },
      { upsert: true },
    );
    throw err;
  }
  return { days, docs };
}
