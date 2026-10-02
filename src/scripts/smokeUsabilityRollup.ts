/**
 * Smoke de U4 (USABILIDAD-SPEC.md §8): rollup de usabilidad + API.
 * Mongo EN MEMORIA — nunca toca la base compartida.
 *
 *   npm run smoke:usability-rollup
 */
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AnalyticsEvent } from "../modules/analytics/analytics.model";
import { analyticsService } from "../modules/analytics/analytics.service";
import { UsabilityFlowDaily, UsabilityLayout, UsabilityScreenDaily } from "../modules/usability/usability.model";
import { usabilityRouter } from "../modules/usability/usability.router";
import { histPercentile } from "../modules/usability/usability.service";
import { computeUsabilityDay, dayKey } from "../modules/usability/usabilityRollup.service";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

let seq = 0;
const t0 = Date.now() - 60 * 60_000;
function ev(eventName: string, companyId: string, userId: string, sessionId: string, at: number, payload: Record<string, unknown>) {
  seq++;
  return {
    eventName,
    source: "pms-core",
    companyId,
    userId,
    sessionId,
    payload,
    clientTimestamp: new Date(t0 + at * 1000).toISOString(),
    correlationId: `pms-core:${sessionId}:${seq}`,
  };
}
const left = (screenKey: string, appId: string, activeMs: number, scroll: number, bucket = "d") => ({
  appId,
  screenKey,
  vwBucket: bucket,
  activeMs,
  idleMs: 1000,
  maxScrollPct: scroll,
  docH: 2000,
  clicks: 3,
});
const click = (screenKey: string, appId: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  appId,
  screenKey,
  x,
  y,
  vw: 1440,
  vh: 900,
  docH: 2000,
  vwBucket: "d",
  el: { tag: "button", sig: "aaaa1111" },
  rage: 0,
  dead: false,
  ...extra,
});

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await AnalyticsEvent.syncIndexes();
  process.env.JWT_SECRET = "smoke";
  process.env.NODE_ENV = "development";

  const E: ReturnType<typeof ev>[] = [];
  // Sesion A (co-1, user-1): home → tarifas → home → reservas (tarifas es ida y vuelta: 8 s)
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 10, left("home", "pms", 9000, 40)));
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 18, left("reservas:tarifas", "tarifas", 7000, 100)));
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 30, left("home", "pms", 11000, 80)));
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 90, left("reservas", "todas-reservas", 55000, 100)));
  // Sesion B (co-1, user-2): home → reservas
  E.push(ev("ui_screen_left", "co-1", "user-2", "sB", 20, left("home", "pms", 20000, 20, "m")));
  E.push(ev("ui_screen_left", "co-1", "user-2", "sB", 60, left("reservas", "todas-reservas", 35000, 50, "m")));
  // Sesion C (co-2, user-1 — MISMO usuario en otra compañia): home
  E.push(ev("ui_screen_left", "co-2", "user-1", "sC", 15, left("home", "pms", 14000, 100)));
  // Sesion D en un iframe (capa booking) en paralelo a la A
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 25, left("booking:tarifas", "tarifas", 6000, 70)));
  E.push(ev("ui_screen_left", "co-1", "user-1", "sA", 40, left("booking:panel", "panel-reservas", 9000, 30)));

  // Clics en home: 3 comunes, 1 frustracion, 1 muerto
  E.push(ev("ui_click", "co-1", "user-1", "sA", 2, click("home", "pms", 720, 100)));
  E.push(ev("ui_click", "co-1", "user-1", "sA", 3, click("home", "pms", 725, 110)));
  E.push(ev("ui_click", "co-1", "user-2", "sB", 4, click("home", "pms", 100, 500, { el: { tag: "a", sig: "bbbb2222" } })));
  E.push(ev("ui_click", "co-1", "user-1", "sA", 5, click("home", "pms", 720, 100, { rage: 5 })));
  E.push(ev("ui_click", "co-2", "user-1", "sC", 6, click("home", "pms", 1400, 1900, { dead: true })));
  // Errores y fallas en reservas
  E.push(ev("ui_error_shown", "co-1", "user-1", "sA", 70, { appId: "todas-reservas", screenKey: "reservas", kind: "alert", code: "reservas.save_failed" }));
  E.push(ev("ui_error_shown", "co-1", "user-2", "sB", 50, { appId: "todas-reservas", screenKey: "reservas", kind: "inline" }));
  E.push(ev("ui_js_error", "co-1", "user-2", "sB", 51, { appId: "todas-reservas", screenKey: "reservas", kind: "error", sig: "deadbeef" }));
  E.push(ev("ui_form_invalid", "co-1", "user-2", "sB", 52, { appId: "todas-reservas", screenKey: "reservas", formSig: "cafe0001", fields: 2 }));
  // Vitals
  E.push(ev("ui_vitals", "co-1", "user-1", "sA", 10, { appId: "pms", screenKey: "home", vwBucket: "d", lcp: 1200, inp: 80, cls: 0.01 }));
  E.push(ev("ui_vitals", "co-1", "user-2", "sB", 20, { appId: "pms", screenKey: "home", vwBucket: "m", lcp: 4200, inp: 350, cls: 0.2 }));
  // Esqueletos: dos de home/d, gana el mas nuevo
  E.push(ev("ui_layout", "co-1", "user-1", "sA", 3, { appId: "pms", screenKey: "home", vwBucket: "d", vw: 1440, docH: 2000, rects: [{ x: 0, y: 0, w: 1440, h: 64, k: "nav" }] }));

  const r = await analyticsService.ingestBatch(E as never);
  check("ingesta acepta todos los eventos sinteticos", r.accepted === E.length, r);
  await new Promise((res) => setTimeout(res, 20));
  await analyticsService.ingestBatch([
    ev("ui_layout", "co-1", "user-1", "sA", 4, {
      appId: "pms",
      screenKey: "home",
      vwBucket: "d",
      vw: 1440,
      docH: 2100,
      rects: [
        { x: 0, y: 0, w: 1440, h: 64, k: "nav" },
        { x: 600, y: 80, w: 200, h: 40, k: "button" },
      ],
    }) as never,
  ]);

  const day = dayKey(new Date());
  const n1 = await computeUsabilityDay(day);
  const n2 = await computeUsabilityDay(day);
  check("recomputar el dia es idempotente (mismos documentos)", n1 === n2 && n1 > 0, { n1, n2 });

  const gHome = await UsabilityScreenDaily.findOne({ day, companyId: "*", screenKey: "home" }).lean();
  const c1Home = await UsabilityScreenDaily.findOne({ day, companyId: "co-1", screenKey: "home" }).lean();
  check("home global: 4 vistas (A x2, B, C)", gHome?.views === 4, gHome?.views);
  check("home global: usuarios DISTINTOS = 2 (user-1 en dos compañias cuenta 1)", gHome?.users === 2, gHome?.users);
  check("home co-1: 3 vistas, 2 usuarios", c1Home?.views === 3 && c1Home?.users === 2, c1Home);
  check("home: 5 clics, 1 frustracion, 1 muerto", gHome?.clicks === 5 && gHome?.rage === 1 && gHome?.dead === 1, gHome);
  check("home: vistas por tamaño d=3 m=1", (gHome?.viewsByBucket as any)?.d === 3 && (gHome?.viewsByBucket as any)?.m === 1, gHome?.viewsByBucket);

  const gTar = await UsabilityScreenDaily.findOne({ day, companyId: "*", screenKey: "reservas:tarifas" }).lean();
  check("tarifas: 1 ida y vuelta (home → tarifas → home en 8 s)", gTar?.backtracks === 1, gTar?.backtracks);

  const gRes = await UsabilityScreenDaily.findOne({ day, companyId: "*", screenKey: "reservas" }).lean();
  check("reservas: 2 errores (alert + inline) con codigo", gRes?.errorsShown === 2 && (gRes?.errorCodes as any)?.["reservas.save_failed"] === 1, gRes);
  check("reservas: 1 js error y 1 formulario rechazado", gRes?.jsErrors === 1 && gRes?.formInvalid === 1, gRes);
  check("reservas: salida de 2 sesiones (A y B terminan ahi)", gRes?.exits === 2, gRes?.exits);

  const dayDoc = await UsabilityScreenDaily.findOne({ day, companyId: "*", screenKey: "__day" }).lean();
  check("resumen del dia: 3 sesiones y 2 usuarios distintos", dayDoc?.sessions === 3 && dayDoc?.users === 2, dayDoc);

  const flows = await UsabilityFlowDaily.find({ day, companyId: "*", layer: "pms" }).lean();
  const f = (from: string, to: string) => flows.find((x) => x.from === from && x.to === to)?.n ?? 0;
  check("flujo pms: entrada → home x3", f("__entry", "home") === 3, flows);
  check("flujo pms: home → reservas x2", f("home", "reservas") === 2, flows);
  check("flujo pms: NO mezcla la capa booking", !flows.some((x) => x.to.startsWith("booking:")), flows);
  const bFlows = await UsabilityFlowDaily.find({ day, companyId: "*", layer: "booking" }).lean();
  check("flujo booking: tarifas → panel en su capa", bFlows.some((x) => x.from === "booking:tarifas" && x.to === "booking:panel"), bFlows);

  const lay = await UsabilityLayout.findOne({ screenKey: "home", vwBucket: "d" }).lean();
  check("esqueleto: gana el mas nuevo (2 rectangulos)", lay?.rects?.length === 2, lay);

  check("percentil de histograma (p50 de [1,1,1,1] en bordes 1..4)", histPercentile([1, 2, 3], [1, 1, 1, 1], 0.5) === 2);

  // ── API por el router real (con authenticate y authorize) ────────────────
  const app = express();
  app.use(express.json());
  app.use("/api/v1/usability", usabilityRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/usability`;
  const tok = (role: string) => jwt.sign({ userId: "smoke", email: "s@x", role }, "smoke");
  const get = async (p: string, role = "analyst") => {
    const res = await fetch(base + p, { headers: { authorization: `Bearer ${tok(role)}` } });
    return { status: res.status, json: (await res.json()) as any };
  };

  const ov = await get(`/overview?from=${day}&to=${day}`);
  check("GET /overview 200 con totales y ranking", ov.status === 200 && ov.json.totals.views === 9 && Array.isArray(ov.json.ranking), ov.json.totals);
  check("overview: frustracion cada 1000 clics = 200 (1 de 5)", ov.json.ragePer1000Clicks === 200, ov.json.ragePer1000Clicks);
  const sc = await get(`/screens?from=${day}&to=${day}`);
  const home = sc.json.screens?.find((s: any) => s.screenKey === "home");
  check("GET /screens trae home con lcp p75 y trabas/100", sc.status === 200 && home && home.lcpP75 > 0 && home.frictionPer100 > 0, home);
  const det = await get(`/screen?screenKey=home&vw=d&from=${day}&to=${day}`);
  check(
    "GET /screen: calor (celdas) + elementos + esqueleto + flujos de salida",
    det.status === 200 && det.json.heat.cells.length >= 2 && det.json.heat.elements[0].sig === "aaaa1111" && det.json.layout?.rects.length === 2 && det.json.outgoing.length > 0,
    det.json,
  );
  const fl = await get(`/flows?from=${day}&to=${day}&layer=booking`);
  check("GET /flows?layer=booking", fl.status === 200 && fl.json.edges.length > 0 && fl.json.layers.includes("pms"), fl.json);
  const fr = await get(`/frictions?from=${day}&to=${day}`);
  check("GET /frictions agrupa por tipo y pantalla", fr.status === 200 && fr.json.items.some((i: any) => i.kind === "errorsShown" && i.screenKey === "reservas"), fr.json.items);
  const forbidden = await get(`/overview`, "support");
  check("rol support → 403 (piso analyst)", forbidden.status === 403, forbidden.status);
  const missing = await get(`/screen?screenKey=no-existe&from=${day}&to=${day}`);
  check("pantalla sin datos → 404", missing.status === 404, missing.status);

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} FALLAS` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
