import { MetricsAppDaily } from "./metricsApp.model";
import { ALL_HUBS, hubOf, labelOfHub } from "./appCatalog";

/**
 * Lectura de las métricas por app/hub.
 *
 * Los derivados de usabilidad se calculan acá, sobre los totales del rango, y
 * nunca promediando los porcentajes diarios (promediar tasas de días con
 * volúmenes distintos da un número que no significa nada).
 *
 * Ver METRICAS-COMPORTAMIENTO-SPEC.md §19.
 */

export interface AppMetricsQuery {
  dateFrom?: string;
  dateTo?: string;
  companyId?: string;
  hubKey?: string;
  appId?: string;
}

interface Folded {
  appId: string;
  hubKey: string;
  enabled: number;
  opens: number;
  users: number;
  sessions: number;
  sessionSeconds: number;
  screenViews: number;
  tasksStarted: number;
  tasksCompleted: number;
  tasksAbandoned: number;
  taskErrors: number;
  taskSecondsSum: number;
  taskSteps: number;
  daysOpened: number;
  abandonedAtStep: Record<string, number>;
  errorsByCode: Record<string, number>;
  detail: Record<string, number>;
}

function defaultRange(q: AppMetricsQuery): { from: string; to: string } {
  const to = q.dateTo ?? new Date().toISOString().slice(0, 10);
  const from =
    q.dateFrom ??
    new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from, to };
}

const NUMERIC: Array<keyof Folded> = [
  "opens",
  "users",
  "sessions",
  "sessionSeconds",
  "screenViews",
  "tasksStarted",
  "tasksCompleted",
  "tasksAbandoned",
  "taskErrors",
  "taskSecondsSum",
  "taskSteps",
];

function emptyFolded(appId: string): Folded {
  return {
    appId,
    hubKey: hubOf(appId) ?? "otros",
    enabled: 0,
    opens: 0,
    users: 0,
    sessions: 0,
    sessionSeconds: 0,
    screenViews: 0,
    tasksStarted: 0,
    tasksCompleted: 0,
    tasksAbandoned: 0,
    taskErrors: 0,
    taskSecondsSum: 0,
    taskSteps: 0,
    daysOpened: 0,
    abandonedAtStep: {},
    errorsByCode: {},
    detail: {},
  };
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 10000) / 100;
}

/**
 * Derivados de usabilidad. Los nombres siguen la terminología estándar para
 * que signifiquen lo mismo que en cualquier otro informe de UX.
 */
function usability(f: Folded) {
  return {
    /** ISO 9241-11 · efectividad: tareas completadas sobre iniciadas. */
    taskSuccessRatePct: pct(f.tasksCompleted, f.tasksStarted),
    /** Abandono explícito dentro de la tarea. */
    taskAbandonRatePct: pct(f.tasksAbandoned, f.tasksStarted),
    /** Errores por cada 100 tareas iniciadas. */
    errorRatePct: pct(f.taskErrors, f.tasksStarted),
    /** ISO 9241-11 · eficiencia: segundos medios por tarea completada. */
    avgTaskSeconds: f.tasksCompleted
      ? Math.round(f.taskSecondsSum / f.tasksCompleted)
      : null,
    /** Pasos medios por tarea completada: cuánto recorrido cuesta lograrla. */
    avgTaskSteps: f.tasksCompleted
      ? Math.round((f.taskSteps / f.tasksCompleted) * 10) / 10
      : null,
    /** HEART · engagement: duración media de una sesión de uso de la app. */
    avgSessionSeconds: f.sessions
      ? Math.round(f.sessionSeconds / f.sessions)
      : null,
    /** Profundidad: pantallas por sesión. */
    screensPerSession: f.sessions
      ? Math.round((f.screenViews / f.sessions) * 10) / 10
      : null,
  };
}

export const metricsAppService = {
  /**
   * Todas las apps agrupadas por hub. Es la vista que pidió el piloto: cada
   * app con su usabilidad comparable y su detalle propio.
   */
  async byHub(q: AppMetricsQuery) {
    const range = defaultRange(q);
    const filter: Record<string, unknown> = {
      day: { $gte: range.from, $lte: range.to },
      scope: q.companyId ? "company" : "global",
    };
    if (q.companyId) filter.companyId = q.companyId;
    if (q.hubKey) filter.hubKey = q.hubKey;
    if (q.appId) filter.appId = q.appId;

    const rows = await MetricsAppDaily.find(filter).sort({ day: 1 }).lean();

    const byApp = new Map<string, Folded>();
    for (const r of rows) {
      const appId = String(r.appId);
      let f = byApp.get(appId);
      if (!f) {
        f = emptyFolded(appId);
        byApp.set(appId, f);
      }
      for (const k of NUMERIC) {
        (f[k] as number) += Number(r[k as keyof typeof r] ?? 0);
      }
      // `enabled` es un stock: vale el último día del rango, no la suma.
      f.enabled = Number(r.enabled ?? 0);
      if (Number(r.opened ?? 0) > 0) f.daysOpened += 1;
      for (const [sub, n] of Object.entries(
        (r.abandonedAtStep ?? {}) as Record<string, number>,
      )) {
        f.abandonedAtStep[sub] = (f.abandonedAtStep[sub] ?? 0) + n;
      }
      for (const [sub, n] of Object.entries(
        (r.errorsByCode ?? {}) as Record<string, number>,
      )) {
        f.errorsByCode[sub] = (f.errorsByCode[sub] ?? 0) + n;
      }
      for (const [sub, n] of Object.entries(
        (r.detail ?? {}) as Record<string, number>,
      )) {
        // Los stocks del detalle (sitios, páginas, popups, reglas) no se suman
        // día a día: se toma el último. Los contadores de actividad sí.
        f.detail[sub] = STOCK_DETAIL.has(sub)
          ? Number(n ?? 0)
          : (f.detail[sub] ?? 0) + Number(n ?? 0);
      }
    }

    const apps = [...byApp.values()].map((f) => ({
      ...f,
      ...usability(f),
      /** Días del rango con al menos una apertura: constancia de uso. */
      daysOpened: f.daysOpened,
    }));

    const hubs = ALL_HUBS.filter((h) => !q.hubKey || h.key === q.hubKey).map(
      (h) => {
        const hubApps = apps.filter((a) => a.hubKey === h.key);
        const agg = hubApps.reduce(
          (acc, a) => {
            acc.opens += a.opens;
            acc.sessions += a.sessions;
            acc.sessionSeconds += a.sessionSeconds;
            acc.tasksStarted += a.tasksStarted;
            acc.tasksCompleted += a.tasksCompleted;
            acc.taskErrors += a.taskErrors;
            acc.users = Math.max(acc.users, a.users);
            return acc;
          },
          {
            opens: 0,
            sessions: 0,
            sessionSeconds: 0,
            tasksStarted: 0,
            tasksCompleted: 0,
            taskErrors: 0,
            users: 0,
          },
        );
        return {
          hubKey: h.key,
          label: labelOfHub(h.key),
          appCount: h.apps.length,
          appsUsed: hubApps.filter((a) => a.opens > 0).length,
          ...agg,
          taskSuccessRatePct: pct(agg.tasksCompleted, agg.tasksStarted),
          errorRatePct: pct(agg.taskErrors, agg.tasksStarted),
          apps: hubApps.sort((a, b) => b.opens - a.opens),
        };
      },
    );

    return { range, hubs };
  },

  /** Detalle de una app concreta, con su serie diaria. */
  async app(appId: string, q: AppMetricsQuery) {
    const range = defaultRange(q);
    const filter: Record<string, unknown> = {
      day: { $gte: range.from, $lte: range.to },
      scope: q.companyId ? "company" : "global",
      appId,
    };
    if (q.companyId) filter.companyId = q.companyId;

    const rows = await MetricsAppDaily.find(filter).sort({ day: 1 }).lean();
    if (!rows.length) {
      return { range, appId, hubKey: hubOf(appId), found: false };
    }

    const f = emptyFolded(appId);
    for (const r of rows) {
      for (const k of NUMERIC) (f[k] as number) += Number(r[k as keyof typeof r] ?? 0);
      f.enabled = Number(r.enabled ?? 0);
      if (Number(r.opened ?? 0) > 0) f.daysOpened += 1;
      for (const [sub, n] of Object.entries(
        (r.detail ?? {}) as Record<string, number>,
      )) {
        f.detail[sub] = STOCK_DETAIL.has(sub)
          ? Number(n ?? 0)
          : (f.detail[sub] ?? 0) + Number(n ?? 0);
      }
      for (const [sub, n] of Object.entries(
        (r.abandonedAtStep ?? {}) as Record<string, number>,
      )) {
        f.abandonedAtStep[sub] = (f.abandonedAtStep[sub] ?? 0) + n;
      }
      for (const [sub, n] of Object.entries(
        (r.errorsByCode ?? {}) as Record<string, number>,
      )) {
        f.errorsByCode[sub] = (f.errorsByCode[sub] ?? 0) + n;
      }
    }

    return {
      range,
      found: true,
      ...f,
      ...usability(f),
      series: rows.map((r) => ({
        day: r.day,
        opens: r.opens ?? 0,
        sessions: r.sessions ?? 0,
        tasksStarted: r.tasksStarted ?? 0,
        tasksCompleted: r.tasksCompleted ?? 0,
        taskErrors: r.taskErrors ?? 0,
        detail: r.detail ?? {},
      })),
    };
  },
};

/**
 * Campos de `detail` que son STOCK (una foto), no actividad acumulable. Sumar
 * "sitios publicados" a lo largo de 30 días daría 30 veces el número real.
 */
const STOCK_DETAIL = new Set([
  "sitesTotal",
  "subsitesTotal",
  "subsitesPublished",
  "pages",
  "popups",
  "popupsActive",
  "customDomains",
  "withAnalytics",
  "advancedMode",
  "withWhatsappButton",
  "categories",
  "units",
  "ratePlans",
  "ratePlansActive",
  "promos",
  "promosActive",
  "dayRestrictions",
  "unitBlocks",
  "galleries",
  "media",
  "reviews",
  "reviewsResponded",
  "published",
  "rulesActive",
  "propertiesConfigured",
  "timeToReserveP50Sec",
  "timeToReserveMinSec",
  "timeToReserveMaxSec",
  "stepsToReserveP50",
]);
