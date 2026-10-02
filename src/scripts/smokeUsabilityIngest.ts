/**
 * Smoke de U1 (USABILIDAD-SPEC.md §8): contrato de ingesta de los eventos
 * `ui_*`. Corre sobre Mongo EN MEMORIA — nunca toca la base compartida.
 *
 *   npm run smoke:usability-ingest
 *
 * Verifica: que cada evento valido entra, que los estrictos rechazan cualquier
 * campo fuera del contrato (la via por la que se colaria texto del usuario),
 * que los patrones cierran codigos/pantallas con texto libre, y que los `ui_*`
 * llevan vencimiento a 30 dias con su indice TTL.
 */
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AnalyticsEvent } from "../modules/analytics/analytics.model";
import { analyticsService } from "../modules/analytics/analytics.service";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

let seq = 0;
function ev(eventName: string, payload: Record<string, unknown>) {
  seq++;
  return {
    eventName,
    source: "pms-core",
    companyId: "smoke-co",
    userId: "smoke-user",
    sessionId: "smoke-session",
    payload,
    clientTimestamp: new Date().toISOString(),
    correlationId: `pms-core:smoke-session:${seq}`,
  };
}

const base = { appId: "tarifas", screenKey: "reservas:tarifas" };
const click = {
  ...base,
  x: 420,
  y: 1310,
  vw: 1440,
  vh: 900,
  docH: 2400,
  vwBucket: "d",
  el: { tag: "button", role: "button", sig: "a1b2c3d4" },
  rage: 0,
  dead: false,
};

async function accepted(e: ReturnType<typeof ev>): Promise<boolean> {
  const r = await analyticsService.ingestBatch([e as never]);
  return r.accepted === 1;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await AnalyticsEvent.syncIndexes();

  // ── Validos ──────────────────────────────────────────────────────────────
  check("ui_click valido entra", await accepted(ev("ui_click", click)));
  check(
    "ui_click de frustracion (rage) entra",
    await accepted(ev("ui_click", { ...click, rage: 4 })),
  );
  check(
    "ui_screen_left entra",
    await accepted(
      ev("ui_screen_left", {
        ...base,
        vwBucket: "m",
        activeMs: 42_000,
        idleMs: 9_000,
        maxScrollPct: 63.5,
        docH: 2400,
        clicks: 12,
      }),
    ),
  );
  check(
    "ui_error_shown con codigo estable entra",
    await accepted(ev("ui_error_shown", { ...base, kind: "alert", code: "rates.save_failed" })),
  );
  check(
    "ui_form_invalid entra",
    await accepted(ev("ui_form_invalid", { ...base, formSig: "ffee0011", fields: 2 })),
  );
  check(
    "ui_js_error entra",
    await accepted(ev("ui_js_error", { ...base, kind: "error", sig: "0badc0de" })),
  );
  check(
    "ui_vitals entra",
    await accepted(ev("ui_vitals", { ...base, vwBucket: "d", lcp: 1800, inp: 120, cls: 0.02 })),
  );
  check(
    "ui_layout entra",
    await accepted(
      ev("ui_layout", {
        ...base,
        vwBucket: "d",
        vw: 1440,
        docH: 2400,
        rects: [
          { x: 0, y: 0, w: 1440, h: 64, k: "nav" },
          { x: 300, y: 120, w: 160, h: 40, k: "button" },
        ],
      }),
    ),
  );
  check(
    "ruta con parametro normalizado entra",
    await accepted(ev("ui_click", { ...click, screenKey: "projects/:id/editor" })),
  );

  // ── Privacidad: nada de texto libre ─────────────────────────────────────
  check(
    "campo extra en el payload → rechazado (estricto)",
    !(await accepted(ev("ui_click", { ...click, text: "Juan Perez" }))),
  );
  check(
    "campo extra dentro de el (el.label) → rechazado",
    !(await accepted(
      ev("ui_click", { ...click, el: { ...click.el, label: "Reserva de Juan Perez" } }),
    )),
  );
  check(
    "codigo de error con espacios (un mensaje) → rechazado",
    !(await accepted(
      ev("ui_error_shown", { ...base, kind: "alert", code: "No se pudo guardar la tarifa" }),
    )),
  );
  check(
    "screenKey con espacios o mayusculas → rechazado",
    !(await accepted(ev("ui_click", { ...click, screenKey: "Reservas de Juan" }))),
  );
  check(
    "sig que no es hash → rechazado",
    !(await accepted(ev("ui_js_error", { ...base, kind: "error", sig: "TypeError: x" }))),
  );
  check(
    "tipo de rectangulo desconocido → rechazado",
    !(await accepted(
      ev("ui_layout", {
        ...base,
        vwBucket: "d",
        vw: 1440,
        docH: 900,
        rects: [{ x: 0, y: 0, w: 10, h: 10, k: "screenshot" }],
      }),
    )),
  );
  check(
    "mas de 150 rectangulos → rechazado",
    !(await accepted(
      ev("ui_layout", {
        ...base,
        vwBucket: "d",
        vw: 1440,
        docH: 900,
        rects: Array.from({ length: 151 }, () => ({ x: 0, y: 0, w: 1, h: 1, k: "text" })),
      }),
    )),
  );
  check(
    "fuente distinta de pms-core → rechazado",
    !(await accepted({ ...ev("ui_click", click), source: "web-renderer" })),
  );

  // ── Retencion ────────────────────────────────────────────────────────────
  const ui = await AnalyticsEvent.findOne({ eventName: "ui_click" }).lean();
  const days = ui?.expiresAt
    ? (new Date(ui.expiresAt).getTime() - Date.now()) / 86_400_000
    : -1;
  check("ui_* lleva expiresAt a ~30 dias", days > 29.9 && days <= 30, { days });

  await analyticsService.ingestBatch([
    ev("app_opened", { appId: "tarifas" }) as never,
  ]);
  const other = await AnalyticsEvent.findOne({ eventName: "app_opened" }).lean();
  check("un evento comun NO lleva expiresAt (rige el TTL de 1 año)", Boolean(other) && !other!.expiresAt, other);

  const indexes = await AnalyticsEvent.collection.indexes();
  const ttl = indexes.find((i) => i.key && "expiresAt" in i.key);
  check("indice TTL sobre expiresAt (expireAfterSeconds 0)", ttl?.expireAfterSeconds === 0, ttl);

  const total = await AnalyticsEvent.countDocuments({});
  check("solo entraron los validos (9 ui_* + 1 comun)", total === 10, { total });

  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} FALLAS` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
