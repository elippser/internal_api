/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * E2E de TODO el catálogo de Roombir IA contra los servicios reales.
 *
 * `test:tools` probaba unas 60 lecturas elegidas a mano: una tool nueva quedaba
 * afuera sin que nadie lo notara y las escrituras no se probaban nunca. Así
 * llegaron a producción una tool que devolvía 400 en TODA llamada
 * (update_engine_settings, 12-09-2026) y un agente que no podía ver el
 * calendario que ve el huésped (13-09-2026).
 *
 * Recorre el catálogo del CÓDIGO (`INITIAL_TOOLS`, sin publicarlo) por el mismo
 * camino que el chat: executeTool → política de acceso → JWT delegado → proxy →
 * servicio real.
 *
 *   1. LECTURAS, todas en vivo. Los IDs se cosechan de los resultados
 *      (unitId, reservationId, siteId...) en varias pasadas; lo que no se puede
 *      resolver queda SALTEADO con el parámetro que faltó.
 *   2. ESCRITURAS, todas en dry-run: se arma el request completo (política,
 *      path, dónde va el propertyId, JWT) sin mandarlo y se valida que pegue a
 *      una ruta que existe en los routers.
 *   3. Con --writes, ciclos REALES y reversibles sobre la propiedad de prueba
 *      (crear → leer → editar → borrar). Escriben en la base compartida con
 *      producción: se niegan a correr sobre otra propiedad salvo
 *      E2E_ALLOW_WRITES=1.
 *
 *   npm run test:tools-e2e
 *   npm run test:tools-e2e -- --writes
 *   npm run test:tools-e2e -- --only get_rate_plans,diagnose_booking_calendar
 *
 * Contexto: E2E_USER_ID / E2E_COMPANY_ID / E2E_PROPERTY_ID (por defecto el owner
 * de "Hotel Test"). Necesita pms-core, booking-app, rooms-app y rms-app
 * levantados en las URLs del .env.
 */
import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../shared/db";
import {
  executeTool,
  type ToolExecutionError,
} from "../modules/conversations/services/toolExecutor";
import { INITIAL_TOOLS } from "../modules/tools/tools.model";
import { findRoute, loadRouteInventory } from "./lib/pmsRouteInventory";

const TEST_PROPERTY = "prop-79f55cc9-2706-4729-9675-40936d86ff1c";

const CTX = {
  userId: process.env.E2E_USER_ID ?? "user-2858a5fc-09d7-4d5d-99c4-918386a34297",
  companyId: process.env.E2E_COMPANY_ID ?? "roombir-d89bd59c-1774-480c-8115-3128944641db",
  propertyId: process.env.E2E_PROPERTY_ID ?? TEST_PROPERTY,
  agentId: "agent-e2e-tools",
  sessionId: `sess-e2e-${Date.now()}`,
};

const argv = process.argv.slice(2);
const WITH_WRITES = argv.includes("--writes");
const onlyAt = argv.indexOf("--only");
const ONLY = onlyAt >= 0 ? new Set(String(argv[onlyAt + 1] ?? "").split(",").filter(Boolean)) : null;

// ── Catálogo del código, con los defaults que aplica seed:agent-tools ─────────

const CATALOG: any[] = (INITIAL_TOOLS as any[]).map((t) => ({
  ...t,
  status: t.status ?? "active",
  execution: { authStrategy: "staff_jwt", timeout: 10000, ...t.execution },
}));
const byName = new Map(CATALOG.map((t) => [t.name, t]));

/** Tools nativas que solo leen aunque su pathTemplate declare un POST. */
const NATIVE_READS = new Set([
  "get_page_content",
  "get_site_global_content",
  "check_site_quality",
  "diagnose_booking_calendar",
]);

const isRaw = (t: any) => t.execution?.pathTemplate === "{path}";
const isLiveRead = (t: any) =>
  !isRaw(t) && (t.execution?.method === "GET" || t.category === "ui_action" || NATIVE_READS.has(t.name));

// ── Fechas y valores de muestra ──────────────────────────────────────────────

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = isoOf(new Date());
const D = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoOf(d);
};

/**
 * Valores de muestra por nombre de parámetro. Un objeto `{ number, string }`
 * elige según el tipo que declara el schema de la tool: `month` es 1-12 en el
 * RMS y "YYYY-MM" en otros lados, y mandar el equivocado es un 400 del harness,
 * no de la tool.
 */
const SAMPLES: Record<string, unknown> = {
  checkIn: D(40),
  checkOut: D(42),
  from: D(0),
  to: D(20),
  start: D(0),
  end: D(20),
  startDate: D(0),
  endDate: D(20),
  start_date: D(0),
  end_date: D(30),
  stayDate: D(20),
  date: D(10),
  dateFrom: D(0),
  dateTo: D(20),
  month: { number: new Date().getMonth() + 1, string: TODAY.slice(0, 7) },
  year: { number: Number(TODAY.slice(0, 4)), string: TODAY.slice(0, 4) },
  adults: 2,
  children: 0,
  base: "USD",
  currencies: "ARS",
  q: "test",
  query: "test",
  term: "test",
  search: "test",
  scope: "top",
  platform: "booking",
  mode: "system",
  property_ids: CTX.propertyId,
};

function sampleFor(name: string, t: any): unknown {
  const s = SAMPLES[name];
  if (s === undefined) return undefined;
  const type = t?.inputSchema?.properties?.[name]?.type;
  if (s && typeof s === "object" && !Array.isArray(s)) {
    return (s as Record<string, unknown>)[type === "integer" ? "number" : type ?? "string"];
  }
  if ((type === "number" || type === "integer") && typeof s !== "number") return undefined;
  if (type === "string" && typeof s !== "string") return String(s);
  return s;
}

const ALIASES: Record<string, string[]> = {
  spaceId: ["operativeSpaceId"],
  operativeSpaceId: ["spaceId"],
  roomCategoryId: ["categoryId"],
  categoryId: ["roomCategoryId"],
};

/** Colecciones cuyo `_id` es el id de negocio que piden otras tools. */
const ARRAY_ID: Record<string, string> = {
  pages: "pageId",
  sitesByLanguage: "subSiteId",
};

// ── Cosecha de IDs ───────────────────────────────────────────────────────────

const pool = new Map<string, string[]>();
/**
 * subSiteId → siteId. Un sitio es un par: el harness mezclaba el subSiteId de un
 * proyecto con el siteId de otro y todas las lecturas del builder daban 400
 * "SubSite not found" sin que la tool tuviera nada que ver.
 */
const siteOfSubSite = new Map<string, string>();
/** subSiteId → ids de sus páginas: una página de otro sitio da "No existe la página". */
const pagesOfSubSite = new Map<string, string[]>();

/** Además de los `*Id`, claves que otras tools piden tal cual. */
const PLAIN_KEYS = new Set(["email", "slug", "language"]);

/**
 * Cosechas con nombre propio. El `_id` de una plantilla es el templateId que
 * piden sus tools (el `templateId` anidado del manifiesto es un slug), y el
 * `categoryId` de una categoría de SERVICIO no es el de una de habitaciones.
 */
const HARVEST_AS: Record<string, (res: any) => void> = {
  // Van PRIMERO en el pool: el `templateId` de un sitio (la plantilla que se le
  // aplicó, un slug) se cosecha antes desde list_site_projects y no es un id.
  list_site_templates: (res) => {
    for (const t of asList(res)) if (typeof t?._id === "string") remember("templateId", t._id, true);
  },
  list_service_categories: (res) => {
    for (const c of asList(res)) {
      const id = c?.categoryId ?? c?._id;
      if (typeof id === "string") remember("serviceCategoryId", id, true);
    }
  },
};
const SKIP_GENERIC_HARVEST = new Set(["list_service_categories"]);

function asList(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function remember(key: string, value: string, preferred = false): void {
  if (!value || value.length > 200 || /\s/.test(value)) return;
  // `__base__` y similares son marcadores sintéticos, no ids que otra tool acepte.
  if (value.startsWith("__")) return;
  const list = (pool.get(key) ?? []).filter((v) => v !== value);
  if (preferred) list.unshift(value);
  else list.push(value);
  pool.set(key, list);
}

function harvest(v: unknown, parentKey?: string, depth = 0): void {
  if (depth > 7 || v == null) return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 40)) harvest(x, parentKey, depth + 1);
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (parentKey && ARRAY_ID[parentKey] && typeof o._id === "string") remember(ARRAY_ID[parentKey], o._id);
  if (typeof o.siteId === "string" && typeof o.subSiteId === "string") siteOfSubSite.set(o.subSiteId, o.siteId);
  if (Array.isArray(o.pages)) {
    const sub = typeof o.subSiteId === "string" ? o.subSiteId : typeof o._id === "string" ? o._id : undefined;
    const ids = o.pages.map((p: any) => p?._id).filter((id: unknown): id is string => typeof id === "string");
    if (sub && ids.length) pagesOfSubSite.set(sub, ids);
  }
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === "string" && (/Id$/.test(k) || PLAIN_KEYS.has(k))) remember(k, val);
    else if (val && typeof val === "object") harvest(val, k, depth + 1);
  }
}

function first(key: string): string | undefined {
  return pool.get(key)?.[0];
}

function valueFor(name: string, t: any): unknown {
  if (name === "propertyId") return CTX.propertyId;
  if (name === "companyId") return CTX.companyId;
  if (name === "userId") return CTX.userId;
  const direct = first(name);
  if (direct) return direct;
  for (const alias of ALIASES[name] ?? []) {
    const v = first(alias);
    if (v) return v;
  }
  return sampleFor(name, t);
}

function placeholders(tpl: string): string[] {
  return [...String(tpl ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

function dummyFor(name: string, t: any): unknown {
  const type = t.inputSchema?.properties?.[name]?.type;
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  return /Id$/.test(name) ? "e2e-dry-run-id" : "e2e";
}

function buildArgs(t: any, mode: "live" | "dry"): { args: Record<string, unknown>; missing: string[] } {
  const names = new Set<string>([
    ...(t.inputSchema?.required ?? []),
    ...placeholders(t.execution?.pathTemplate),
  ]);
  // Opcionales con muestra (fechas, huéspedes): así se prueba la forma habitual.
  for (const k of Object.keys(t.inputSchema?.properties ?? {})) {
    if (sampleFor(k, t) !== undefined) names.add(k);
  }
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = valueFor(n, t);
    if (v !== undefined) args[n] = v;
    else if (mode === "dry") args[n] = dummyFor(n, t);
    else missing.push(n);
  }
  const pairedSite = typeof args.subSiteId === "string" ? siteOfSubSite.get(args.subSiteId) : undefined;
  if (pairedSite && "siteId" in args) args.siteId = pairedSite;
  const pages = typeof args.subSiteId === "string" ? pagesOfSubSite.get(args.subSiteId) : undefined;
  if (pages && "pageId" in args && !pages.includes(String(args.pageId))) args.pageId = pages[0];
  return { args, missing };
}

/**
 * Tools que dependen de un servicio que NO se levanta en local. Si fallan con
 * 503 se registran como salteadas con el motivo, no como falla de la tool.
 */
const ENV_DEPENDENT: Record<string, string> = {
  list_plans:
    "el catálogo de planes vive en internal-roombir, que no se levanta en local (re-ingiere señales en la base de producción)",
};

/** Argumentos extra para ejercitar lo que importa de algunas tools. */
const EXTRA_ARGS: Record<string, () => Record<string, unknown>> = {
  diagnose_booking_calendar: () => ({ checkIn: D(20), siteId: first("siteId"), subSiteId: first("subSiteId") }),
};

// ── Registro ─────────────────────────────────────────────────────────────────

type Outcome = "ok" | "empty" | "fail" | "skip";
const results: Array<{ name: string; phase: string; outcome: Outcome; detail: string }> = [];

function record(phase: string, name: string, outcome: Outcome, detail: string): void {
  results.push({ name, phase, outcome, detail });
  const mark = { ok: "✓", empty: "·", fail: "✗", skip: "-" }[outcome];
  if (outcome !== "skip") console.log(`  ${mark} ${name.padEnd(40)} ${detail}`);
}

function summarize(res: any): string {
  if (Array.isArray(res)) return `array(${res.length})`;
  if (res && typeof res === "object") {
    for (const k of ["data", "items", "units", "reservations", "issues", "findings"]) {
      if (Array.isArray(res[k])) return `${k}[${res[k].length}]`;
    }
    return `obj{${Object.keys(res).slice(0, 5).join(",")}}`;
  }
  return res === null ? "null" : String(res).slice(0, 40);
}

function isEmpty(res: any): boolean {
  if (res === null || res === undefined) return true;
  if (Array.isArray(res)) return res.length === 0;
  if (typeof res === "object") {
    for (const k of ["data", "items", "units", "reservations"]) {
      if (Array.isArray(res[k])) return res[k].length === 0;
    }
  }
  return false;
}

function errText(err: unknown): string {
  const e = err as ToolExecutionError;
  return e?.kind ? `${e.kind}/${e.status}: ${e.message}` : (err as Error)?.message ?? String(err);
}

async function run(name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<any> {
  const t = byName.get(name);
  if (!t) throw new Error(`La tool ${name} no está en el catálogo`);
  return executeTool(name, args, { ...CTX, toolDef: t, ...extra });
}

// ── 1. Lecturas en vivo ──────────────────────────────────────────────────────

async function liveReads(): Promise<void> {
  console.log("\n[1] LECTURAS EN VIVO");
  let pending = CATALOG.filter((t) => isLiveRead(t) && (!ONLY || ONLY.has(t.name)));
  for (let pass = 1; pass <= 5 && pending.length; pass++) {
    const next: any[] = [];
    for (const t of pending) {
      const { args, missing } = buildArgs(t, "live");
      if (missing.length) {
        next.push(t);
        continue;
      }
      Object.assign(args, EXTRA_ARGS[t.name]?.() ?? {});
      for (const [k, v] of Object.entries(args)) if (v === undefined) delete args[k];
      const t0 = Date.now();
      try {
        const res = await run(t.name, args);
        HARVEST_AS[t.name]?.(res);
        if (!SKIP_GENERIC_HARVEST.has(t.name)) harvest(res);
        record("read", t.name, isEmpty(res) ? "empty" : "ok", `${summarize(res)} · ${Date.now() - t0} ms`);
      } catch (err) {
        if (ENV_DEPENDENT[t.name] && (err as ToolExecutionError)?.status === 503) {
          record("read", t.name, "skip", `entorno: ${ENV_DEPENDENT[t.name]}`);
        } else {
          record("read", t.name, "fail", `${errText(err)} · args ${JSON.stringify(args).slice(0, 220)}`);
        }
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const t of pending) {
    record("read", t.name, "skip", `falta ${buildArgs(t, "live").missing.join(", ")}`);
  }

  // Lecturas crudas: lo que ve el huésped y los parámetros que el agente suele errar.
  if (!ONLY) {
    const raw: Array<[string, Record<string, unknown>]> = [
      ["read_booking_api", { path: "/api/v1/availability/public-calendar", query: { start: D(0), end: D(30), adults: 2, children: 0 } }],
      ["read_booking_api", { path: "/api/v1/engine-settings/public" }],
      ["read_booking_api", { path: "/api/v1/availability", query: { checkIn: D(40), checkOut: D(42), adults: 2 } }],
      ["read_pms_core_api", { path: `/api/v1/public/properties/by-id/${CTX.propertyId}` }],
      ["read_rooms_api", { path: `/api/v1/public/properties/${CTX.propertyId}/categories` }],
      ["read_rms_api", { path: "/api/v1/rms/config" }],
    ];
    for (const [name, args] of raw) {
      const label = `${name} ${String(args.path)}`;
      try {
        const res = await run(name, args);
        record("raw", label, isEmpty(res) ? "empty" : "ok", summarize(res));
      } catch (err) {
        record("raw", label, "fail", errText(err));
      }
    }
  }
}

// ── 2. Escrituras en dry-run ─────────────────────────────────────────────────

async function dryRunWrites(): Promise<void> {
  console.log("\n[2] ESCRITURAS EN DRY-RUN (request armado contra los routers reales)");
  const inventory = loadRouteInventory();
  const writes = CATALOG.filter((t) => !isLiveRead(t) && !isRaw(t) && (!ONLY || ONLY.has(t.name)));
  for (const t of writes) {
    const { args } = buildArgs(t, "dry");
    try {
      const r: any = await run(t.name, args, { dryRun: true });
      if (r?.native) {
        record("dry", t.name, "skip", "nativa: lee y escribe en varios pasos (test:guardrails)");
      } else if (inventory.missing.includes(r.service)) {
        record("dry", t.name, "skip", `${r.service} no está en el checkout`);
      } else if (!findRoute(inventory, r.service, r.method, r.path)) {
        record("dry", t.name, "fail", `no existe la ruta ${r.service} ${r.method} ${r.path}`);
      } else {
        record("dry", t.name, "ok", `${r.method} ${r.path.split("?")[0]}`);
      }
    } catch (err) {
      record("dry", t.name, "fail", `${errText(err)} · args ${JSON.stringify(args).slice(0, 200)}`);
    }
  }
}

// ── 3. Ciclos de escritura reversibles ───────────────────────────────────────

function findKey(v: unknown, key: string, depth = 0): string | undefined {
  if (depth > 5 || v == null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const f = findKey(x, key, depth + 1);
      if (f) return f;
    }
    return undefined;
  }
  const o = v as Record<string, unknown>;
  if (typeof o[key] === "string") return o[key] as string;
  for (const val of Object.values(o)) {
    const f = findKey(val, key, depth + 1);
    if (f) return f;
  }
  return undefined;
}

async function step(cycle: string, name: string, args: Record<string, unknown>): Promise<any> {
  try {
    const res = await run(name, args);
    record("write", `${cycle} → ${name}`, "ok", summarize(res));
    // Una lectura salteada por falta de datos queda cubierta si un ciclo la corrió.
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if ((r.phase === "read" || r.phase === "dry") && r.outcome === "skip" && r.name === name) results.splice(i, 1);
    }
    return res;
  } catch (err) {
    record("write", `${cycle} → ${name}`, "fail", `${errText(err)} · args ${JSON.stringify(args).slice(0, 200)}`);
    throw err;
  }
}

async function cycle(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch {
    // el paso que falló ya quedó registrado; seguimos con el próximo ciclo
  }
  void name;
}

async function writeCycles(): Promise<void> {
  console.log("\n[3] CICLOS DE ESCRITURA REALES (propiedad de prueba)");
  if (CTX.propertyId !== TEST_PROPERTY && process.env.E2E_ALLOW_WRITES !== "1") {
    console.log(`  ✗ ${CTX.propertyId} no es la propiedad de prueba: se omiten las escrituras (E2E_ALLOW_WRITES=1 para forzar).`);
    return;
  }
  const tag = `[e2e Roombir IA ${new Date().toISOString().slice(0, 16)}]`;

  await cycle("engine-settings", async () => {
    const s = await step("motor", "get_engine_settings", {});
    await step("motor", "update_engine_settings", { checkInTime: s.checkInTime, checkOutTime: s.checkOutTime });
    const after = await step("motor", "get_engine_settings", {});
    if (after.checkInTime !== s.checkInTime || after.checkOutTime !== s.checkOutTime) {
      record("write", "motor → ida y vuelta", "fail", "los horarios cambiaron tras reescribirlos iguales");
    }
  });

  await cycle("promo", async () => {
    const code = `E2E${Date.now().toString(36).toUpperCase()}`;
    const created = await step("promo", "create_promo", {
      name: tag,
      type: "code",
      code,
      discountType: "percentage",
      discountValue: 5,
    });
    const promoId = findKey(created, "promoId") ?? findKey(created, "_id");
    if (!promoId) {
      record("write", "promo → id", "fail", `create_promo no devolvió promoId: ${summarize(created)}`);
      return;
    }
    try {
      await step("promo", "get_promo_detail", { promoId });
      await step("promo", "toggle_promo", { promoId, isEnabled: false });
      await step("promo", "toggle_promo", { promoId, isEnabled: true });
      await step("promo", "update_promo", { promoId, name: `${tag} editada` });
    } finally {
      await step("promo", "delete_promo", { promoId });
    }
  });

  await cycle("rate-plan", async () => {
    const categoryId = first("categoryId");
    if (!categoryId) {
      record("write", "tarifa", "skip", "sin categoryId cosechado");
      return;
    }
    const settings = await run("get_engine_settings", {});
    const created = await step("tarifa", "create_rate_plan", {
      categoryId,
      name: tag,
      startDate: D(340),
      endDate: D(341),
      pricePerNight: 1,
      currency: settings?.currency ?? "ARS",
    });
    const ratePlanId = findKey(created, "ratePlanId") ?? findKey(created, "_id");
    if (!ratePlanId) {
      record("write", "tarifa → id", "fail", `create_rate_plan no devolvió ratePlanId: ${summarize(created)}`);
      return;
    }
    try {
      await step("tarifa", "get_rate_plan_detail", { ratePlanId });
      await step("tarifa", "update_rate_plan", { ratePlanId, name: `${tag} editada` });
    } finally {
      await step("tarifa", "delete_rate_plan", { ratePlanId });
    }
  });

  await cycle("unit-block", async () => {
    const unitId = first("unitId");
    if (!unitId) {
      record("write", "bloqueo", "skip", "sin unitId cosechado");
      return;
    }
    const created = await step("bloqueo", "create_unit_block", {
      unitId,
      startDate: D(330),
      endDate: D(331),
      type: "other",
      label: tag,
    });
    const blockId = findKey(created, "blockId") ?? findKey(created, "_id");
    if (!blockId) {
      record("write", "bloqueo → id", "fail", `create_unit_block no devolvió blockId: ${summarize(created)}`);
      return;
    }
    try {
      await step("bloqueo", "list_unit_blocks", { from: D(329), to: D(332) });
      await step("bloqueo", "update_unit_block", { blockId, notes: "e2e" });
    } finally {
      await step("bloqueo", "delete_unit_block", { blockId });
    }
  });

  await cycle("galería", async () => {
    const created = await step("galería", "create_gallery", { title: tag });
    const galleryId = findKey(created, "galleryId") ?? findKey(created, "_id");
    if (!galleryId) {
      record("write", "galería → id", "fail", `create_gallery no devolvió galleryId: ${summarize(created)}`);
      return;
    }
    try {
      await step("galería", "get_gallery", { galleryId });
      await step("galería", "list_gallery_media", { galleryId });
      await step("galería", "update_gallery", { galleryId, title: `${tag} editada` });
    } finally {
      await step("galería", "delete_gallery", { galleryId });
    }
  });

  await cycle("reseña", async () => {
    const created = await step("reseña", "create_review", { authorName: tag, rating: 5, source: "own", text: "e2e" });
    const reviewId = findKey(created, "reviewId") ?? findKey(created, "_id");
    if (!reviewId) {
      record("write", "reseña → id", "fail", `create_review no devolvió reviewId: ${summarize(created)}`);
      return;
    }
    try {
      await step("reseña", "get_review", { reviewId });
    } finally {
      await step("reseña", "delete_review", { reviewId });
    }
  });

  await cycle("carpeta", async () => {
    const created = await step("carpeta", "create_asset_folder", { name: tag });
    const folderId = findKey(created, "folderId") ?? findKey(created, "_id");
    if (!folderId) {
      record("write", "carpeta → id", "fail", `create_asset_folder no devolvió folderId: ${summarize(created)}`);
      return;
    }
    try {
      await step("carpeta", "get_asset_folder", { folderId });
      await step("carpeta", "list_asset_files", { folderId });
    } finally {
      await step("carpeta", "delete_asset_folder", { folderId });
    }
  });

  await cycle("servicio", async () => {
    const settings = await run("get_engine_settings", {});
    const cat = await step("servicio", "create_service_category", { title: tag });
    const serviceCategoryId = findKey(cat, "categoryId") ?? findKey(cat, "_id");
    if (!serviceCategoryId) {
      record("write", "servicio → categoría", "fail", `create_service_category no devolvió categoryId: ${summarize(cat)}`);
      return;
    }
    try {
      const created = await step("servicio", "create_service", {
        title: tag,
        categoryId: serviceCategoryId,
        chargeType: "per_reservation",
        currency: settings?.currency ?? "ARS",
        price: 1,
      });
      const serviceId = findKey(created, "serviceId") ?? findKey(created, "_id");
      if (!serviceId) {
        record("write", "servicio → id", "fail", `create_service no devolvió serviceId: ${summarize(created)}`);
        return;
      }
      try {
        await step("servicio", "get_service", { serviceId });
      } finally {
        await step("servicio", "delete_service", { serviceId });
      }
    } finally {
      await step("servicio", "delete_service_category", { categoryId: serviceCategoryId });
    }
  });

  await cycle("amenity", async () => {
    const created = await step("amenity", "create_amenity", { title: tag, type: "property" });
    const amenityId = findKey(created, "amenityId") ?? findKey(created, "_id");
    if (!amenityId) {
      record("write", "amenity → id", "fail", `create_amenity no devolvió amenityId: ${summarize(created)}`);
      return;
    }
    try {
      await step("amenity", "update_amenity", { amenityId, title: `${tag} editada` });
    } finally {
      await step("amenity", "delete_amenity", { amenityId });
    }
  });

  await cycle("catálogo", async () => {
    const created = await step("catálogo", "create_catalog_item", {
      name: tag,
      kind: "element",
      payload: { name: "Texto", type: "text", props: { text: "e2e" } },
    });
    const itemId = findKey(created, "itemId") ?? findKey(created, "_id");
    if (!itemId) {
      record("write", "catálogo → id", "fail", `create_catalog_item no devolvió itemId: ${summarize(created)}`);
      return;
    }
    try {
      await step("catálogo", "get_catalog_item", { itemId });
      await step("catálogo", "update_catalog_item", { itemId, name: `${tag} editado` });
    } finally {
      await step("catálogo", "delete_catalog_item", { itemId });
    }
  });

  await cycle("restricciones", async () => {
    const date = D(333);
    const prev = await step("restricciones", "list_day_restrictions", { from: date, to: date });
    if (asList(prev).length) {
      record("write", "restricciones", "skip", `ya hay una restricción cargada el ${date}: no se pisa`);
      return;
    }
    try {
      await step("restricciones", "set_day_restrictions", { items: [{ date, minStay: 2 }] });
      const after = await step("restricciones", "list_day_restrictions", { from: date, to: date });
      if (!JSON.stringify(after).includes('"minStay":2')) {
        record("write", "restricciones → lectura", "fail", `no aparece minStay 2 el ${date}: ${JSON.stringify(after).slice(0, 200)}`);
      }
    } finally {
      await step("restricciones", "set_day_restrictions", {
        items: [{ date, closed: false, closedToArrival: false, closedToDeparture: false, minStay: null, maxStay: null }],
      });
    }
  });

  await cycle("chat de equipo", async () => {
    // 'space' admite un solo miembro; un 'group' exige tres.
    const created = await step("chat", "create_team_conversation", { type: "space", memberIds: [CTX.userId], name: tag });
    const conversationId = findKey(created, "conversationId") ?? findKey(created, "_id");
    if (!conversationId) {
      record("write", "chat → id", "fail", `create_team_conversation no devolvió conversationId: ${summarize(created)}`);
      return;
    }
    try {
      await step("chat", "list_team_messages", { conversationId, limit: 5 });
    } finally {
      await step("chat", "archive_team_conversation", { conversationId });
    }
  });

  // Los borradores de migración no cambian nada hasta el commit, pero mientras
  // están abiertos el motor público se apaga: se abren y se cancelan enseguida,
  // y solo si no había uno abierto.
  await cycle("migración de moneda", async () => {
    const open = await step("moneda", "get_open_currency_migration", {});
    if (open?.found !== false) {
      record("write", "moneda", "skip", "ya hay una migración de moneda abierta: no se toca");
      return;
    }
    const settings = await run("get_engine_settings", {});
    const created = await step("moneda", "open_currency_migration", { toCurrency: settings?.currency === "USD" ? "ARS" : "USD" });
    const draftId = findKey(created, "draftId") ?? findKey(created, "_id");
    if (!draftId) {
      record("write", "moneda → id", "fail", `open_currency_migration no devolvió draftId: ${summarize(created)}`);
      return;
    }
    try {
      await step("moneda", "get_currency_migration", { draftId });
    } finally {
      await step("moneda", "cancel_currency_migration", { draftId });
    }
  });

  await cycle("migración de unidades", async () => {
    const open = await step("unidades", "get_open_unit_migration", {});
    if (open?.found !== false) {
      record("write", "unidades", "skip", "ya hay una migración de unidades abierta: no se toca");
      return;
    }
    let created: any;
    try {
      created = await step("unidades", "open_unit_migration", {});
    } catch {
      return; // registrado por step (p. ej. el modelo actual no admite migración)
    }
    const draftId = findKey(created, "draftId") ?? findKey(created, "_id");
    if (!draftId) {
      record("write", "unidades → id", "fail", `open_unit_migration no devolvió draftId: ${summarize(created)}`);
      return;
    }
    try {
      await step("unidades", "get_unit_migration", { draftId });
    } finally {
      await step("unidades", "cancel_unit_migration", { draftId });
    }
  });

  // Edición quirúrgica del builder sobre el BORRADOR del sitio de prueba: nunca
  // publica, y al final descarta el borrador. Si el sitio ya tenía un borrador
  // abierto (alguien editando) no se corre: descartar se llevaría ese trabajo.
  // autofix_site_quality queda afuera a propósito: guarda título/descripción
  // de la página y del sitio EN VIVO, no en el borrador.
  await cycle("builder", async () => {
    const subSiteId = first("subSiteId");
    const siteId = subSiteId ? siteOfSubSite.get(subSiteId) ?? first("siteId") : undefined;
    const pageId = subSiteId ? pagesOfSubSite.get(subSiteId)?.[0] : undefined;
    if (!subSiteId || !siteId || !pageId) {
      record("write", "builder", "skip", "sin sitio/página cosechados");
      return;
    }
    const base = { siteId, subSiteId };
    const drafts = await step("builder", "get_site_draft", { ...base, pageId });
    const hasDraft = ["page", "top", "bottom"].some(
      (k) => Array.isArray(drafts?.[k]) || Array.isArray(drafts?.[k]?.components),
    );
    if (hasDraft) {
      record("write", "builder", "skip", "el sitio tiene un borrador abierto: no se pisa ni se descarta");
      return;
    }
    try {
      const page = await step("builder", "get_page_content", { ...base, pageId });
      const leaf = (page?.editable ?? []).find((l: any) => typeof l?.value === "string");
      if (leaf) {
        await step("builder", "edit_page_content", { ...base, pageId, edits: [{ path: leaf.path, value: leaf.value }] });
      }
      if ((page?.componentCount ?? 0) > 0) {
        await step("builder", "duplicate_page_component", { ...base, pageId, componentIndex: 0 });
        await step("builder", "move_page_component", { ...base, pageId, from: 1, to: 0 });
        await step("builder", "remove_page_component", { ...base, pageId, componentIndex: 0 });
      }
      const top = await step("builder", "get_site_global_content", { ...base, scope: "top" });
      const topLeaf = (top?.editable ?? []).find((l: any) => typeof l?.value === "string");
      if (topLeaf) {
        await step("builder", "edit_site_global_content", { ...base, scope: "top", edits: [{ path: topLeaf.path, value: topLeaf.value }] });
      }
    } finally {
      await step("builder", "discard_site_draft", base);
    }
  });

  await cycle("diagnóstico", async () => {
    // El caso que originó todo: el diagnóstico tiene que nombrar la estadía máxima.
    const res = await step("diagnóstico", "diagnose_booking_calendar", { checkIn: D(20), to: D(120) });
    const text = JSON.stringify(res?.findings ?? []);
    if (!/estad[ií]a m[aá]xima|sin cupo|atravesarla/.test(text)) {
      record("write", "diagnóstico → explica el tope", "fail", `los hallazgos no nombran qué pone el tope: ${text.slice(0, 200)}`);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await connectDB();
  console.log(`\n=== E2E DEL CATÁLOGO DE ROOMBIR IA (${CATALOG.length} tools del código) ===`);
  console.log(`usuario ${CTX.userId} · empresa ${CTX.companyId} · propiedad ${CTX.propertyId}`);

  await liveReads();
  await dryRunWrites();
  if (WITH_WRITES) await writeCycles();

  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log("\n=================================================");
  console.log(`RESULTADO: ${count("ok")} OK · ${count("empty")} vacías · ${count("fail")} FALLAS · ${count("skip")} salteadas`);

  const skips = results.filter((r) => r.outcome === "skip");
  if (skips.length) {
    console.log("\nSALTEADAS:");
    for (const s of skips) console.log(`  - [${s.phase}] ${s.name}: ${s.detail}`);
  }
  const fails = results.filter((r) => r.outcome === "fail");
  if (fails.length) {
    console.log("\nFALLAS:");
    for (const f of fails) console.log(`  - [${f.phase}] ${f.name}: ${f.detail}`);
  }
  await mongoose.disconnect();
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error("harness caído:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
