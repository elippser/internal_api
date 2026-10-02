import { HIST_EDGES, UsabilityFlowDaily, UsabilityHeatDaily, UsabilityJobState, UsabilityLayout, UsabilityScreenDaily } from "./usability.model";
import { DAY_KEY, dayKey } from "./usabilityRollup.service";

/**
 * Lecturas del modulo Usabilidad (USABILIDAD-SPEC.md §5.3). Todo sale de los
 * consolidados diarios; nunca de los crudos.
 */

export interface RangeQuery {
  from: string;
  to: string;
  companyId?: string;
}

/** Pesos del indice de trabas (spec §5.2). Se devuelven para mostrarlos en la UI. */
export const FRICTION_WEIGHTS = {
  rage: 1,
  dead: 1,
  errorsShown: 2,
  jsErrors: 2,
  formInvalid: 1,
  backtracks: 1,
} as const;

export const SLOW = { lcpMs: 2500, inpMs: 200 } as const;

type Num = Record<string, number>;

/** Percentil desde un histograma de bordes fijos (interpolado dentro del tramo). */
export function histPercentile(edges: readonly number[], hist: number[] | undefined, p: number): number | null {
  if (!hist?.length) return null;
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = p * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    if (acc + hist[i] >= target) {
      const lo = i === 0 ? 0 : edges[i - 1];
      const hi = i < edges.length ? edges[i] : edges[edges.length - 1] * 2;
      const within = hist[i] ? (target - acc) / hist[i] : 0;
      return Math.round((lo + (hi - lo) * within) * 1000) / 1000;
    }
    acc += hist[i];
  }
  return edges[edges.length - 1];
}

function addHist(a: number[] | undefined, b: number[] | undefined): number[] | undefined {
  if (!b?.length) return a;
  if (!a?.length) return [...b];
  return a.map((v, i) => v + (b[i] ?? 0));
}

function addMap(a: Num, b: Num | undefined): Num {
  for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + (v as number);
  return a;
}

const SUM_FIELDS = [
  "views",
  "users",
  "sessions",
  "activeMs",
  "idleMs",
  "clicks",
  "rage",
  "dead",
  "errorsShown",
  "formInvalid",
  "jsErrors",
  "backtracks",
  "exits",
  "entries",
] as const;

export interface ScreenAgg {
  screenKey: string;
  appId: string;
  views: number;
  users: number;
  sessions: number;
  activeMs: number;
  idleMs: number;
  clicks: number;
  rage: number;
  dead: number;
  errorsShown: number;
  formInvalid: number;
  jsErrors: number;
  backtracks: number;
  exits: number;
  entries: number;
  viewsByBucket: Num;
  errorsByKind: Num;
  errorCodes: Num;
  jsSigs: Num;
  activeHist?: number[];
  scrollHist?: number[];
  lcpHist?: number[];
  inpHist?: number[];
  clsHist?: number[];
}

function emptyAgg(screenKey: string, appId: string): ScreenAgg {
  return {
    screenKey,
    appId,
    views: 0,
    users: 0,
    sessions: 0,
    activeMs: 0,
    idleMs: 0,
    clicks: 0,
    rage: 0,
    dead: 0,
    errorsShown: 0,
    formInvalid: 0,
    jsErrors: 0,
    backtracks: 0,
    exits: 0,
    entries: 0,
    viewsByBucket: {},
    errorsByKind: {},
    errorCodes: {},
    jsSigs: {},
  };
}

function fold(agg: ScreenAgg, d: Record<string, any>): void {
  for (const f of SUM_FIELDS) agg[f] += d[f] ?? 0;
  addMap(agg.viewsByBucket, d.viewsByBucket);
  addMap(agg.errorsByKind, d.errorsByKind);
  addMap(agg.errorCodes, d.errorCodes);
  addMap(agg.jsSigs, d.jsSigs);
  agg.activeHist = addHist(agg.activeHist, d.activeHist);
  agg.scrollHist = addHist(agg.scrollHist, d.scrollHist);
  agg.lcpHist = addHist(agg.lcpHist, d.lcpHist);
  agg.inpHist = addHist(agg.inpHist, d.inpHist);
  agg.clsHist = addHist(agg.clsHist, d.clsHist);
}

function frictionCount(a: Pick<ScreenAgg, keyof typeof FRICTION_WEIGHTS>): number {
  let n = 0;
  for (const [k, w] of Object.entries(FRICTION_WEIGHTS)) n += (a[k as keyof typeof FRICTION_WEIGHTS] ?? 0) * w;
  return n;
}

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** Lo que la UI necesita de una pantalla agregada (sin histogramas crudos). */
export function summarize(a: ScreenAgg) {
  const lcpP75 = histPercentile(HIST_EDGES.lcpMs, a.lcpHist, 0.75);
  const inpP75 = histPercentile(HIST_EDGES.inpMs, a.inpHist, 0.75);
  const clsP75 = histPercentile(HIST_EDGES.cls, a.clsHist, 0.75);
  const scrollViews = (a.scrollHist ?? []).reduce((x, y) => x + y, 0);
  // Alcance: % de vistas que llegaron al menos a cada decil de la pagina.
  const reach = (a.scrollHist ?? []).map((_, i) =>
    scrollViews ? Math.round(((a.scrollHist ?? []).slice(i).reduce((x, y) => x + y, 0) / scrollViews) * 1000) / 10 : 0,
  );
  const friction = frictionCount(a);
  return {
    screenKey: a.screenKey,
    appId: a.appId,
    views: a.views,
    users: a.users,
    sessions: a.sessions,
    clicks: a.clicks,
    activeSecPerView: a.views ? Math.round(a.activeMs / a.views / 100) / 10 : null,
    idleShare: a.activeMs + a.idleMs ? Math.round((a.idleMs / (a.activeMs + a.idleMs)) * 1000) / 10 : null,
    activeP50: round1(histPercentile(HIST_EDGES.activeSec, a.activeHist, 0.5)),
    activeP90: round1(histPercentile(HIST_EDGES.activeSec, a.activeHist, 0.9)),
    avgScrollReach: scrollViews
      ? Math.round(((a.scrollHist ?? []).reduce((acc, n, i) => acc + n * (i * 10 + 5), 0) / scrollViews) * 10) / 10
      : null,
    reach,
    rage: a.rage,
    dead: a.dead,
    errorsShown: a.errorsShown,
    formInvalid: a.formInvalid,
    jsErrors: a.jsErrors,
    backtracks: a.backtracks,
    exits: a.exits,
    entries: a.entries,
    exitRate: a.views ? Math.round((a.exits / a.views) * 1000) / 10 : null,
    friction,
    frictionPer100: a.views ? Math.round((friction / a.views) * 1000) / 10 : null,
    lcpP75,
    inpP75,
    clsP75,
    slow: (lcpP75 ?? 0) > SLOW.lcpMs || (inpP75 ?? 0) > SLOW.inpMs,
    viewsByBucket: a.viewsByBucket,
    errorsByKind: a.errorsByKind,
  };
}

function scopeFilter(q: RangeQuery) {
  return { day: { $gte: q.from, $lte: q.to }, companyId: q.companyId || "*" };
}

/** Periodo anterior de la misma duracion (para tendencias). */
export function previousRange(q: RangeQuery): RangeQuery {
  const from = new Date(`${q.from}T00:00:00Z`).getTime();
  const to = new Date(`${q.to}T00:00:00Z`).getTime();
  const span = to - from + 86_400_000;
  return { ...q, from: dayKey(new Date(from - span)), to: dayKey(new Date(from - 86_400_000)) };
}

export async function aggregateScreens(q: RangeQuery, appId?: string): Promise<ScreenAgg[]> {
  const filter: Record<string, unknown> = { ...scopeFilter(q), screenKey: { $ne: DAY_KEY } };
  if (appId) filter.appId = appId;
  const docs = await UsabilityScreenDaily.find(filter).lean();
  const by = new Map<string, ScreenAgg>();
  for (const d of docs) {
    const a = by.get(d.screenKey) ?? emptyAgg(d.screenKey, d.appId);
    fold(a, d);
    by.set(d.screenKey, a);
  }
  return [...by.values()];
}

/** Pantallas con pocas vistas no entran al ranking: 1 traba en 2 vistas no es un patron. */
const MIN_VIEWS_RANKING = 5;

export async function overview(q: RangeQuery) {
  const dayDocs = await UsabilityScreenDaily.find({ ...scopeFilter(q), screenKey: DAY_KEY }).sort({ day: 1 }).lean();
  const total = emptyAgg(DAY_KEY, "*");
  const series = dayDocs.map((d) => {
    fold(total, d);
    return {
      day: d.day,
      views: d.views,
      users: d.users,
      sessions: d.sessions,
      activeMin: Math.round((d.activeMs ?? 0) / 600) / 100,
      friction: frictionCount(d as unknown as ScreenAgg),
      rage: d.rage,
      errorsShown: d.errorsShown,
    };
  });
  const screens = (await aggregateScreens(q)).map(summarize);
  const ranking = screens
    .filter((s) => s.views >= MIN_VIEWS_RANKING)
    .sort((a, b) => (b.frictionPer100 ?? 0) - (a.frictionPer100 ?? 0))
    .slice(0, 10);
  const prevDocs = await UsabilityScreenDaily.find({ ...scopeFilter(previousRange(q)), screenKey: DAY_KEY }).lean();
  const prev = emptyAgg(DAY_KEY, "*");
  for (const d of prevDocs) fold(prev, d);
  const job = await UsabilityJobState.findOne({ jobId: "usability_rollup" }).lean();
  return {
    range: { from: q.from, to: q.to },
    totals: summarize(total),
    previous: prevDocs.length ? summarize(prev) : null,
    ragePer1000Clicks: total.clicks ? Math.round((total.rage / total.clicks) * 10000) / 10 : null,
    deadPer1000Clicks: total.clicks ? Math.round((total.dead / total.clicks) * 10000) / 10 : null,
    errorsPer100Views: total.views ? Math.round((total.errorsShown / total.views) * 1000) / 10 : null,
    series,
    ranking,
    screensMeasured: screens.length,
    weights: FRICTION_WEIGHTS,
    slowThresholds: SLOW,
    minViewsRanking: MIN_VIEWS_RANKING,
    job: job ? { lastSuccessAt: job.lastSuccessAt, lastError: job.lastError } : null,
  };
}

export async function screens(q: RangeQuery, appId?: string) {
  const list = (await aggregateScreens(q, appId)).map(summarize).sort((a, b) => b.views - a.views);
  return { range: { from: q.from, to: q.to }, screens: list, weights: FRICTION_WEIGHTS, slowThresholds: SLOW };
}

export async function screenDetail(q: RangeQuery, screenKey: string, vwBucket: "m" | "t" | "d") {
  const docs = await UsabilityScreenDaily.find({ ...scopeFilter(q), screenKey }).lean();
  if (!docs.length) return null;
  const agg = emptyAgg(screenKey, docs[0].appId);
  for (const d of docs) fold(agg, d);

  // Calor: global por pantalla (el calor no se parte por compañia).
  const heatDocs = await UsabilityHeatDaily.find({ day: { $gte: q.from, $lte: q.to }, screenKey, vwBucket }).lean();
  const cells = new Map<string, { c: number; r: number; n: number; rage: number; dead: number }>();
  const elements = new Map<string, Record<string, any>>();
  let heatClicks = 0;
  for (const h of heatDocs) {
    heatClicks += h.clicks ?? 0;
    for (const c of h.cells ?? []) {
      const k = `${c.c}:${c.r}`;
      const cur = cells.get(k) ?? { c: c.c!, r: c.r!, n: 0, rage: 0, dead: 0 };
      cur.n += c.n ?? 0;
      cur.rage += c.rage ?? 0;
      cur.dead += c.dead ?? 0;
      cells.set(k, cur);
    }
    for (const e of h.elements ?? []) {
      const cur = elements.get(e.sig!) ?? { sig: e.sig, tag: e.tag, role: e.role, track: e.track, n: 0, rage: 0, dead: 0, sx: 0, sy: 0 };
      cur.n += e.n ?? 0;
      cur.rage += e.rage ?? 0;
      cur.dead += e.dead ?? 0;
      cur.sx += (e.x ?? 0) * (e.n ?? 0);
      cur.sy += (e.y ?? 0) * (e.n ?? 0);
      elements.set(e.sig!, cur);
    }
  }
  const layout =
    (await UsabilityLayout.findOne({ screenKey, vwBucket }).lean()) ??
    (await UsabilityLayout.findOne({ screenKey }).sort({ capturedAt: -1 }).lean());

  const flowFilter = { day: { $gte: q.from, $lte: q.to }, companyId: q.companyId || "*" };
  const [incoming, outgoing] = await Promise.all([
    UsabilityFlowDaily.aggregate([
      { $match: { ...flowFilter, to: screenKey } },
      { $group: { _id: "$from", n: { $sum: "$n" } } },
      { $sort: { n: -1 } },
      { $limit: 8 },
    ]),
    UsabilityFlowDaily.aggregate([
      { $match: { ...flowFilter, from: screenKey } },
      { $group: { _id: "$to", n: { $sum: "$n" } } },
      { $sort: { n: -1 } },
      { $limit: 8 },
    ]),
  ]);

  const top = (m: Num, n = 10) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));

  return {
    range: { from: q.from, to: q.to },
    vwBucket,
    summary: summarize(agg),
    heat: {
      cols: 48,
      rowPx: 40,
      clicks: heatClicks,
      cells: [...cells.values()],
      elements: [...elements.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, 20)
        .map(({ sx, sy, ...e }) => ({ ...e, x: e.n ? Math.round(sx / e.n) : 0, y: e.n ? Math.round(sy / e.n) : 0 })),
    },
    layout: layout
      ? { vwBucket: layout.vwBucket, vw: layout.vw, docH: layout.docH, rects: layout.rects, capturedAt: layout.capturedAt }
      : null,
    errorCodes: top(agg.errorCodes),
    jsSigs: top(agg.jsSigs),
    incoming: incoming.map((r) => ({ screenKey: r._id as string, n: r.n as number })),
    outgoing: outgoing.map((r) => ({ screenKey: r._id as string, n: r.n as number })),
  };
}

export async function flows(q: RangeQuery, layer: string) {
  const edges = await UsabilityFlowDaily.aggregate([
    { $match: { day: { $gte: q.from, $lte: q.to }, companyId: q.companyId || "*", layer } },
    { $group: { _id: { from: "$from", to: "$to" }, n: { $sum: "$n" } } },
    { $sort: { n: -1 } },
    { $limit: 400 },
  ]);
  const layers = await UsabilityFlowDaily.distinct("layer", { day: { $gte: q.from, $lte: q.to } });
  return {
    range: { from: q.from, to: q.to },
    layer,
    layers,
    edges: edges.map((e) => ({ from: e._id.from as string, to: e._id.to as string, n: e.n as number })),
  };
}

const FRICTION_KINDS = ["rage", "dead", "errorsShown", "jsErrors", "formInvalid", "backtracks"] as const;

export async function frictions(q: RangeQuery) {
  const [cur, prev] = await Promise.all([aggregateScreens(q), aggregateScreens(previousRange(q))]);
  const prevBy = new Map(prev.map((p) => [p.screenKey, p]));
  const items: Array<Record<string, unknown>> = [];
  for (const s of cur) {
    const p = prevBy.get(s.screenKey);
    for (const kind of FRICTION_KINDS) {
      const count = s[kind];
      if (!count) continue;
      items.push({
        screenKey: s.screenKey,
        appId: s.appId,
        kind,
        count,
        per100Views: s.views ? Math.round((count / s.views) * 1000) / 10 : null,
        previous: p ? p[kind] : 0,
        views: s.views,
      });
    }
    const sum = summarize(s);
    if (sum.slow) {
      items.push({
        screenKey: s.screenKey,
        appId: s.appId,
        kind: "slow",
        count: s.views,
        lcpP75: sum.lcpP75,
        inpP75: sum.inpP75,
        views: s.views,
      });
    }
  }
  // "Lenta" cuenta vistas, no episodios: ordenada junto a las demas taparia el
  // ranking. Va al final; tiene su propio filtro en la UI.
  items.sort((a, b) => {
    const sa = a.kind === "slow" ? 1 : 0;
    const sb = b.kind === "slow" ? 1 : 0;
    return sa - sb || (b.count as number) - (a.count as number);
  });
  // Errores de JS por firma (la firma agrupa el mismo error en todas las pantallas).
  const sigs: Num = {};
  for (const s of cur) addMap(sigs, s.jsSigs);
  const errorCodes: Num = {};
  for (const s of cur) addMap(errorCodes, s.errorCodes);
  const top = (m: Num) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([key, count]) => ({ key, count }));
  return { range: { from: q.from, to: q.to }, items: items.slice(0, 200), jsSigs: top(sigs), errorCodes: top(errorCodes) };
}
