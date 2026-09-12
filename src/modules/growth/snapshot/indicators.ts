/**
 * Derivaciones PURAS del snapshot: de la respuesta cruda de cada fuente a los
 * indicadores que el modelo lee.
 *
 * Todo lo de este archivo es determinístico y sin IO — por eso se testea entero
 * con fixtures (`npm run test:snapshot`) sin base, sin red y sin modelo. Los
 * recolectores (collectors.ts) sólo traen bytes; acá se decide qué significan.
 */

import type {
  DemandBlock,
  DirectBlock,
  FlatSnapshot,
  IdentityBlock,
  MarketBlock,
  OpsBlock,
  PresenceBlock,
  PropertySnapshot,
  ReputationBlock,
  RevenueBlock,
  Season,
} from "./snapshot.types";

// ── Utilidades ───────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function n0(v: unknown): number {
  return num(v) ?? 0;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Muchos endpoints del stack devuelven el payload dentro de un sobre
 * (`{data: …}` / `{items: …}` / `{results: …}`). Se desenvuelve una sola vez:
 * más niveles serían adivinar.
 */
export function unwrap(v: unknown): unknown {
  const o = obj(v);
  for (const key of ["data", "items", "results"]) {
    if (key in o) return o[key];
  }
  return v;
}

export function asList(v: unknown): Record<string, unknown>[] {
  const u = unwrap(v);
  return arr(u).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ── Identidad ────────────────────────────────────────────────────────────────

export function buildIdentity(input: {
  propertyId: string;
  property: Record<string, unknown> | null;
  units: number;
  categories: number;
  now: Date;
}): IdentityBlock {
  const p = obj(input.property);
  const address = obj(p.address);
  const created = p.createdAt ? new Date(String(p.createdAt)) : null;
  const monthsOnPlatform =
    created && !Number.isNaN(created.getTime())
      ? Math.max(0, Math.floor(daysBetween(created, input.now) / 30))
      : 0;
  return {
    propertyId: input.propertyId,
    name: typeof p.name === "string" ? p.name : "",
    type: typeof p.type === "string" ? p.type : "hotel",
    city: typeof address.city === "string" ? address.city : "",
    countryCode:
      typeof address.countryCode === "string"
        ? address.countryCode.toUpperCase()
        : "",
    currency: typeof p.currency === "string" ? p.currency : "",
    lat: num(address.lat),
    lng: num(address.lng),
    salesModel: typeof p.salesModel === "string" ? p.salesModel : "category_based",
    units: input.units,
    categories: input.categories,
    monthsOnPlatform,
  };
}

// ── Demanda (rms-app / PaceOverview) ─────────────────────────────────────────

/**
 * `GET /api/v1/rms/pace/snapshot-today` devuelve `{rows[], historyDays,
 * thresholds}`. Cada row es una stay date futura con su OTB y, cuando hay
 * benchmark, su `paceIndex`.
 *
 * `hasHistory` no es "vino algo": es "hay suficientes fotos para que el índice
 * signifique algo" (`historyDays >= minSampleSize`). Sin eso, un paceIndex de
 * 0.4 no dice que el hotel esté lento, dice que no sabemos.
 */
export function buildDemand(raw: unknown, now: Date): DemandBlock | null {
  // El RMS envuelve todo en `{success, data}`. Desenvolver acá y no confiar en
  // que el caller lo haya hecho: leer `raw.rows` sobre el sobre devuelve
  // undefined y el bloque entero queda en null sin que nada falle.
  const src = obj(unwrap(raw));
  const rows = asList(src.rows);
  if (rows.length === 0 && src.historyDays === undefined) return null;

  const thresholds = obj(src.thresholds);
  const slow = num(thresholds.slowThreshold) ?? 0.85;
  const minSample = num(thresholds.minSampleSize) ?? 3;
  const historyDays = n0(src.historyDays);

  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  let otb30 = 0;
  let otb60 = 0;
  let otb90 = 0;
  let pickup7d = 0;
  let datesAtRisk = 0;
  let capacity30 = 0;
  let revenue30 = 0;
  let sold30 = 0;
  const indexes: number[] = [];

  for (const row of rows) {
    const dateStr = String(row.stayDate ?? row.date ?? "");
    const d = dateStr ? new Date(`${dateStr.slice(0, 10)}T00:00:00.000Z`) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    const dta = num(row.daysToArrival) ?? daysBetween(today, d);
    if (dta < 0) continue;

    // El campo del RMS es `roomsSold`, no `otb`. Los alias siguen aceptados
    // porque el mismo builder se usa con fixtures y con respuestas viejas.
    const sold = n0(row.roomsSold ?? row.otb ?? row.roomNights ?? row.nights);
    if (dta <= 30) {
      otb30 += sold;
      sold30 += sold;
      capacity30 += n0(row.totalRooms);
      revenue30 += n0(row.roomRevenueUsd);
    }
    if (dta <= 60) otb60 += sold;
    if (dta <= 90) otb90 += sold;

    // `pickup7` es un OBJETO ({nights, revenueUsd, reservations}), no un número.
    // Sumarlo directo daba NaN silencioso.
    const p7 = row.pickup7;
    pickup7d += typeof p7 === "number" ? p7 : n0(obj(p7).nights);

    // El índice vive en `pace.paceIndex`, y `pace.status` dice si significa
    // algo: con `no_benchmark` el número existe pero es relleno.
    const pace = obj(row.pace);
    const idx = num(pace.paceIndex ?? row.paceIndex ?? row.pace_index);
    const usable =
      idx !== null &&
      pace.status !== "no_benchmark" &&
      pace.generic !== true;
    if (usable && dta <= 90) {
      indexes.push(idx as number);
      if ((idx as number) < slow) datesAtRisk += 1;
    }
  }

  return {
    hasHistory: historyDays >= minSample && indexes.length > 0,
    historyDays,
    otb30,
    otb60,
    otb90,
    // Ocupación y tarifa MIRANDO HACIA ADELANTE (lo vendido para los próximos
    // 30 días), que es lo que sirve para decidir qué hacer. El reporte de
    // dashboard no las trae: es un reporte operativo, no comercial.
    occ30: capacity30 > 0 ? round(sold30 / capacity30, 4) : null,
    adr: sold30 > 0 ? round(revenue30 / sold30, 2) : null,
    revenueOtb30: round(revenue30, 2),
    paceIndexAvg:
      indexes.length > 0
        ? round(indexes.reduce((a, b) => a + b, 0) / indexes.length, 2)
        : null,
    pickup7d,
    datesAtRisk,
  };
}

// ── Operación (booking-app / reports/dashboard) ──────────────────────────────

/**
 * Operación, desde `GET /reports/dashboard` de booking-app.
 *
 * OJO con qué es este reporte: es OPERATIVO, no comercial. No trae ocupación
 * como porcentaje, ni ADR, ni ingresos — eso sale de las filas de pace (ver
 * `buildDemand`). Lo que sí trae, y que ningún otro lado tiene, es la mezcla de
 * canales, la tasa de cancelación y la fricción del día a día.
 *
 * La mezcla de canales es el dato más valioso del bloque: es la única fuente
 * REAL de cuánto depende el hotel de intermediarios. Sin esto, el playbook de
 * dependencia de OTAs lo deduce de "tiene fichas de OTA cargadas y ninguna
 * promo propia", que es una aproximación pobre.
 */
export function buildOps(raw: unknown): OpsBlock | null {
  const src = obj(unwrap(raw));
  if (Object.keys(src).length === 0) return null;

  const occupancy = obj(src.occupancy);
  const vs = obj(occupancy.currentVsPrevious);
  const cancellations = obj(src.cancellations);
  const rate = obj(cancellations.cancellationRate);
  const channels = obj(src.channels);
  const operations = obj(src.operations);

  // Sin ninguna de las cuatro secciones no es el reporte que esperamos.
  if (
    Object.keys(occupancy).length === 0 &&
    Object.keys(cancellations).length === 0 &&
    Object.keys(channels).length === 0
  ) {
    return null;
  }

  const byChannel = arr(channels.byChannel).map(obj);
  const total = byChannel.reduce((a, c) => a + n0(c.count ?? c.total ?? c.reservations), 0);
  const direct = byChannel
    .filter((c) => /direct|web|motor|propio/i.test(String(c.channel ?? c.name ?? "")))
    .reduce((a, c) => a + n0(c.count ?? c.total ?? c.reservations), 0);

  return {
    reservationsCurrent: n0(obj(vs.current).total),
    reservationsPrevious: n0(obj(vs.previous).total),
    reservationsDeltaPct: num(vs.deltaPct),
    activeToday: n0(occupancy.activeToday),
    incomingThisWeek: n0(occupancy.incomingThisWeek),
    cancellationRatePct: num(rate.ratePct),
    lastMinuteCancellations: n0(cancellations.lastMinute),
    // `null` y no `0` cuando no hay reservas en el período: "no vendió nada"
    // no es "vende todo por OTA", y el playbook de dependencia no puede
    // dispararse con una división por cero.
    directSharePct: total > 0 ? round((direct / total) * 100, 1) : null,
    channels: byChannel.length,
    // Sin reservas el endpoint devuelve 0, que leído como dato dice "las
    // estadías duran cero noches". Es ausencia de dato, no una medición.
    avgStayNights: n0(operations.avgStayNights) > 0 ? num(operations.avgStayNights) : null,
    pendingOverdue: n0(operations.pendingOverdue),
  };
}

// ── Canal directo (booking-app: engine-settings + rate-plans + promos) ───────

export function buildDirect(input: {
  engineSettings: unknown;
  ratePlans: unknown;
  promos: unknown;
  restrictions: unknown;
}): DirectBlock | null {
  const settings = obj(unwrap(input.engineSettings));
  const plans = asList(input.ratePlans);
  const promos = asList(input.promos);
  const restrictions = asList(input.restrictions);
  const nothing =
    Object.keys(settings).length === 0 &&
    plans.length === 0 &&
    promos.length === 0;
  if (nothing) return null;

  const active = promos.filter((p) => {
    if (p.active === false || p.isActive === false || p.enabled === false) return false;
    if (typeof p.status === "string" && /inactiv|draft|expired/i.test(p.status)) {
      return false;
    }
    return true;
  });

  // "Promo web-only" = la que sólo existe en el canal directo. Es la palanca
  // central del playbook de dependencia de OTAs, así que se detecta por el
  // campo declarado y, si no existe, por el canal.
  const webOnlyPromo = active.some((p) => {
    if (p.webOnly === true || p.directOnly === true) return true;
    const channel = String(p.channel ?? p.channels ?? "").toLowerCase();
    return /web|direct|motor/.test(channel);
  });

  const engineActive =
    settings.active === true ||
    settings.enabled === true ||
    settings.isActive === true ||
    // Sin bandera explícita, un motor con planes cargados se considera activo.
    (settings.active === undefined && settings.enabled === undefined && plans.length > 0);

  return {
    engineActive,
    ratePlans: plans.length,
    promosActive: active.length,
    webOnlyPromo,
    hasRestrictions: restrictions.length > 0,
  };
}

// ── Presencia digital ────────────────────────────────────────────────────────

/** Completitud de la ficha de Google Business Profile: 0..1 sobre 6 campos. */
export function gbpCompleteness(gbp: Record<string, unknown> | null): number {
  if (!gbp) return 0;
  const business = obj(gbp.business);
  const location = obj(gbp.location);
  const checks = [
    typeof business.name === "string" && business.name.trim() !== "",
    typeof business.shortDescription === "string" &&
      business.shortDescription.trim().length > 40,
    typeof business.phone === "string" && business.phone.trim() !== "",
    typeof business.website === "string" && business.website.trim() !== "",
    typeof location.addressLine === "string" && location.addressLine.trim() !== "",
    arr(gbp.photos).length > 0,
  ];
  return round(checks.filter(Boolean).length / checks.length, 2);
}

/** Completitud de una ficha OTA: 0..1 sobre 4 campos. */
export function otaCompleteness(ota: Record<string, unknown>): number {
  const description = obj(ota.description);
  const policies = obj(ota.policies);
  const checks = [
    typeof description.text === "string" && description.text.trim().length > 80,
    Object.values(policies).some((v) => typeof v === "string" && v.trim() !== ""),
    arr(ota.roomTypes).length > 0,
    arr(ota.roomTypes).some((r) => {
      const rt = obj(r);
      return typeof rt.photoUrl === "string" && rt.photoUrl.trim() !== "";
    }),
  ];
  return round(checks.filter(Boolean).length / checks.length, 2);
}

export function buildPresence(input: {
  sites: Record<string, unknown>[];
  linkhub: Record<string, unknown> | null;
  visibility: Record<string, unknown> | null;
  gbp: Record<string, unknown> | null;
  otas: Record<string, unknown>[];
  socialConnections: Record<string, unknown>[];
  propertyId: string;
}): PresenceBlock | null {
  const {
    sites,
    linkhub,
    visibility,
    gbp,
    otas,
    socialConnections,
    propertyId,
  } = input;

  // Un sitio está publicado si alguna de sus variantes por idioma lo está y
  // corresponde a esta propiedad (un sitio de company puede cubrir varias).
  let sitePublished = false;
  let siteLanguages = 0;
  for (const site of sites) {
    const variants = arr(site.sitesByLanguage).map(obj);
    const mine = variants.filter(
      (v) => !v.propertyId || v.propertyId === propertyId,
    );
    const published = mine.filter(
      (v) => String(v.status ?? "").toLowerCase() === "published" || !!v.publishedAt,
    );
    if (published.length > 0) {
      sitePublished = true;
      siteLanguages += published.length;
    }
  }

  const scores = obj(visibility?.scores);
  const lh = obj(linkhub);
  const otaScores = otas.map(otaCompleteness);

  return {
    sitePublished,
    siteLanguages,
    linkhubPublished:
      lh.published === true ||
      String(lh.status ?? "").toLowerCase() === "published" ||
      !!lh.publishedAt,
    visibilityScore: num(scores.global),
    seoScore: num(scores.seo),
    geoScore: num(scores.geo),
    gbpCompleteness: gbpCompleteness(gbp),
    otaCompleteness:
      otaScores.length > 0
        ? round(otaScores.reduce((a, b) => a + b, 0) / otaScores.length, 2)
        : 0,
    otaPlatforms: otas
      .map((o) => String(o.platform ?? ""))
      .filter(Boolean)
      .sort(),
    socialConnected: socialConnections.filter(
      (c) => String(c.status ?? "").toLowerCase() === "connected",
    ).length,
  };
}

// ── Reputación ───────────────────────────────────────────────────────────────

export function buildReputation(
  reviews: Array<{ rating?: unknown; responded?: unknown; reviewDate?: unknown; createdAt?: unknown }>,
  now: Date,
): ReputationBlock | null {
  if (!Array.isArray(reviews)) return null;
  if (reviews.length === 0) {
    return { rating: null, reviews: 0, responded: 0, last90d: 0 };
  }
  const ratings = reviews.map((r) => num(r.rating)).filter((n): n is number => n !== null);
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const last90d = reviews.filter((r) => {
    const raw = r.reviewDate ?? r.createdAt;
    if (!raw) return false;
    const d = new Date(String(raw));
    return !Number.isNaN(d.getTime()) && d >= cutoff;
  }).length;

  return {
    rating:
      ratings.length > 0
        ? round(ratings.reduce((a, b) => a + b, 0) / ratings.length, 2)
        : null,
    reviews: reviews.length,
    responded: reviews.filter((r) => r.responded === true).length,
    last90d,
  };
}

// ── Mercado ──────────────────────────────────────────────────────────────────

/**
 * Temporada del hemisferio correcto.
 *
 * Verano y las fiestas de fin de año son alta en ambos hemisferios, pero caen
 * en meses opuestos. Sin el hemisferio, un hotel de Bariloche en julio queda
 * clasificado como temporada baja justo en su pico de nieve — y el playbook de
 * temporada baja le propondría descuentos en su mejor mes.
 */
export function seasonFor(date: Date, lat: number | null): Season {
  const month = date.getUTCMonth() + 1; // 1..12
  const south = lat !== null && lat < 0;
  const high = south ? [1, 2, 7, 12] : [6, 7, 8, 12];
  const mid = south ? [3, 11] : [4, 5, 9, 10];
  if (high.includes(month)) return "alta";
  if (mid.includes(month)) return "media";
  return "baja";
}

export function buildMarket(input: {
  signals: Array<Record<string, unknown>>;
  now: Date;
  lat: number | null;
  radiusKm: number;
}): MarketBlock {
  const { signals, now, lat, radiusKm } = input;
  const horizon = new Date(now.getTime() + 90 * 86_400_000);

  const upcoming = signals.filter((s) => {
    const start = obj(s.timeWindow).start;
    if (!start) return false;
    const d = new Date(String(start));
    return !Number.isNaN(d.getTime()) && d >= now && d <= horizon;
  });

  const events = upcoming.filter((s) => s.type === "event");
  const longWeekends = upcoming.filter(
    (s) => s.type === "holiday" || s.type === "school_holiday",
  );

  const topEvents = [...events]
    .sort((a, b) => (num(b.magnitude) ?? 0) - (num(a.magnitude) ?? 0))
    .slice(0, 3)
    .map((s) => ({
      name: String(obj(s.rawPayload).name ?? s.title ?? "evento"),
      date: String(obj(s.timeWindow).start ?? "").slice(0, 10),
      magnitude: round(num(s.magnitude) ?? 0, 2),
    }));

  return {
    season: seasonFor(now, lat),
    eventsNext90d: events.length,
    topEvents,
    longWeekendsNext90d: longWeekends.length,
    radiusKm,
  };
}

// ── Revenue ──────────────────────────────────────────────────────────────────

export function buildRevenue(input: {
  rules: unknown;
  recommendations: unknown;
  /** Respuesta de `GET /rms/config`: de ahí sale `competitors[]`. */
  config: unknown;
}): RevenueBlock | null {
  const rules = asList(input.rules);
  const recs = asList(input.recommendations);
  const config = obj(unwrap(input.config));
  if (input.rules === null && input.recommendations === null) return null;

  return {
    rulesActive: rules.filter((r) => r.active !== false && r.enabled !== false).length,
    recommendationsPending: recs.filter(
      (r) => !r.status || String(r.status) === "suggested",
    ).length,
    compsetConfigured: arr(config.competitors).length > 0,
    competitors: arr(config.competitors).length,
    autoApply: config.autoApply === true,
  };
}

// ── Vista plana ──────────────────────────────────────────────────────────────

/**
 * Aplana el snapshot a `"ops.occ30" -> 0.41`.
 *
 * Un bloque `null` NO aporta claves: así `{ op: "missing" }` de una regla de
 * playbook distingue "no hay dato" de "el dato es cero", que es justo la
 * diferencia entre "no sabemos si vende" y "no vende".
 */
export function flattenSnapshot(snap: PropertySnapshot): FlatSnapshot {
  const flat: FlatSnapshot = {};
  const blocks: Array<[string, unknown]> = [
    ["identity", snap.identity],
    ["demand", snap.demand],
    ["ops", snap.ops],
    ["direct", snap.direct],
    ["presence", snap.presence],
    ["reputation", snap.reputation],
    ["market", snap.market],
    ["revenue", snap.revenue],
  ];
  for (const [prefix, block] of blocks) {
    if (!block) continue;
    for (const [key, value] of Object.entries(obj(block))) {
      if (value === null) {
        flat[`${prefix}.${key}`] = null;
        continue;
      }
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        flat[`${prefix}.${key}`] = value;
      } else if (Array.isArray(value)) {
        // Los arrays entran como su longitud: las reglas preguntan "cuántos",
        // nunca "cuál" (para eso está el cuerpo del playbook).
        flat[`${prefix}.${key}`] = value.length;
      }
    }
  }
  // Derivado que varias reglas necesitan y ningún bloque tiene solo.
  if (snap.reputation && snap.reputation.reviews > 0) {
    flat["reputation.respondedRatio"] = round(
      snap.reputation.responded / snap.reputation.reviews,
      2,
    );
  }
  return flat;
}
