import { getPmsConnection } from "../../shared/pmsDb";

/**
 * Analitica de los sitios web de los clientes, leida de `siteevents` del PMS
 * (un evento crudo por visita o clic, ver pms-core `models/SiteEvent.ts`).
 * Lectura pura. La ventana filtra por `createdAt`, que tiene indice por el TTL.
 */

const RANGES = [7, 30, 90];

type Row = { key: string; value: number };
type Doc = Record<string, any>;

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const rangeDays = (raw: unknown) => (RANGES.includes(Number(raw)) ? Number(raw) : 30);
const fromDate = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const range = (days: number) => ({ days, from: utcDay(fromDate(days)), to: utcDay(new Date()) });

const countIf = (cond: Doc) => ({ $sum: { $cond: [cond, 1, 0] } });
const isView = { $eq: ["$type", "view"] };
const isClick = { $eq: ["$type", "click"] };
const isWhatsapp = { $and: [isClick, { $eq: ["$kind", "whatsapp"] }] };

/** Misma regla que pms-core `utils/sitePublishing.ts`. */
const isPublished = (status: unknown) =>
  !["indraft", "draft", "inactive"].includes(String(status ?? "").trim().toLowerCase());

// El orden importa: gemini.google.com es IA antes que Google.
const SOURCES: [RegExp, string][] = [
  [/(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google)/, "ai"],
  [/(^|\.)google\./, "google"],
  [/(^|\.)bing\./, "bing"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "whatsapp"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "linkedin"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/, "x"],
];
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");
const sourceOf = (host: string) => SOURCES.find(([re]) => re.test(host))?.[1] ?? host;

/** Subsites de las companias pedidas. El arbol de paginas queda afuera: pesa megabytes. */
async function sitesOf(companyIds: string[]) {
  const conn = await getPmsConnection();
  const sites = await conn
    .collection("sites")
    .find(
      { companyId: { $in: companyIds } },
      {
        projection: {
          name: 1,
          companyId: 1,
          "sitesByLanguage._id": 1,
          "sitesByLanguage.title": 1,
          "sitesByLanguage.language": 1,
          "sitesByLanguage.status": 1,
          "sitesByLanguage.domain": 1,
          "sitesByLanguage.customHostnames": 1,
        },
      },
    )
    .toArray();
  return sites.flatMap((s: Doc) =>
    (s.sitesByLanguage || []).map((sub: Doc) => ({
      subSiteId: String(sub._id),
      companyId: String(s.companyId),
      name: String(s.name || sub.title || sub.domain || "Sitio"),
      language: (sub.language as string) || null,
      status: (sub.status as string) || null,
      domain: sub.domain ? String(sub.domain) : null,
      published: isPublished(sub.status),
      customHostnames: (sub.customHostnames || []) as unknown[],
    })),
  );
}

/** Dominios de la compania: navegar dentro del propio sitio no es una fuente de trafico. */
async function ownHosts(sites: Awaited<ReturnType<typeof sitesOf>>) {
  const conn = await getPmsConnection();
  const ids = sites.flatMap((s) => s.customHostnames);
  const custom = ids.length
    ? await conn
        .collection("customhostnames")
        .find({ _id: { $in: ids as any[] } }, { projection: { domain: 1 } })
        .toArray()
    : [];
  return new Set(
    [...sites.map((s) => s.domain), ...custom.map((c: Doc) => c.domain)]
      .filter(Boolean)
      .map((h) => bareHost(String(h))),
  );
}

export const webStatsService = {
  /** Un renglon por compania con sitio: totales del periodo, de mayor a menor. */
  async overview(daysRaw: unknown) {
    const days = rangeDays(daysRaw);
    const conn = await getPmsConnection();
    const events = conn.collection("siteevents");
    const match = { createdAt: { $gte: fromDate(days) } };
    const companyIds = (await conn.collection("sites").distinct("companyId", {})).map(String);
    const [totals, visitors, companies, sites] = await Promise.all([
      events
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: "$companyId",
              views: countIf(isView),
              clicks: countIf(isClick),
              whatsapp: countIf(isWhatsapp),
              lastDay: { $max: "$day" },
            },
          },
        ])
        .toArray(),
      events
        .aggregate(
          [
            { $match: { ...match, type: "view" } },
            { $group: { _id: { c: "$companyId", v: "$visitorId" } } },
            { $group: { _id: "$_id.c", n: { $sum: 1 } } },
          ],
          { allowDiskUse: true },
        )
        .toArray(),
      conn
        .collection("companies")
        .find({ companyId: { $in: companyIds } }, { projection: { companyId: 1, name: 1, plan: 1 } })
        .toArray(),
      sitesOf(companyIds),
    ]);
    const byCompany = new Map(totals.map((r: Doc) => [String(r._id), r]));
    const visitorsOf = new Map(visitors.map((r: Doc) => [String(r._id), r.n as number]));
    const items = companies
      .map((c: Doc) => {
        const id = String(c.companyId);
        const r: Doc = byCompany.get(id) || {};
        const own = sites.filter((s) => s.companyId === id);
        return {
          companyId: id,
          name: String(c.name || id),
          plan: c.plan || null,
          sites: own.length,
          published: own.filter((s) => s.published).length,
          views: r.views || 0,
          visitors: visitorsOf.get(id) || 0,
          clicks: r.clicks || 0,
          whatsapp: r.whatsapp || 0,
          lastDay: r.lastDay || null,
        };
      })
      .filter((c) => c.sites > 0)
      .sort((a, b) => b.visitors - a.visitors || b.views - a.views || a.name.localeCompare(b.name));
    return { range: range(days), items };
  },

  /** Detalle de una compania (todos sus sitios o uno). */
  async company(companyId: string, daysRaw: unknown, subSiteId?: string) {
    const days = rangeDays(daysRaw);
    const conn = await getPmsConnection();
    const company = await conn
      .collection("companies")
      .findOne({ companyId }, { projection: { companyId: 1, name: 1, plan: 1 } });
    if (!company) return null;
    const sites = await sitesOf([companyId]);
    const hosts = await ownHosts(sites);

    const match: Doc = { companyId, createdAt: { $gte: fromDate(days) } };
    if (subSiteId) match.subSiteId = subSiteId;
    const viewsBy = (field: string, limit: number) => [
      { $match: { type: "view" } },
      { $group: { _id: `$${field}`, value: { $sum: 1 } } },
      { $sort: { value: -1, _id: 1 } },
      { $limit: limit },
    ];
    const [f = {} as Doc] = await conn
      .collection("siteevents")
      .aggregate(
        [
          { $match: match },
          {
            $facet: {
              totals: [
                { $group: { _id: null, views: countIf(isView), clicks: countIf(isClick), whatsapp: countIf(isWhatsapp) } },
              ],
              visitors: [{ $match: { type: "view" } }, { $group: { _id: "$visitorId" } }, { $count: "n" }],
              byDay: [{ $group: { _id: "$day", views: countIf(isView), clicks: countIf(isClick) } }],
              visitorsByDay: [
                { $match: { type: "view" } },
                { $group: { _id: { d: "$day", v: "$visitorId" } } },
                { $group: { _id: "$_id.d", n: { $sum: 1 } } },
              ],
              pages: viewsBy("path", 15),
              devices: viewsBy("device", 3),
              countries: viewsBy("country", 12),
              referrers: viewsBy("referrerHost", 50),
              kinds: [
                { $match: { type: "click" } },
                { $group: { _id: "$kind", value: { $sum: 1 } } },
                { $sort: { value: -1, _id: 1 } },
              ],
              labels: [
                { $match: { type: "click" } },
                { $group: { _id: { kind: "$kind", label: "$label" }, value: { $sum: 1 } } },
                { $sort: { value: -1 } },
                { $limit: 15 },
              ],
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    const rows = (list: Doc[] = []): Row[] => list.map((r) => ({ key: String(r._id ?? ""), value: r.value }));
    const sources = new Map<string, number>();
    for (const r of (f.referrers || []) as Doc[]) {
      const host = r._id ? bareHost(String(r._id)) : null;
      if (host && hosts.has(host)) continue;
      const key = host ? sourceOf(host) : "direct";
      sources.set(key, (sources.get(key) || 0) + r.value);
    }

    const totals = f.totals?.[0] ?? { views: 0, clicks: 0, whatsapp: 0 };
    const visitors: number = f.visitors?.[0]?.n ?? 0;
    const byDay = new Map<string, Doc>((f.byDay || []).map((r: Doc) => [r._id, r]));
    const visitorsByDay = new Map<string, number>((f.visitorsByDay || []).map((r: Doc) => [r._id, r.n]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const day = utcDay(d);
      series.push({
        day,
        views: byDay.get(day)?.views ?? 0,
        visitors: visitorsByDay.get(day) ?? 0,
        clicks: byDay.get(day)?.clicks ?? 0,
      });
    }

    return {
      company: { companyId, name: String(company.name || companyId), plan: (company as Doc).plan || null },
      sites: sites.map(({ customHostnames: _hidden, ...s }) => s),
      summary: {
        range: range(days),
        totals: {
          views: totals.views,
          visitors,
          clicks: totals.clicks,
          whatsapp: totals.whatsapp,
          pagesPerVisit: visitors > 0 ? Math.round((totals.views / visitors) * 10) / 10 : 0,
        },
        series,
        pages: rows(f.pages),
        kinds: rows(f.kinds),
        labels: (f.labels || []).map((r: Doc) => ({
          kind: r._id.kind ?? "cta",
          label: r._id.label || "Sin nombre",
          value: r.value,
        })),
        devices: rows(f.devices),
        countries: rows(f.countries),
        sources: [...sources.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 13)
          .map(([key, value]) => ({ key, value })),
      },
    };
  },
};
