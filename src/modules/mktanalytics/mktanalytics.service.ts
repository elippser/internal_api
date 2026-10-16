import Joi from "joi";
import type { PipelineStage } from "mongoose";
import { MktSiteEvent } from "./mktanalytics.model";

/**
 * Analítica del sitio de marca: ingesta de los lotes que manda el proxy
 * `/api/track` de mkt-renderer y las consultas del tablero Marketing › Tráfico.
 *
 * Contrato cerrado igual que el registry de `analytics`: todo campo de `data`
 * es un código o un número. Lo único con texto libre es `label` del clic, que
 * es el copy del propio sitio (lo escribimos nosotros), nunca lo que escribe
 * el visitante. De los formularios se mide qué CAMPO se tocó, no su valor.
 */

export const MKT_EVENT_TYPES = [
  "page_view",
  "page_leave",
  "click",
  "form_view",
  "form_start",
  "form_invalid",
  "form_submit",
  "form_success",
  "form_error",
  "form_abandon",
  "video_play",
  "video_progress",
  "video_complete",
] as const;

export const CLICK_KINDS = [
  "cta",
  "signup",
  "login",
  "contact",
  "nav",
  "link",
  "anchor",
  "outbound",
  "social",
  "mail",
  "tel",
  "lang",
  "button",
] as const;

const code = Joi.string().max(80).pattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]*$/);
const fields = Joi.array().items(code).max(30);
const ms = Joi.number().integer().min(0).max(86_400_000);
const form = code.required();

const DATA_BY_TYPE: Record<(typeof MKT_EVENT_TYPES)[number], Joi.ObjectSchema> = {
  // `pv`: id de la vista, une la vista con sus salidas parciales.
  page_view: Joi.object({ pv: code, title: Joi.string().max(200).allow("") }),
  page_leave: Joi.object({
    pv: code,
    engagedMs: ms.required(),
    scroll: Joi.number().integer().min(0).max(100).required(),
  }),
  click: Joi.object({
    kind: Joi.string()
      .valid(...CLICK_KINDS)
      .required(),
    zone: code.required(),
    target: Joi.string().max(200).allow(""),
    label: Joi.string().max(120).allow(""),
  }),
  form_view: Joi.object({ form }),
  form_start: Joi.object({ form, field: code }),
  form_invalid: Joi.object({ form, fields }),
  form_submit: Joi.object({ form, fields, ms }),
  form_success: Joi.object({ form, ms }),
  form_error: Joi.object({ form, code: code.required() }),
  form_abandon: Joi.object({ form, lastField: code.allow(""), fields, ms }),
  video_play: Joi.object({ video: Joi.string().max(200).required() }),
  video_progress: Joi.object({
    video: Joi.string().max(200).required(),
    pct: Joi.number().valid(25, 50, 75).required(),
  }),
  video_complete: Joi.object({ video: Joi.string().max(200).required() }),
};

const optStr = (max: number) => Joi.string().max(max).allow(null, "");

const eventSchema = Joi.object({
  t: Joi.string()
    .valid(...MKT_EVENT_TYPES)
    .required(),
  vid: Joi.string().max(64).pattern(/^[a-z0-9]+$/).required(),
  sid: Joi.string().max(64).pattern(/^[a-z0-9]+$/).required(),
  ts: Joi.alternatives().try(Joi.date(), Joi.string().isoDate()).required(),
  path: Joi.string().max(300).required(),
  route: optStr(80),
  locale: optStr(5),
  refHost: optStr(200),
  utm: Joi.object({
    source: optStr(120),
    medium: optStr(120),
    campaign: optStr(160),
    term: optStr(120),
    content: optStr(120),
  }),
  landing: optStr(300),
  newVisitor: Joi.boolean(),
  country: optStr(2),
  region: optStr(80),
  device: Joi.string().valid("mobile", "tablet", "desktop").allow(null),
  browser: optStr(30),
  os: optStr(30),
  data: Joi.object().default({}),
});

export const ingestSchema = Joi.object({
  events: Joi.array().items(Joi.object().unknown(true)).min(1).max(50).required(),
});

// ── Canal ────────────────────────────────────────────────────────────────

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|search\.brave|ecosia|yandex|baidu|qwant|startpage)\./;
const AI = /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com)$/;
const SOCIAL =
  /(^|\.)(instagram|facebook|fb|linkedin|lnkd|t|x|twitter|tiktok|youtube|youtu|whatsapp|wa|threads|pinterest|reddit)\.(com|me|co|net|in|be)$/;
const OWN = /(^|\.)roombir\.com$/;

/**
 * Canal de la sesión, con las reglas de siempre: lo que declara la campaña
 * (`utm_medium`) manda sobre el referente, porque un anuncio de Instagram
 * llega con referente de Instagram y es pago, no social.
 */
export function channelOf(refHost: string | null, utm?: { source?: string; medium?: string } | null): string {
  const medium = (utm?.medium ?? "").toLowerCase();
  const source = (utm?.source ?? "").toLowerCase();
  if (/^(cpc|ppc|paid|paid[-_ ]?social|paidsocial|display|cpm|ads?)$/.test(medium)) return "paid";
  if (/e-?mail|newsletter/.test(medium)) return "email";
  if (/social/.test(medium)) return "social";
  if (/referral|partner|affiliate/.test(medium)) return "referral";
  const host = (refHost ?? "").toLowerCase();
  if (host && AI.test(host)) return "ai";
  if (/chatgpt|perplexity|claude|gemini|copilot/.test(source)) return "ai";
  if (host && SEARCH.test(host)) return "search";
  if (host && SOCIAL.test(host)) return "social";
  if (/instagram|facebook|linkedin|tiktok|youtube|whatsapp|twitter|^x$|^ig$|^fb$/.test(source)) return "social";
  if (/google|bing/.test(source)) return "search";
  if (host && !OWN.test(host)) return "referral";
  if (source) return "referral";
  return "direct";
}

// ── Ingesta ──────────────────────────────────────────────────────────────

let droppedTotal = 0;

export async function ingest(raw: unknown[]): Promise<{ accepted: number; dropped: number }> {
  const docs: Record<string, unknown>[] = [];
  const now = new Date();
  for (const item of raw) {
    const { value, error } = eventSchema.validate(item, { stripUnknown: true });
    if (error) continue;
    const dataSchema = DATA_BY_TYPE[value.t as keyof typeof DATA_BY_TYPE];
    const data = dataSchema.validate(value.data ?? {}, { stripUnknown: true });
    if (data.error) continue;

    const ts = new Date(value.ts);
    // Un reloj del navegador desfasado no puede mover el evento de día: el eje
    // es `at` (servidor). `ts` sólo ordena dentro de la sesión.
    const utm = value.utm
      ? Object.fromEntries(Object.entries(value.utm).filter(([, v]) => Boolean(v)))
      : undefined;
    docs.push({
      ...value,
      ts: Number.isNaN(ts.getTime()) ? now : ts,
      at: now,
      utm: utm && Object.keys(utm).length ? utm : undefined,
      refHost: value.refHost || null,
      channel: channelOf(value.refHost || null, utm),
      data: Object.keys(data.value).length ? data.value : undefined,
    });
  }
  const dropped = raw.length - docs.length;
  droppedTotal += dropped;
  if (docs.length) await MktSiteEvent.insertMany(docs, { ordered: false });
  return { accepted: docs.length, dropped };
}

export function ingestHealth() {
  return { droppedTotal };
}

// ── Consultas ────────────────────────────────────────────────────────────

export interface Range {
  from: Date;
  to: Date;
}

/** `dateFrom`/`dateTo` son días UTC inclusivos, como en Métricas. */
export function parseRange(q: { dateFrom?: string; dateTo?: string }): Range {
  const today = new Date().toISOString().slice(0, 10);
  const toDay = q.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(q.dateTo) ? q.dateTo : today;
  const to = new Date(`${toDay}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  let from: Date;
  if (q.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(q.dateFrom)) {
    from = new Date(`${q.dateFrom}T00:00:00.000Z`);
  } else {
    from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 30);
  }
  return { from, to };
}

const inRange = (r: Range) => ({ at: { $gte: r.from, $lt: r.to } });
const isType = (t: string) => ({ $eq: ["$t", t] });
const flag = (cond: unknown) => ({ $max: { $cond: [cond, 1, 0] } });

/** Clics que cuentan como intención: los CTA y los que llevan al alta o al contacto. */
const INTENT_KINDS = ["cta", "signup", "contact"];

/** Una fila por sesión. Es la base de KPIs, canales, países y embudo. */
function sessionStages(r: Range): PipelineStage[] {
  return [
    { $match: inRange(r) },
    { $sort: { ts: 1 } },
    {
      $group: {
        _id: "$sid",
        vid: { $first: "$vid" },
        start: { $min: "$at" },
        channel: { $first: "$channel" },
        refHost: { $first: "$refHost" },
        utm: { $first: "$utm" },
        landing: { $first: "$route" },
        landingPath: { $first: "$path" },
        locale: { $first: "$locale" },
        country: { $first: "$country" },
        region: { $first: "$region" },
        device: { $first: "$device" },
        browser: { $first: "$browser" },
        os: { $first: "$os" },
        newVisitor: { $max: { $cond: ["$newVisitor", 1, 0] } },
        pageviews: { $sum: { $cond: [isType("page_view"), 1, 0] } },
        clicks: { $sum: { $cond: [isType("click"), 1, 0] } },
        engagedMs: { $sum: { $cond: [isType("page_leave"), "$data.engagedMs", 0] } },
        intent: flag({
          $and: [isType("click"), { $in: ["$data.kind", INTENT_KINDS] }],
        }),
        formStart: flag(isType("form_start")),
        formSubmit: flag(isType("form_submit")),
        lead: flag({ $and: [isType("form_success"), { $eq: ["$data.form", "lead"] }] }),
        signup: flag({ $and: [isType("form_success"), { $eq: ["$data.form", "signup"] }] }),
      },
    },
    {
      $addFields: {
        converted: { $max: ["$lead", "$signup"] },
        bounced: {
          $cond: [
            {
              $and: [
                { $lte: ["$pageviews", 1] },
                { $eq: ["$clicks", 0] },
                { $lt: ["$engagedMs", 10_000] },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  ];
}

function breakdown(field: string, limit = 12): PipelineStage.FacetPipelineStage[] {
  return [
    {
      $group: {
        _id: { $ifNull: [field, null] },
        sessions: { $sum: 1 },
        visitors: { $addToSet: "$vid" },
        conversions: { $sum: "$converted" },
        bounced: { $sum: "$bounced" },
      },
    },
    { $sort: { sessions: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        key: "$_id",
        sessions: 1,
        visitors: { $size: "$visitors" },
        conversions: 1,
        bounced: 1,
      },
    },
  ];
}

/** Sesiones por provincia o estado, con su país: la misma provincia puede existir en dos. */
function regionBreakdown(limit = 400): PipelineStage.FacetPipelineStage[] {
  return [
    { $match: { country: { $ne: null } } },
    {
      $group: {
        _id: { country: "$country", region: { $ifNull: ["$region", null] } },
        sessions: { $sum: 1 },
        visitors: { $addToSet: "$vid" },
        conversions: { $sum: "$converted" },
        bounced: { $sum: "$bounced" },
      },
    },
    { $sort: { sessions: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        country: "$_id.country",
        region: "$_id.region",
        sessions: 1,
        visitors: { $size: "$visitors" },
        conversions: 1,
        bounced: 1,
      },
    },
  ];
}

function dayList(r: Range): string[] {
  const out: string[] = [];
  const d = new Date(r.from);
  while (d < r.to) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function overview(r: Range) {
  const [sessionFacets] = await MktSiteEvent.aggregate([
    ...sessionStages(r),
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              sessions: { $sum: 1 },
              visitors: { $addToSet: "$vid" },
              newVisitors: { $sum: "$newVisitor" },
              pageviews: { $sum: "$pageviews" },
              clicks: { $sum: "$clicks" },
              engagedMs: { $sum: "$engagedMs" },
              bounced: { $sum: "$bounced" },
              intent: { $sum: "$intent" },
              formStart: { $sum: "$formStart" },
              formSubmit: { $sum: "$formSubmit" },
              leads: { $sum: "$lead" },
              signups: { $sum: "$signup" },
              converted: { $sum: "$converted" },
            },
          },
          { $addFields: { visitors: { $size: "$visitors" } } },
          { $project: { _id: 0 } },
        ],
        daily: [
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$start" } },
              sessions: { $sum: 1 },
              visitors: { $addToSet: "$vid" },
              pageviews: { $sum: "$pageviews" },
              conversions: { $sum: "$converted" },
              intent: { $sum: "$intent" },
            },
          },
          {
            $project: {
              _id: 0,
              day: "$_id",
              sessions: 1,
              visitors: { $size: "$visitors" },
              pageviews: 1,
              conversions: 1,
              intent: 1,
            },
          },
        ],
        channels: breakdown("$channel"),
        sources: breakdown("$refHost"),
        campaigns: breakdown("$utm.campaign"),
        utmSources: breakdown("$utm.source"),
        countries: breakdown("$country", 250),
        regions: regionBreakdown(),
        devices: breakdown("$device"),
        locales: breakdown("$locale"),
        browsers: breakdown("$browser"),
        os: breakdown("$os"),
        landings: breakdown("$landing", 15),
      },
    },
  ]);

  const [pages, ctas, forms, formFields, abandonFields, formErrors, videos] = await Promise.all([
    pagesTable(r),
    ctaTable(r),
    formsTable(r),
    fieldTable(r, "form_invalid", "$data.fields"),
    fieldTable(r, "form_abandon", "$data.lastField"),
    errorTable(r),
    videoTable(r),
  ]);

  const byDay = new Map<string, Record<string, number>>(
    (sessionFacets?.daily ?? []).map((d: { day: string } & Record<string, number>) => [d.day, d]),
  );
  const daily = dayList(r).map((day) => ({
    day,
    sessions: byDay.get(day)?.sessions ?? 0,
    visitors: byDay.get(day)?.visitors ?? 0,
    pageviews: byDay.get(day)?.pageviews ?? 0,
    conversions: byDay.get(day)?.conversions ?? 0,
    intent: byDay.get(day)?.intent ?? 0,
  }));

  return {
    range: { from: r.from.toISOString(), to: r.to.toISOString() },
    totals: sessionFacets?.totals?.[0] ?? null,
    daily,
    channels: sessionFacets?.channels ?? [],
    sources: sessionFacets?.sources ?? [],
    campaigns: sessionFacets?.campaigns ?? [],
    utmSources: sessionFacets?.utmSources ?? [],
    countries: sessionFacets?.countries ?? [],
    regions: sessionFacets?.regions ?? [],
    devices: sessionFacets?.devices ?? [],
    locales: sessionFacets?.locales ?? [],
    browsers: sessionFacets?.browsers ?? [],
    os: sessionFacets?.os ?? [],
    landings: sessionFacets?.landings ?? [],
    pages,
    ctas,
    forms,
    formFields,
    abandonFields,
    formErrors,
    videos,
    ingest: ingestHealth(),
  };
}

/**
 * Por página: vistas, visitantes, tiempo de atención y scroll.
 *
 * Primero se junta cada VISTA (`data.pv`): el tracker manda un `page_leave`
 * parcial cada vez que la pestaña se oculta (en el móvil es el último momento
 * confiable) y otro al irse, cada uno con la atención desde el anterior y el
 * scroll máximo hasta ahí. Una vista = suma de atención y máximo de scroll.
 */
async function pagesTable(r: Range) {
  return MktSiteEvent.aggregate([
    { $match: { ...inRange(r), t: { $in: ["page_view", "page_leave"] } } },
    {
      $group: {
        _id: { route: { $ifNull: ["$route", "$path"] }, pv: { $ifNull: ["$data.pv", "$_id"] } },
        viewed: { $max: { $cond: [isType("page_view"), 1, 0] } },
        left: { $max: { $cond: [isType("page_leave"), 1, 0] } },
        vid: { $first: "$vid" },
        path: { $first: "$path" },
        engagedMs: { $sum: { $cond: [isType("page_leave"), "$data.engagedMs", 0] } },
        scroll: { $max: { $cond: [isType("page_leave"), "$data.scroll", null] } },
      },
    },
    {
      $group: {
        _id: "$_id.route",
        views: { $sum: "$viewed" },
        visitors: { $addToSet: { $cond: [{ $eq: ["$viewed", 1] }, "$vid", "$$REMOVE"] } },
        measured: { $sum: { $cond: [{ $and: [{ $eq: ["$viewed", 1] }, { $eq: ["$left", 1] }] }, 1, 0] } },
        engagedMs: { $sum: { $cond: [{ $eq: ["$viewed", 1] }, "$engagedMs", 0] } },
        scroll: { $sum: { $cond: [{ $and: [{ $eq: ["$viewed", 1] }, { $eq: ["$left", 1] }] }, "$scroll", 0] } },
        reached75: {
          $sum: {
            $cond: [{ $and: [{ $eq: ["$viewed", 1] }, { $gte: ["$scroll", 75] }] }, 1, 0],
          },
        },
        samplePath: { $first: "$path" },
      },
    },
    { $match: { views: { $gt: 0 } } },
    { $sort: { views: -1 } },
    { $limit: 60 },
    {
      $project: {
        _id: 0,
        route: "$_id",
        path: "$samplePath",
        views: 1,
        visitors: { $size: "$visitors" },
        // Sobre las vistas que ya cerraron: una vista abierta todavía no
        // reportó su atención y bajaría el promedio.
        avgEngagedMs: {
          $cond: [{ $gt: ["$measured", 0] }, { $round: [{ $divide: ["$engagedMs", "$measured"] }, 0] }, null],
        },
        avgScroll: {
          $cond: [{ $gt: ["$measured", 0] }, { $round: [{ $divide: ["$scroll", "$measured"] }, 0] }, null],
        },
        reached75: {
          $cond: [{ $gt: ["$measured", 0] }, { $divide: ["$reached75", "$measured"] }, null],
        },
      },
    },
  ]);
}

/**
 * Por botón. Se agrupa por destino + zona + tipo y NO por el texto: el mismo
 * botón dice cinco cosas distintas en cinco idiomas. El texto viaja como
 * muestra para reconocerlo.
 */
async function ctaTable(r: Range) {
  return MktSiteEvent.aggregate([
    { $match: { ...inRange(r), t: "click" } },
    {
      $group: {
        _id: { kind: "$data.kind", target: "$data.target", zone: "$data.zone" },
        clicks: { $sum: 1 },
        sessions: { $addToSet: "$sid" },
        labels: { $addToSet: "$data.label" },
        pages: { $addToSet: { $ifNull: ["$route", "$path"] } },
      },
    },
    { $sort: { clicks: -1 } },
    { $limit: 80 },
    {
      $project: {
        _id: 0,
        kind: "$_id.kind",
        target: "$_id.target",
        zone: "$_id.zone",
        clicks: 1,
        sessions: { $size: "$sessions" },
        label: { $arrayElemAt: ["$labels", 0] },
        pages: { $slice: ["$pages", 6] },
      },
    },
  ]);
}

/** Embudo de cada formulario, en sesiones distintas por paso. */
async function formsTable(r: Range) {
  const rows: { form: string; t: string; sessions: number; events: number; avgMs: number | null }[] =
    await MktSiteEvent.aggregate([
      { $match: { ...inRange(r), t: { $regex: /^form_/ } } },
      {
        $group: {
          _id: { form: "$data.form", t: "$t" },
          sessions: { $addToSet: "$sid" },
          events: { $sum: 1 },
          avgMs: { $avg: "$data.ms" },
        },
      },
      {
        $project: {
          _id: 0,
          form: "$_id.form",
          t: "$_id.t",
          sessions: { $size: "$sessions" },
          events: 1,
          avgMs: 1,
        },
      },
    ]);
  const byForm = new Map<string, Record<string, number | null>>();
  for (const row of rows) {
    const cur = byForm.get(row.form) ?? {};
    cur[row.t.replace("form_", "")] = row.sessions;
    if (row.t === "form_success") cur.avgMsToSuccess = row.avgMs ? Math.round(row.avgMs) : null;
    if (row.t === "form_invalid") cur.invalidEvents = row.events;
    byForm.set(row.form, cur);
  }
  return [...byForm.entries()].map(([form, s]) => ({
    form,
    view: s.view ?? 0,
    start: s.start ?? 0,
    invalid: s.invalid ?? 0,
    submit: s.submit ?? 0,
    success: s.success ?? 0,
    error: s.error ?? 0,
    abandon: s.abandon ?? 0,
    invalidEvents: s.invalidEvents ?? 0,
    avgMsToSuccess: s.avgMsToSuccess ?? null,
  }));
}

async function fieldTable(r: Range, t: string, field: string) {
  return MktSiteEvent.aggregate([
    { $match: { ...inRange(r), t } },
    ...(field === "$data.fields" ? [{ $unwind: "$data.fields" } as PipelineStage] : []),
    { $match: { [field.slice(1)]: { $nin: [null, ""] } } },
    { $group: { _id: { form: "$data.form", field }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 30 },
    { $project: { _id: 0, form: "$_id.form", field: "$_id.field", count: 1 } },
  ]);
}

async function errorTable(r: Range) {
  return MktSiteEvent.aggregate([
    { $match: { ...inRange(r), t: "form_error" } },
    { $group: { _id: { form: "$data.form", code: "$data.code" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
    { $project: { _id: 0, form: "$_id.form", code: "$_id.code", count: 1 } },
  ]);
}

async function videoTable(r: Range) {
  const rows: { video: string; t: string; pct: number | null; sessions: number }[] =
    await MktSiteEvent.aggregate([
      { $match: { ...inRange(r), t: { $regex: /^video_/ } } },
      {
        $group: {
          _id: { video: "$data.video", t: "$t", pct: "$data.pct" },
          sessions: { $addToSet: "$sid" },
        },
      },
      {
        $project: {
          _id: 0,
          video: "$_id.video",
          t: "$_id.t",
          pct: "$_id.pct",
          sessions: { $size: "$sessions" },
        },
      },
    ]);
  const byVideo = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const cur = byVideo.get(row.video) ?? {};
    const key = row.t === "video_progress" ? `p${row.pct}` : row.t.replace("video_", "");
    cur[key] = (cur[key] ?? 0) + row.sessions;
    byVideo.set(row.video, cur);
  }
  return [...byVideo.entries()]
    .map(([video, s]) => ({
      video,
      play: s.play ?? 0,
      p25: s.p25 ?? 0,
      p50: s.p50 ?? 0,
      p75: s.p75 ?? 0,
      complete: s.complete ?? 0,
    }))
    .sort((a, b) => b.play - a.play);
}

/** Quién está ahora: sesiones con algún evento en los últimos 5 minutos. */
export async function realtime() {
  const since = new Date(Date.now() - 5 * 60_000);
  const rows = await MktSiteEvent.aggregate([
    { $match: { at: { $gte: since } } },
    { $sort: { ts: 1 } },
    {
      $group: {
        _id: "$sid",
        vid: { $last: "$vid" },
        path: { $last: "$path" },
        route: { $last: "$route" },
        country: { $last: "$country" },
        region: { $last: "$region" },
        device: { $last: "$device" },
        channel: { $first: "$channel" },
        last: { $max: "$at" },
      },
    },
    { $sort: { last: -1 } },
    { $limit: 50 },
    { $project: { _id: 0, sid: "$_id", vid: 1, path: 1, route: 1, country: 1, region: 1, device: 1, channel: 1, last: 1 } },
  ]);
  return { active: new Set(rows.map((x) => x.vid)).size, sessions: rows };
}

/** Las últimas sesiones con su recorrido, para leer casos concretos. */
export async function recentSessions(r: Range, limit = 40) {
  const sessions = await MktSiteEvent.aggregate([
    ...sessionStages(r),
    { $sort: { start: -1 } },
    { $limit: Math.min(Math.max(limit, 1), 100) },
    { $project: { sid: "$_id", _id: 0, vid: 1, start: 1, channel: 1, refHost: 1, utm: 1, landing: 1, landingPath: 1, country: 1, region: 1, device: 1, browser: 1, locale: 1, pageviews: 1, clicks: 1, engagedMs: 1, converted: 1, lead: 1, signup: 1, newVisitor: 1, bounced: 1 } },
  ]);
  return sessions;
}

export async function sessionTimeline(sid: string) {
  return MktSiteEvent.find({ sid })
    .sort({ ts: 1 })
    .limit(300)
    .select({ _id: 0, t: 1, ts: 1, at: 1, path: 1, route: 1, data: 1 })
    .lean();
}
