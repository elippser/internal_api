import { IaMessageLabel } from "./iaLabels.model";
import { UsabilityJobState } from "./usability.model";
import type { RangeQuery } from "./usability.service";

/**
 * Lecturas del analisis de la IA (USABILIDAD-SPEC.md §6 y §7): que le piden,
 * como, a que hora y que queda sin resolver. Sale de ia_message_labels.
 */

const STOP = new Set(
  "el la los las un una unos unas de del al a en y o que como para por con sin mi mis tu su sus se me lo le les es son esta estan hay tengo puedo puede quiero necesito hacer cual cuales cuanto cuantos cuantas donde cuando por favor hola gracias".split(
    " ",
  ),
);

/** Palabras que dicen "falta" pero no QUE falta: no separan pedidos. */
const GENERIC = new Set(
  "no disponible soportado soporta existe falla fallo error funciona integracion integrar conexion conectar opcion posibilidad todavia aun com net www".split(" "),
);

function words(q: string): string[] {
  return (
    q
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]{3,}/g) ?? []
  ).filter((w) => !STOP.has(w));
}

/**
 * Clave de grupo: raices (primeras letras) de las palabras clave, ordenadas.
 * La raiz junta "envio"/"enviar" y "reserva"/"reservas" sin un stemmer.
 */
export function questionKey(q: string): string {
  return [...new Set(words(q).map((w) => w.slice(0, 5)))].sort().slice(0, 6).join(" ");
}

/** Igual, pero sin las palabras genericas de "no se puede": agrupa pedidos. */
export function missingKey(q: string): string {
  return [...new Set(words(q).filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, 4)))].sort().slice(0, 4).join(" ");
}

function filter(q: RangeQuery) {
  return { day: { $gte: q.from, $lte: q.to }, ...(q.companyId ? { companyId: q.companyId } : {}) };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function iaOverview(q: RangeQuery) {
  const rows = await IaMessageLabel.find(filter(q)).lean();
  const llm = rows.filter((r) => r.llm);
  const count = <K extends string>(list: typeof rows, f: (r: (typeof rows)[number]) => K | null | undefined) => {
    const m: Record<string, number> = {};
    for (const r of list) {
      const k = f(r);
      if (k) m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };

  const topics = Object.entries(count(llm, (r) => r.topic))
    .map(([topic, n]) => {
      const of = llm.filter((r) => r.topic === topic);
      const judged = of.filter((r) => r.resolved && r.resolved !== "no-se-sabe");
      return {
        topic,
        n,
        resolvedPct: pct(judged.filter((r) => r.resolved === "si").length, judged.length),
        unresolved: of.filter((r) => r.resolved === "no").length,
        frustrated: of.filter((r) => (r.frustration ?? 0) >= 1).length,
      };
    })
    .sort((a, b) => b.n - a.n);

  const judged = llm.filter((r) => r.resolved && r.resolved !== "no-se-sabe");
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) heat[r.dowUtc][r.hourUtc] += 1;

  const seriesMap = new Map<string, { day: string; questions: number; unresolved: number }>();
  for (const r of rows) {
    const s = seriesMap.get(r.day) ?? { day: r.day, questions: 0, unresolved: 0 };
    s.questions += 1;
    if (r.resolved === "no") s.unresolved += 1;
    seriesMap.set(r.day, s);
  }

  const missing = new Map<string, { text: string; n: number }>();
  for (const r of llm) {
    if (!r.missingCapability) continue;
    const k = missingKey(r.missingCapability) || r.missingCapability;
    const cur = missing.get(k) ?? { text: r.missingCapability, n: 0 };
    cur.n += 1;
    missing.set(k, cur);
  }

  const job = await UsabilityJobState.findOne({ jobId: "ia_labels" }).lean();
  return {
    range: { from: q.from, to: q.to },
    totals: {
      questions: rows.length,
      sessions: new Set(rows.map((r) => r.sessionId)).size,
      users: new Set(rows.map((r) => r.userId).filter(Boolean)).size,
      labeledPct: pct(llm.length, rows.length),
      resolvedPct: pct(judged.filter((r) => r.resolved === "si").length, judged.length),
      unresolved: llm.filter((r) => r.resolved === "no").length,
      frustratedPct: pct(llm.filter((r) => (r.frustration ?? 0) >= 1).length, llm.length),
      rephrasePct: pct(rows.filter((r) => r.rephrase).length, rows.length),
      votesUp: rows.filter((r) => r.vote === "up").length,
      votesDown: rows.filter((r) => r.vote === "down").length,
      toolErrorPct: pct(rows.filter((r) => r.toolErrors > 0).length, rows.filter((r) => r.toolCount > 0).length),
      avgLength: rows.length ? Math.round(rows.reduce((a, r) => a + r.length, 0) / rows.length) : null,
    },
    topics,
    intents: count(llm, (r) => r.intent),
    resolved: count(llm, (r) => r.resolved),
    languages: count(rows, (r) => r.lang ?? "?"),
    heat,
    series: [...seriesMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    missing: [...missing.values()].sort((a, b) => b.n - a.n).slice(0, 15),
    job: job
      ? {
          lastRunAt: (job as any).lastRunAt,
          monthCostUsd: (job as any).monthCostUsd ?? 0,
          lastResult: (job as any).lastResult ?? null,
        }
      : null,
  };
}

export async function iaQuestions(
  q: RangeQuery,
  opts: { topic?: string; resolved?: string; search?: string } = {},
) {
  const f: Record<string, unknown> = { ...filter(q), llm: true, question: { $nin: [null, ""] } };
  if (opts.topic) f.topic = opts.topic;
  if (opts.resolved) f.resolved = opts.resolved;
  const rows = await IaMessageLabel.find(f).sort({ day: -1 }).lean();
  const term = (opts.search ?? "").toLowerCase().trim();

  const groups = new Map<
    string,
    { key: string; n: number; texts: Map<string, number>; topics: Map<string, number>; si: number; judged: number; sessions: string[]; frustrated: number }
  >();
  for (const r of rows) {
    const text = r.question as string;
    if (term && !text.toLowerCase().includes(term)) continue;
    const key = questionKey(text) || text;
    const g = groups.get(key) ?? { key, n: 0, texts: new Map(), topics: new Map(), si: 0, judged: 0, sessions: [] as string[], frustrated: 0 };
    g.n += 1;
    g.texts.set(text, (g.texts.get(text) ?? 0) + 1);
    if (r.topic) g.topics.set(r.topic, (g.topics.get(r.topic) ?? 0) + 1);
    if (r.resolved && r.resolved !== "no-se-sabe") {
      g.judged += 1;
      if (r.resolved === "si") g.si += 1;
    }
    if ((r.frustration ?? 0) >= 1) g.frustrated += 1;
    if (g.sessions.length < 3 && !g.sessions.includes(r.sessionId)) g.sessions.push(r.sessionId);
    groups.set(key, g);
  }
  const mode = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    range: { from: q.from, to: q.to },
    groups: [...groups.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 50)
      .map((g) => ({
        key: g.key,
        question: mode(g.texts),
        n: g.n,
        topic: mode(g.topics),
        resolvedPct: pct(g.si, g.judged),
        frustrated: g.frustrated,
        sessions: g.sessions,
      })),
  };
}
