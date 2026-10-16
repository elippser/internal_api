import { AnalyticsEvent } from "../analytics/analytics.model";
import { Lead } from "../leads/leads.model";
import { MktSiteEvent } from "./mktanalytics.model";
import { channelOf, type Range } from "./mktanalytics.service";

/**
 * El recorrido completo de alta: del sitio al final del onboarding del PMS.
 *
 * Son tres fuentes que ya existían por separado y acá se cosen:
 *
 *   mkt_site_events   visita → abre /crear-cuenta → empieza el formulario
 *        │ (lead.attribution.vid = el `vid` del visitante; canal del primer contacto)
 *   leads             envía el formulario → abre el enlace del correo → crea la cuenta
 *        │ (lead.registeredUserId = el `userId` de los eventos del PMS)
 *   analytics_events  empieza el onboarding → llega a habitaciones → lo termina
 *
 * Dos cohortes, y está bien que así sea: los pasos del sitio cuentan VISITANTES
 * del período; del formulario en adelante, los LEADS creados en el período,
 * seguidos hasta hoy (un lead de ayer que termina el onboarding mañana suma en
 * la fila de ayer). Los `spam` del filtro no son personas y no cuentan.
 */

export const JOURNEY_GROUPS = ["channel", "campaign", "source"] as const;
export type JourneyGroup = (typeof JOURNEY_GROUPS)[number];

export const JOURNEY_STAGES = [
  { key: "visitors", label: "Visitaron el sitio" },
  { key: "signupView", label: "Abrieron crear cuenta" },
  { key: "formStart", label: "Empezaron el formulario" },
  /** Los leads que vienen de una visita medida: el cierre del embudo del sitio. */
  { key: "siteLeads", label: "Enviaron el formulario" },
  { key: "leads", label: "Enviaron el formulario" },
  { key: "opened", label: "Abrieron el enlace del correo" },
  { key: "registered", label: "Crearon la cuenta" },
  { key: "onbStarted", label: "Empezaron el onboarding" },
  { key: "onbRooms", label: "Llegaron a habitaciones" },
  { key: "onbCompleted", label: "Terminaron el onboarding" },
] as const;
type StageKey = (typeof JOURNEY_STAGES)[number]["key"];

/** Los nueve pasos del alta guiada del PMS (ver ROOMBIR-FULL-SYSTEM.md §9.1). */
export const ONBOARDING_STEPS = [
  "Bienvenida",
  "Tu empresa",
  "Tu propiedad",
  "Identidad de marca",
  "Tu operación",
  "Habitaciones",
  "Promociones",
  "Motor de reservas",
  "Recorridos",
] as const;

/** Sin dato de origen: leads anteriores a la atribución (16-10-2026). */
const UNKNOWN = "sin_dato";
/** El pedido de acceso desde el /register del PMS, que no pasa por el sitio. */
const APP = "app";
/** El enlace que genera un operador en el panel (alguien contactado a mano). */
const PANEL = "panel";

type Counts = Record<StageKey, number>;
const zero = (): Counts =>
  Object.fromEntries(JOURNEY_STAGES.map((s) => [s.key, 0])) as Counts;

interface LeadRow {
  leadId: string;
  hotelName: string;
  lodgingType: string;
  units: number | null;
  countryCode: string;
  status: string;
  source?: string;
  createdAt: Date;
  utm?: Record<string, string>;
  referer?: string;
  attribution?: { vid?: string; channel?: string };
  invite?: { openedAt?: Date | null; usedAt?: Date | null };
  registeredUserId?: string | null;
  registeredAt?: Date | null;
}

interface OnboardingRow {
  _id: string;
  started: number;
  rooms: number;
  completed: number;
  maxStep: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastAt: Date;
}

function leadKey(lead: LeadRow, group: JourneyGroup): string {
  const utm = lead.utm ?? {};
  if (group === "campaign") return utm.utm_campaign || UNKNOWN;
  if (group === "source") return utm.utm_source || UNKNOWN;
  if (lead.attribution?.channel) return lead.attribution.channel;
  if (lead.source === "manual") return PANEL;
  if (/\/register/.test(lead.referer ?? "")) return APP;
  if (utm.utm_source || utm.utm_medium) {
    return channelOf(null, { source: utm.utm_source, medium: utm.utm_medium });
  }
  return UNKNOWN;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const HOUR = 3_600_000;

export async function journey(r: Range, group: JourneyGroup) {
  // ── 1. El sitio: un visitante por fila, con el canal de su primera sesión ──
  const siteKey =
    group === "campaign" ? "$utm.campaign" : group === "source" ? "$utm.source" : "$channel";
  const isSignupForm = { $eq: ["$data.form", "signup"] };
  const siteRows: { _id: string | null; visitors: number; signupView: number; formStart: number }[] =
    await MktSiteEvent.aggregate([
      { $match: { at: { $gte: r.from, $lt: r.to } } },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: "$vid",
          key: { $first: siteKey },
          signupView: {
            $max: {
              $cond: [
                {
                  $or: [
                    { $and: [{ $eq: ["$t", "form_view"] }, isSignupForm] },
                    { $and: [{ $eq: ["$t", "page_view"] }, { $regexMatch: { input: "$path", regex: "/crear-cuenta" } }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          formStart: { $max: { $cond: [{ $and: [{ $eq: ["$t", "form_start"] }, isSignupForm] }, 1, 0] } },
        },
      },
      {
        $group: {
          _id: "$key",
          visitors: { $sum: 1 },
          signupView: { $sum: "$signupView" },
          formStart: { $sum: "$formStart" },
        },
      },
    ]);

  // ── 2. Los leads del período ──
  const leads = (await Lead.find(
    { createdAt: { $gte: r.from, $lt: r.to }, status: { $ne: "spam" } },
    {
      leadId: 1,
      hotelName: 1,
      lodgingType: 1,
      units: 1,
      countryCode: 1,
      status: 1,
      source: 1,
      createdAt: 1,
      utm: 1,
      referer: 1,
      attribution: 1,
      invite: 1,
      registeredUserId: 1,
      registeredAt: 1,
    },
  )
    .sort({ createdAt: -1 })
    .lean()) as unknown as LeadRow[];

  // ── 3. El onboarding de los que crearon la cuenta ──
  const userIds = leads.map((l) => l.registeredUserId).filter((u): u is string => Boolean(u));
  const onboarding: OnboardingRow[] = userIds.length
    ? await AnalyticsEvent.aggregate([
        { $match: { userId: { $in: userIds }, eventName: { $regex: "^onboarding_" } } },
        {
          $group: {
            _id: "$userId",
            started: { $max: { $cond: [{ $in: ["$eventName", ["onboarding_started", "onboarding_step_completed", "onboarding_resumed"]] }, 1, 0] } },
            rooms: { $max: { $cond: [{ $eq: ["$eventName", "onboarding_rooms_started"] }, 1, 0] } },
            completed: { $max: { $cond: [{ $eq: ["$eventName", "onboarding_completed"] }, 1, 0] } },
            maxStep: { $max: { $cond: [{ $eq: ["$eventName", "onboarding_step_completed"] }, "$payload.stepIndex", null] } },
            startedAt: { $min: { $cond: [{ $eq: ["$eventName", "onboarding_started"] }, "$serverTimestamp", null] } },
            completedAt: { $min: { $cond: [{ $eq: ["$eventName", "onboarding_completed"] }, "$serverTimestamp", null] } },
            lastAt: { $max: "$serverTimestamp" },
          },
        },
      ])
    : [];
  const onbByUser = new Map(onboarding.map((o) => [o._id, o]));

  // ── 4. Coser ──
  const byKey = new Map<string, Counts>();
  const bucket = (key: string) => {
    let c = byKey.get(key);
    if (!c) byKey.set(key, (c = zero()));
    return c;
  };
  for (const row of siteRows) {
    const c = bucket(row._id || (group === "channel" ? "direct" : UNKNOWN));
    c.visitors += row.visitors;
    c.signupView += row.signupView;
    c.formStart += row.formStart;
  }

  const stoppedAt = new Array(ONBOARDING_STEPS.length).fill(0) as number[];
  const toRegister: number[] = [];
  const toComplete: number[] = [];

  const people = leads.map((lead) => {
    const key = leadKey(lead, group);
    const c = bucket(key);
    const opened = Boolean(lead.invite?.openedAt || lead.invite?.usedAt || lead.registeredUserId);
    const registered = Boolean(lead.registeredUserId);
    const onb = registered ? onbByUser.get(lead.registeredUserId!) : undefined;
    c.leads++;
    if (lead.attribution?.vid) c.siteLeads++;
    if (opened) c.opened++;
    if (registered) c.registered++;
    if (onb?.started) c.onbStarted++;
    if (onb?.rooms) c.onbRooms++;
    if (onb?.completed) c.onbCompleted++;

    // Dónde se quedó: el paso siguiente al último que completó.
    if (onb?.started && !onb.completed) {
      const at = Math.min((onb.maxStep ?? -1) + 1, ONBOARDING_STEPS.length - 1);
      stoppedAt[at]++;
    }
    if (registered && lead.registeredAt) {
      toRegister.push((new Date(lead.registeredAt).getTime() - new Date(lead.createdAt).getTime()) / HOUR);
    }
    if (onb?.completed && onb.completedAt && lead.registeredAt) {
      toComplete.push((new Date(onb.completedAt).getTime() - new Date(lead.registeredAt).getTime()) / HOUR);
    }

    const stage: StageKey = onb?.completed
      ? "onbCompleted"
      : onb?.rooms
        ? "onbRooms"
        : onb?.started
          ? "onbStarted"
          : registered
            ? "registered"
            : opened
              ? "opened"
              : "leads";
    return {
      leadId: lead.leadId,
      hotelName: lead.hotelName,
      lodgingType: lead.lodgingType,
      units: lead.units ?? null,
      countryCode: lead.countryCode ?? "",
      createdAt: lead.createdAt,
      key,
      campaign: lead.utm?.utm_campaign ?? "",
      siteVisit: Boolean(lead.attribution?.vid),
      stage,
      /** Paso del onboarding en el que está (o se quedó), si lo empezó. */
      step:
        onb?.started && !onb.completed
          ? Math.min((onb.maxStep ?? -1) + 1, ONBOARDING_STEPS.length - 1)
          : null,
      lastActivityAt: onb?.lastAt ?? lead.registeredAt ?? null,
    };
  });

  const totals = zero();
  for (const c of byKey.values()) for (const s of JOURNEY_STAGES) totals[s.key] += c[s.key];

  const groups = [...byKey.entries()]
    .map(([key, c]) => ({ key, ...c }))
    .sort((a, b) => b.leads - a.leads || b.visitors - a.visitors);

  return {
    range: { from: r.from.toISOString(), to: r.to.toISOString() },
    group,
    stages: JOURNEY_STAGES.map((s) => ({ key: s.key, label: s.label, count: totals[s.key] })),
    groups,
    onboardingStops: ONBOARDING_STEPS.map((label, step) => ({ step, label, count: stoppedAt[step] })),
    timing: {
      leadToAccountHours: median(toRegister),
      accountToOnboardingHours: median(toComplete),
    },
    people: people.slice(0, 60),
  };
}
