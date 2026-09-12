/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Batería del turno estratégico. SIN base, SIN red, SIN modelo.
 *
 *   npm run test:growth
 *
 * Cubre las cuatro piezas que deciden si el agente contesta con datos o
 * improvisa:
 *
 *   1. derivación de indicadores (la foto): que un dato ausente NO se convierta
 *      en un cero, que es el error que haría al modelo afirmar cosas falsas;
 *   2. selección de playbooks: que las reglas elijan la estrategia correcta y
 *      que "sin dato" no dispare un diagnóstico;
 *   3. validación del plan: que un paso sin permiso o con una tool inventada no
 *      llegue nunca a la pantalla;
 *   4. router: que un objetivo abierto entre al turno estratégico y que un
 *      pedido puntual NO entre.
 */
import {
  buildDemand,
  buildDirect,
  buildIdentity,
  buildMarket,
  buildOps,
  buildPresence,
  buildReputation,
  buildRevenue,
  flattenSnapshot,
  gbpCompleteness,
  otaCompleteness,
  seasonFor,
} from "../modules/growth/snapshot/indicators";
import type { PropertySnapshot } from "../modules/growth/snapshot/snapshot.types";
import {
  resolveApplicablePlaybooks,
  ruleMatches,
} from "../modules/growth/playbooks/resolver";
import type { Playbook } from "../modules/growth/playbooks/growthPlaybook.model";
import { validatePlan, type ToolDoc } from "../modules/growth/plan/plan.validate";
import type { LeverIndex } from "../modules/growth/playbooks/leverIndex";
import type { UserScope } from "../shared/agentAuth/userScope";
import { planStepNumber, routeTurn } from "../modules/conversations/services/taskRouter";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.log(
      `  ✗ ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ""}`,
    );
  }
}

const NOW = new Date("2026-09-12T12:00:00.000Z");

// ── 1. Indicadores ───────────────────────────────────────────────────────────

function testIndicators() {
  console.log("\n── Indicadores (la foto) ──");

  // Identidad
  const identity = buildIdentity({
    propertyId: "p1",
    property: {
      name: "Hotel Test",
      type: "hotel",
      currency: "ARS",
      salesModel: "category_based",
      address: { city: "Bariloche", countryCode: "ar", lat: -41.13, lng: -71.3 },
      createdAt: "2026-03-12T00:00:00.000Z",
    },
    units: 12,
    categories: 3,
    now: NOW,
  });
  check("identidad: meses en plataforma", identity.monthsOnPlatform === 6, identity.monthsOnPlatform);
  check("identidad: país en mayúsculas", identity.countryCode === "AR");

  // Demanda: sin historia suficiente, hasHistory = false aunque haya índices.
  const paceSinHistoria = buildDemand(
    {
      historyDays: 2,
      thresholds: { slowThreshold: 0.85, minSampleSize: 3 },
      rows: [
        { stayDate: "2026-09-20", otb: 5, pickup7: 2, paceIndex: 0.5 },
        { stayDate: "2026-10-20", otb: 3, pickup7: 1, paceIndex: 0.6 },
      ],
    },
    NOW,
  );
  check(
    "demanda: 2 días de historia no alcanzan para afirmar ritmo",
    paceSinHistoria?.hasHistory === false,
    paceSinHistoria?.hasHistory,
  );

  // La forma de estos fixtures está COPIADA de la respuesta real del RMS
  // (medida con `smoke:strategic` el 12-09-2026). La versión anterior de este
  // test usaba campos inventados (`otb`, `pickup7` numérico, `paceIndex` en la
  // raíz) y por eso pasaba en verde mientras el bloque entero salía vacío
  // contra un hotel real. Si estos fixtures se "simplifican", vuelve el bug.
  const paceRow = (over: Record<string, unknown>) => ({
    stayDate: "2026-09-20",
    daysToArrival: 8,
    roomsSold: 5,
    totalRooms: 20,
    occupancyPct: 25,
    roomRevenueUsd: 500,
    pickup7: { nights: 2, revenueUsd: 200, reservations: 1 },
    pace: { paceIndex: 0.5, status: "ok", generic: false, sampleSize: 9 },
    ...over,
  });

  const pace = buildDemand(
    {
      // El RMS envuelve en {success, data}: si el builder no desenvuelve, el
      // bloque sale null y nadie se entera.
      success: true,
      data: {
        historyDays: 40,
        thresholds: { slowThreshold: 0.85, minSampleSize: 3 },
        rows: [
          paceRow({}),
          paceRow({
            stayDate: "2026-10-05", daysToArrival: 23, roomsSold: 4, totalRooms: 20,
            roomRevenueUsd: 600, pickup7: { nights: 1 },
            pace: { paceIndex: 0.9, status: "ok", generic: false },
          }),
          paceRow({
            stayDate: "2026-11-20", daysToArrival: 69, roomsSold: 3,
            pickup7: { nights: 0 }, pace: { paceIndex: 1.2, status: "ok", generic: false },
          }),
          paceRow({
            stayDate: "2027-06-01", daysToArrival: 262, roomsSold: 99,
            pickup7: { nights: 9 }, pace: { paceIndex: 0.1, status: "ok", generic: false },
          }),
        ],
      },
    },
    NOW,
  );
  check("demanda: desenvuelve {success, data}", pace !== null);
  check("demanda: OTB 30 excluye la fecha a 69 días", pace?.otb30 === 9, pace?.otb30);
  check("demanda: OTB 60 tampoco la incluye", pace?.otb60 === 9, pace?.otb60);
  check("demanda: OTB 90 sí la incluye, y excluye la de 9 meses", pace?.otb90 === 12, pace?.otb90);
  check("demanda: fechas en riesgo", pace?.datesAtRisk === 1, pace?.datesAtRisk);
  check("demanda: pace promedio", pace?.paceIndexAvg === 0.87, pace?.paceIndexAvg);
  // El pickup lee `pickup7.nights` (objeto) y suma TODAS las fechas futuras,
  // no sólo las de 30 días: es una medida de velocidad de venta, y una reserva
  // hecha esta semana para dentro de nueve meses también cuenta como venta de
  // esta semana. 2+1+0+9 = 12.
  check("demanda: pickup lee el objeto, no el número", pace?.pickup7d === 12, pace?.pickup7d);
  check("demanda: ocupación derivada de las filas", pace?.occ30 === 0.225, pace?.occ30);
  check("demanda: ADR derivado", pace?.adr === Math.round((1100 / 9) * 100) / 100, pace?.adr);

  // Un paceIndex sin benchmark real NO cuenta: existe como número pero es
  // relleno, y tomarlo como dato haría que el agente diagnostique "vendés
  // lento" con la nada.
  const sinBenchmark = buildDemand(
    {
      data: {
        historyDays: 40,
        thresholds: { slowThreshold: 0.85, minSampleSize: 3 },
        rows: [
          paceRow({ pace: { paceIndex: 0, status: "no_benchmark", generic: true } }),
        ],
      },
    },
    NOW,
  );
  check(
    "demanda: un paceIndex con status no_benchmark se descarta",
    sinBenchmark?.hasHistory === false && sinBenchmark?.paceIndexAvg === null,
    { h: sinBenchmark?.hasHistory, p: sinBenchmark?.paceIndexAvg },
  );

  // Ops: el reporte de dashboard es OPERATIVO. Forma real medida el 12-09.
  const ops = buildOps({
    occupancy: {
      activeToday: 3,
      incomingThisWeek: 7,
      currentVsPrevious: {
        current: { total: 20 },
        previous: { total: 16 },
        deltaPct: 25,
      },
    },
    cancellations: { cancellationRate: { cancelled: 2, total: 20, ratePct: 10 }, lastMinute: 1 },
    channels: {
      byChannel: [
        { channel: "direct", count: 5 },
        { channel: "booking", count: 15 },
      ],
    },
    operations: { avgStayNights: 2.4, pendingOverdue: 1 },
  });
  check("ops: reservas del período", ops?.reservationsCurrent === 20, ops?.reservationsCurrent);
  check("ops: delta tal cual lo da el reporte", ops?.reservationsDeltaPct === 25);
  check("ops: cuota de canal directo", ops?.directSharePct === 25, ops?.directSharePct);
  check("ops: tasa de cancelación", ops?.cancellationRatePct === 10);
  check("ops: estadía promedio", ops?.avgStayNights === 2.4);

  // Sin reservas, la cuota de canal es null y NO cero: "no vendió nada" no es
  // "vende todo por OTA", y el playbook de dependencia no puede dispararse ahí.
  const opsVacio = buildOps({
    occupancy: { activeToday: 0, currentVsPrevious: { current: { total: 0 }, previous: { total: 0 }, deltaPct: 0 } },
    cancellations: { cancellationRate: { ratePct: 0 } },
    channels: { byChannel: [] },
    operations: {},
  });
  check("ops: sin reservas, la cuota de canal es null", opsVacio?.directSharePct === null);
  check("ops: un reporte vacío no produce bloque", buildOps({}) === null);

  // Directo
  const direct = buildDirect({
    engineSettings: { active: true },
    ratePlans: { data: [{ id: 1 }, { id: 2 }] },
    promos: [
      { id: "a", active: true, channel: "web" },
      { id: "b", active: false },
      { id: "c", status: "expired" },
    ],
    restrictions: [],
  });
  check("directo: promos activas", direct?.promosActive === 1, direct?.promosActive);
  check("directo: detecta promo de canal propio", direct?.webOnlyPromo === true);
  check("directo: planes desde el sobre {data}", direct?.ratePlans === 2, direct?.ratePlans);

  // Presencia
  check(
    "GBP: ficha vacía es 0",
    gbpCompleteness(null) === 0 && gbpCompleteness({}) === 0,
  );
  check(
    "GBP: descripción corta no cuenta como cargada",
    gbpCompleteness({ business: { name: "X", shortDescription: "corta" } }) === 0.17,
    gbpCompleteness({ business: { name: "X", shortDescription: "corta" } }),
  );
  check(
    "OTA: ficha vacía es 0",
    otaCompleteness({}) === 0,
  );

  const presence = buildPresence({
    sites: [
      {
        sitesByLanguage: [
          { status: "published", propertyId: "p1", language: "es" },
          { status: "indraft", propertyId: "p1", language: "en" },
          { status: "published", propertyId: "otra", language: "pt" },
        ],
      },
    ],
    linkhub: { published: true },
    visibility: { scores: { global: 32, seo: 40, geo: 18 } },
    gbp: null,
    otas: [{ platform: "booking" }, { platform: "airbnb" }],
    socialConnections: [{ status: "connected" }, { status: "declared" }],
    propertyId: "p1",
  });
  check("presencia: sólo cuenta idiomas publicados de ESTA propiedad", presence?.siteLanguages === 1, presence?.siteLanguages);
  check("presencia: score de visibilidad", presence?.visibilityScore === 32);
  check("presencia: redes conectadas ≠ declaradas", presence?.socialConnected === 1);

  // Reputación: sin reseñas el rating es null, NO cero.
  const sinReseñas = buildReputation([], NOW);
  check(
    "reputación: sin reseñas el rating es null, no 0",
    sinReseñas?.rating === null && sinReseñas?.reviews === 0,
  );
  const rep = buildReputation(
    [
      { rating: 5, responded: true, reviewDate: "2026-09-01" },
      { rating: 4, responded: false, reviewDate: "2026-08-20" },
      { rating: 3, responded: false, reviewDate: "2024-01-01" },
    ],
    NOW,
  );
  check("reputación: promedio", rep?.rating === 4, rep?.rating);
  check("reputación: últimas 90 días", rep?.last90d === 2, rep?.last90d);

  // Temporada por hemisferio: la trampa de Bariloche en julio.
  check("temporada: julio en el sur es ALTA", seasonFor(new Date("2026-07-15"), -41) === "alta");
  check("temporada: julio en el norte es ALTA", seasonFor(new Date("2026-07-15"), 40) === "alta");
  check("temporada: enero en el sur es ALTA", seasonFor(new Date("2026-01-15"), -34) === "alta");
  check("temporada: enero en el norte es BAJA", seasonFor(new Date("2026-01-15"), 48) === "baja");

  const market = buildMarket({
    signals: [
      { type: "event", magnitude: 0.9, timeWindow: { start: "2026-10-01" }, rawPayload: { name: "Fiesta" } },
      { type: "event", magnitude: 0.2, timeWindow: { start: "2026-09-20" }, rawPayload: { name: "Feria" } },
      { type: "holiday", timeWindow: { start: "2026-10-12" } },
      { type: "event", magnitude: 1, timeWindow: { start: "2027-05-01" }, rawPayload: { name: "Lejano" } },
    ],
    now: NOW,
    lat: -41,
    radiusKm: 30,
  });
  check("mercado: eventos dentro de 90 días", market.eventsNext90d === 2, market.eventsNext90d);
  check("mercado: top ordenado por magnitud", market.topEvents[0]?.name === "Fiesta");
  check("mercado: feriados contados aparte", market.longWeekendsNext90d === 1);

  const revenue = buildRevenue({
    rules: [{ active: true }, { active: false }],
    recommendations: { success: true, data: [{ status: "suggested" }, { status: "accepted" }] },
    // El comp-set sale de `GET /rms/config`, no de un endpoint propio: el que
    // usaba este código antes (`/rms/compset`) devolvía 404 y dejaba
    // `compsetConfigured` en false para todos los hoteles.
    config: { success: true, data: { competitors: [], autoApply: false } },
  });
  check("revenue: reglas activas", revenue?.rulesActive === 1);
  check("revenue: recomendaciones pendientes", revenue?.recommendationsPending === 1);
  check("revenue: comp-set vacío", revenue?.compsetConfigured === false);
  const conCompset = buildRevenue({
    rules: [],
    recommendations: [],
    config: { data: { competitors: [{ id: 1 }, { id: 2 }], autoApply: true } },
  });
  check("revenue: comp-set cargado", conCompset?.compsetConfigured === true && conCompset?.competitors === 2);
  check("revenue: aplicación automática", conCompset?.autoApply === true);

  // Aplanado: un bloque null NO aporta claves.
  const snap = makeSnapshot({ ops: null, reputation: rep });
  const flat = flattenSnapshot(snap);
  check(
    "aplanado: un bloque ausente no aporta claves (≠ cero)",
    !("ops.reservationsCurrent" in flat),
    Object.keys(flat).filter((k) => k.startsWith("ops.")),
  );
  check("aplanado: ratio de respondidas derivado", flat["reputation.respondedRatio"] === 0.33, flat["reputation.respondedRatio"]);
  check("aplanado: arrays entran como longitud", flat["presence.otaPlatforms"] === 2, flat["presence.otaPlatforms"]);
}

// ── 2. Selección de playbooks ────────────────────────────────────────────────

function pb(over: Partial<Playbook>): Playbook {
  return {
    playbookId: "x",
    version: 1,
    name: "X",
    summary: "s",
    body: "b",
    goal: "ocupacion",
    applicability: [],
    levers: [],
    kpis: [],
    ...over,
  };
}

function testPlaybookSelection() {
  console.log("\n── Selección de playbooks ──");

  const flat = flattenSnapshot(
    makeSnapshot({
      demand: { hasHistory: true, historyDays: 90, otb30: 40, otb60: 60, otb90: 80,
                occ30: 0.82, adr: 90000, revenueOtb30: 1000, paceIndexAvg: 1.1,
                pickup7d: 5, datesAtRisk: 0 },
      reputation: { rating: null, reviews: 0, responded: 0, last90d: 0 },
    }),
  );

  // "missing" vs valor nulo vs ausencia de bloque.
  check(
    "regla missing: acierta cuando el dato es null",
    ruleMatches({ path: "reputation.rating", op: "missing" }, flat),
  );
  check(
    "regla numérica NO se cumple sobre un dato null",
    !ruleMatches({ path: "reputation.rating", op: "lt", value: 4.2 }, flat),
  );
  check(
    "regla numérica NO se cumple sobre un bloque ausente",
    !ruleMatches({ path: "demand.paceIndexAvg", op: "lt", value: 0.9 }, flat),
  );
  check(
    "regla present: falsa si el dato es null",
    !ruleMatches({ path: "reputation.rating", op: "present" }, flat),
  );

  const catalogo = [
    pb({
      playbookId: "adr-bajo",
      applicability: [{ path: "demand.occ30", op: "gt", value: 0.75, weight: 2 }],
    }),
    pb({
      playbookId: "generico",
      applicability: [{ path: "demand.occ30", op: "gt", value: 0.1 }],
    }),
    pb({
      playbookId: "no-aplica",
      applicability: [{ path: "demand.occ30", op: "lt", value: 0.3 }],
    }),
    pb({ playbookId: "sin-reglas", applicability: [] }),
  ];

  const matches = resolveApplicablePlaybooks(catalogo, flat);
  check("selección: descarta el que no aplica", !matches.some((m) => m.playbook.playbookId === "no-aplica"));
  check(
    "selección: un playbook sin reglas NUNCA aplica (sería un comodín)",
    !matches.some((m) => m.playbook.playbookId === "sin-reglas"),
  );
  check("selección: el más específico va primero", matches[0]?.playbook.playbookId === "adr-bajo", matches.map((m) => m.playbook.playbookId));
  check("selección: tope de 3", resolveApplicablePlaybooks(catalogo, flat, 1).length === 1);

  // Todas las reglas tienen que cumplirse, no alguna.
  const conjuncion = [
    pb({
      playbookId: "and",
      applicability: [
        // La primera se cumple; la segunda mira un bloque que no se pudo leer.
        { path: "demand.occ30", op: "gt", value: 0.75 },
        { path: "ops.directSharePct", op: "lt", value: 40 },
      ],
    }),
  ];
  check(
    "selección: si falta una de las reglas, no aplica",
    resolveApplicablePlaybooks(conjuncion, flat).length === 0,
  );
}

// ── 3. Validación del plan ───────────────────────────────────────────────────

function tool(name: string, over: Partial<ToolDoc> = {}): ToolDoc {
  return {
    name,
    displayName: name,
    category: "marketing_write",
    inputSchema: { properties: { titulo: { type: "string" }, descuento: { type: "number" } } },
    execution: { method: "POST" },
    permissions: { requiredRoles: ["owner", "admin"], isDestructive: false },
    ...over,
  };
}

function indexOf(names: string[]): LeverIndex {
  return {
    levers: names.map((n) => ({
      tool: n,
      toolId: `tool-${n}`,
      displayName: n,
      description: "",
      args: [],
      irreversible: false,
      destructive: false,
    })),
    allowed: new Set(names),
    droppedByPolicy: [],
  };
}

const ownerScope: UserScope = {
  userId: "u1",
  companyId: "c1",
  role: "owner",
  isAdmin: true,
  capabilities: [] as any,
  allProperties: true,
  propertyIds: [],
  resolved: true,
  mustChangePassword: false,
  experienceLevel: "avanzado",
};

function goodSteps() {
  return [
    { tool: "create_promo", title: "Promo directa", reason: "r", priority: "alta", effort: "min" },
    { tool: "publish_linkhub", title: "Publicar LinkHub", reason: "r", priority: "media", effort: "min" },
    { tool: "update_gbp_profile", title: "Completar Google", reason: "r", priority: "baja", effort: "horas" },
  ];
}

async function testPlanValidation() {
  console.log("\n── Validación del plan ──");

  const snapshot = makeSnapshot({
    demand: { hasHistory: true, historyDays: 90, otb30: 12, otb60: 20, otb90: 26,
              occ30: 0.41, adr: 85000, revenueOtb30: 4200000, paceIndexAvg: 0.8,
              pickup7d: 2, datesAtRisk: 6 },
  });
  const index = indexOf(["create_promo", "publish_linkhub", "update_gbp_profile"]);
  const loadTools = async (names: string[]) =>
    names.map((n) => tool(n)).filter((t) => index.allowed.has(t.name) || true);

  const base = {
    index,
    scope: ownerScope,
    snapshot,
    offeredPlaybookIds: ["presencia-digital-debil"],
    loadTools,
  };

  const evidencia = [
    "la ocupación de los últimos 30 días es 41%",
    "el score de visibilidad es 32 sobre 100",
    "hay 0 promociones vigentes",
  ];

  // Feliz
  const ok = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      horizonDays: 90,
      diagnosis: "Sos invisible.",
      evidence: evidencia,
      playbookIds: ["presencia-digital-debil"],
      steps: goodSteps(),
    },
  });
  check("plan válido pasa", ok.ok, ok.error);
  check("plan: orden por prioridad y esfuerzo", ok.plan?.steps[0]?.tool === "create_promo", ok.plan?.steps.map((s) => s.tool));
  check("plan: baseline captura la ocupación", ok.plan?.kpiBaseline["demand.occ30"] === 0.41);

  // Evidencia sin números
  const sinNumeros = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: ["tenés poca visibilidad", "el sitio no rinde", "faltan reseñas"],
      steps: goodSteps(),
    },
  });
  check("plan: evidencia sin números se rechaza", !sinNumeros.ok, sinNumeros.error);

  // Tool inventada
  const inventada = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: [...goodSteps(), { tool: "hacer_magia", title: "t", reason: "r", priority: "alta", effort: "min" }],
    },
  });
  check(
    "plan: una tool inventada se descarta sin voltear el plan",
    inventada.ok && inventada.dropped.some((d) => d.tool === "hacer_magia"),
    inventada.dropped,
  );

  // Tool que existe pero no está en el índice (o sea: sin permiso)
  const fueraDelIndice = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: [...goodSteps(), { tool: "reset_whole_site_content", title: "t", reason: "r", priority: "alta", effort: "min" }],
    },
    loadTools: async (names) => names.map((n) => tool(n)),
  });
  check(
    "plan: una tool fuera del índice de palancas se descarta",
    fueraDelIndice.ok &&
      fueraDelIndice.dropped.some((d) => d.tool === "reset_whole_site_content"),
    fueraDelIndice.dropped,
  );

  // Permisos: staff sin rol para la tool
  const staffScope: UserScope = {
    ...ownerScope,
    role: "staff",
    isAdmin: false,
    experienceLevel: "basico",
  };
  const sinPermiso = await validatePlan({
    ...base,
    scope: staffScope,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: goodSteps(),
    },
  });
  check(
    "plan: sin permisos quedan menos de 3 pasos y se rechaza con motivo",
    !sinPermiso.ok && (sinPermiso.error ?? "").includes("índice de palancas"),
    sinPermiso.error,
  );

  // Args fuera del schema: el paso sobrevive sin ellos
  const argsRaros = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: [
        { ...goodSteps()[0], suggestedArgs: { titulo: "Verano", inventado: 1 } },
        ...goodSteps().slice(1),
      ],
    },
  });
  const promo = argsRaros.plan?.steps.find((s) => s.tool === "create_promo");
  check(
    "plan: un arg fuera del schema se tira, el paso sobrevive",
    argsRaros.ok && !!promo?.suggestedArgs && !("inventado" in (promo.suggestedArgs ?? {})),
    promo?.suggestedArgs,
  );

  // Nivel de confirmación: lo pone el código, no el modelo
  const irreversible = await validatePlan({
    ...base,
    index: indexOf(["create_promo", "publish_linkhub", "borrar_todo"]),
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: [
        ...goodSteps().slice(0, 2),
        { tool: "borrar_todo", title: "t", reason: "r", priority: "baja", effort: "min" },
      ],
    },
    loadTools: async (names) =>
      names.map((n) =>
        n === "borrar_todo"
          ? tool(n, {
              execution: { method: "DELETE" },
              permissions: { irreversible: true, confirmSubject: "id", isDestructive: true },
            })
          : tool(n),
      ),
  });
  const paso = irreversible.plan?.steps.find((s) => s.tool === "borrar_todo");
  check(
    "plan: un paso irreversible conserva su confirmación escrita",
    paso?.confirmationLevel === "typed",
    paso?.confirmationLevel,
  );

  // Repetidos
  const repetido = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      steps: [...goodSteps(), goodSteps()[0]],
    },
  });
  check(
    "plan: un paso repetido se descarta",
    repetido.ok && repetido.plan?.steps.length === 3,
    repetido.plan?.steps.length,
  );

  // Playbook no ofrecido
  const playbookAjeno = await validatePlan({
    ...base,
    raw: {
      goal: "visibilidad",
      diagnosis: "d",
      evidence: evidencia,
      playbookIds: ["presencia-digital-debil", "inventado"],
      steps: goodSteps(),
    },
  });
  check(
    "plan: no se puede citar un playbook que no se ofreció",
    playbookAjeno.plan?.playbookIds.length === 1,
    playbookAjeno.plan?.playbookIds,
  );
}

// ── 4. Router ────────────────────────────────────────────────────────────────

/**
 * Los mensajes ESTRATÉGICOS son transcripciones reales del chat de producción
 * (últimos 14 días, sacadas con `npm run usage:baseline`). No son ejemplos
 * inventados, y por eso valen: incluyen el dictado por voz con repeticiones, la
 * frustración, el acento sin tildes y la pregunta cortada a la mitad.
 *
 * Si alguien "mejora" la heurística del router, este bloque es el que dice si
 * la mejoró para los usuarios reales o para los ejemplos del que la escribió.
 */
const ESTRATEGICOS_REALES = [
  "Como puedo aumentar el volumen de reservas en mi hotel?",
  "no No flaco pero no entiendo nada estoy hablando No no no sé Soy nuevo Yo quiero quiero tener más reservas no es tan difícil lo que te estoy pidiendo",
  "Cómo puedo aumentar la ocupación de mi hotel",
  "no me expresé bien quiero de cómo puedo aumentar la ocupación de mi hotel",
  "Cómo puedo aumentar de mi hotel",
  "Cómo puedo aumentar la ocupación hoy",
  "Como puedo vender mas? recien cree mi cuenta y no entiendo nada",
  "Como puedo aumentar mi ocupacion? recien entro, no entiendo nada",
  "Que puedo hacer para aumentar mi ocupacion?",
];

/** Lo que NO tiene que entrar al turno estratégico. */
const NO_ESTRATEGICOS = [
  "cuántas reservas tengo hoy",
  "cancelá la reserva ABC123",
  "quiero mejorar la tarifa del 24/12",
  "mostrame el estado de las habitaciones",
  "hola",
  "hacé el check-in de Pérez",
];

async function testRouter() {
  console.log("\n── Router ──");

  // El clasificador LLM se apaga: acá se mide la HEURÍSTICA, que es la que
  // tiene que resolver estos casos sin gastar un pedido.
  const prev = process.env.ROUTER_LLM_CLASSIFIER;
  process.env.ROUTER_LLM_CLASSIFIER = "false";

  for (const msg of ESTRATEGICOS_REALES) {
    const r = await routeTurn({ userMessage: msg, enabledToolIds: [] });
    check(
      `estratégico: "${msg.slice(0, 48)}…"`,
      r.strategicRequest === true,
      r.reason,
    );
  }
  for (const msg of NO_ESTRATEGICOS) {
    const r = await routeTurn({ userMessage: msg, enabledToolIds: [] });
    check(`NO estratégico: "${msg}"`, r.strategicRequest === false, r.reason);
  }

  // Referencias a un paso del plan.
  check("paso en número", planStepNumber("hacé el paso 2") === 2);
  check("paso en palabra", planStepNumber("dale con el punto tres") === 3);
  check("sin referencia", planStepNumber("cuántas reservas tengo") === null);
  check("no confunde una fecha", planStepNumber("reservas del 12/09") === null);

  // Un paso sólo se resuelve como tal si hay un plan activo: sin plan, "el
  // paso 2" no significa nada y el mensaje tiene que rutear normal.
  const conPlan = await routeTurn({
    userMessage: "hacé el paso 2",
    enabledToolIds: [],
    hasActivePlan: true,
  });
  check("con plan activo, el paso se resuelve", conPlan.planStepNumber === 2, conPlan.reason);
  const sinPlan = await routeTurn({
    userMessage: "hacé el paso 2",
    enabledToolIds: [],
    hasActivePlan: false,
  });
  check("sin plan activo, no se inventa una referencia", sinPlan.planStepNumber === null);

  if (prev === undefined) delete process.env.ROUTER_LLM_CLASSIFIER;
  else process.env.ROUTER_LLM_CLASSIFIER = prev;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function makeSnapshot(over: Partial<PropertySnapshot>): PropertySnapshot {
  return {
    propertyId: "p1",
    companyId: "c1",
    takenAt: NOW.toISOString(),
    missing: [],
    collectedInMs: 10,
    identity: {
      propertyId: "p1",
      name: "Hotel Test",
      type: "hotel",
      city: "Bariloche",
      countryCode: "AR",
      currency: "ARS",
      lat: -41,
      lng: -71,
      salesModel: "category_based",
      units: 12,
      categories: 3,
      monthsOnPlatform: 14,
    },
    demand: null,
    ops: null,
    direct: null,
    presence: {
      sitePublished: false,
      siteLanguages: 0,
      linkhubPublished: false,
      visibilityScore: 32,
      seoScore: 40,
      geoScore: 18,
      gbpCompleteness: 0.3,
      otaCompleteness: 0.5,
      otaPlatforms: ["booking", "airbnb"],
      socialConnected: 1,
    },
    reputation: null,
    market: null,
    revenue: null,
    ...over,
  };
}

async function main() {
  testIndicators();
  testPlaybookSelection();
  await testPlanValidation();
  await testRouter();

  console.log(`\n${pass} OK, ${fail} fallan.`);
  if (fail > 0) {
    console.log("Fallaron:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
