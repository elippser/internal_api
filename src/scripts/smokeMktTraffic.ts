/**
 * Smoke del tráfico de roombir.com (módulo mktanalytics). Corre sobre Mongo EN
 * MEMORIA — nunca toca la base compartida (dev y prod usan la misma URI).
 *
 *   npm run smoke:mkt-traffic            → contrato + agregaciones, y sale
 *   npm run smoke:mkt-traffic -- --serve → además queda sirviendo en :8699
 *
 * Con `--serve` el sitio (mkt-renderer con NEXT_PUBLIC_INTERNAL_API_URL
 * apuntando a :8699 e INTERNAL_API_SECRET=smoke) manda sus eventos reales acá,
 * y `GET /debug/overview|sessions|realtime` devuelve lo que vería el tablero.
 */
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MktSiteEvent } from "../modules/mktanalytics/mktanalytics.model";
import { publicMktEventsRouter } from "../modules/mktanalytics/mktanalytics.router";
import {
  channelOf,
  ingest,
  overview,
  parseRange,
  realtime,
  recentSessions,
  sessionTimeline,
} from "../modules/mktanalytics/mktanalytics.service";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const now = () => new Date().toISOString();
function ev(t: string, sid: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    t,
    vid: `v${sid}`,
    sid,
    ts: now(),
    path: "/es",
    route: "home",
    locale: "es",
    device: "mobile",
    data,
    ...extra,
  };
}

async function contract() {
  // Canal: la campaña manda sobre el referente.
  check("canal pago por utm_medium", channelOf("l.instagram.com", { medium: "paid_social" }) === "paid");
  check("canal social por referente", channelOf("l.instagram.com", null) === "social");
  check("canal buscador", channelOf("www.google.com", null) === "search");
  check("canal IA", channelOf("chatgpt.com", null) === "ai");
  check("canal directo", channelOf(null, null) === "direct");
  check("canal propio no es referral", channelOf("app.roombir.com", null) === "direct");

  const r1 = await ingest([
    ev("page_view", "s1", { pv: "p1", title: "Roombir" }, { refHost: "www.google.com", newVisitor: true }),
    ev("click", "s1", { kind: "signup", zone: "header", target: "crearCuenta", label: "Empezar" }),
    // Dos salidas de la MISMA vista (pestaña oculta y después cierre): suman.
    ev("page_leave", "s1", { pv: "p1", engagedMs: 30_000, scroll: 60 }),
    ev("page_leave", "s1", { pv: "p1", engagedMs: 12_000, scroll: 80 }),
    ev("page_view", "s1", { pv: "p2" }, { route: "crearCuenta", path: "/es/crear-cuenta" }),
    ev("form_view", "s1", { form: "signup" }, { route: "crearCuenta" }),
    ev("form_start", "s1", { form: "signup", field: "hotelName" }, { route: "crearCuenta" }),
    ev("form_submit", "s1", { form: "signup", fields: ["hotelName"], ms: 9000 }, { route: "crearCuenta" }),
    ev("form_invalid", "s1", { form: "signup", fields: ["email", "city"] }, { route: "crearCuenta" }),
    ev("form_success", "s1", { form: "signup", ms: 30_000 }, { route: "crearCuenta" }),
    ev("page_view", "s2", { pv: "p3" }, { utm: { source: "instagram", medium: "paid_social", campaign: "fundadores" } }),
    ev("page_leave", "s2", { pv: "p3", engagedMs: 3000, scroll: 20 }),
    ev("video_play", "s1", { video: "hero-es.mp4" }),
    ev("video_progress", "s1", { video: "hero-es.mp4", pct: 50 }),
  ]);
  check("eventos validos entran", r1.accepted === 14 && r1.dropped === 0, r1);

  const r2 = await ingest([
    ev("page_view", "s3", {}, { t: "inventado" }),
    ev("click", "s3", { kind: "cta", zone: "header", target: "x", value: "texto del usuario" }),
    ev("form_start", "s3", { form: "lead", field: "juan perez@mail.com" }),
    { ...ev("page_view", "s3", {}), vid: "Con Espacios" },
  ]);
  // El clic con un campo de más pasa SIN ese campo (stripUnknown); los otros caen.
  check("tipo, campo con texto libre y vid invalido se descartan", r2.accepted === 1 && r2.dropped === 3, r2);
  const leaked = await MktSiteEvent.findOne({ "data.value": { $exists: true } }).lean();
  check("un campo fuera del contrato no se guarda", !leaked);

  const o = await overview(parseRange({}));
  const t = o.totals!;
  check("sesiones", t.sessions === 3, t);
  check("visitantes", t.visitors === 3, t);
  check("altas", t.signups === 1 && t.converted === 1, t);
  check("rebote: s2 (1 página, sin clics, 3 s)", t.bounced >= 1, t);
  check("canales", o.channels.some((c: { key: string }) => c.key === "paid") && o.channels.some((c: { key: string }) => c.key === "search"), o.channels);
  check("campaña", o.campaigns.some((c: { key: string }) => c.key === "fundadores"), o.campaigns);
  const home = o.pages.find((p: { route: string }) => p.route === "home");
  check("página: atención media por vista", home?.avgEngagedMs === Math.round((42_000 + 3000) / 2), home);
  check("página: scroll = máximo de cada vista", home?.avgScroll === 50 && home?.reached75 === 0.5, home);
  const signupForm = o.forms.find((f) => f.form === "signup");
  check("embudo del formulario", signupForm?.view === 1 && signupForm.start === 1 && signupForm.success === 1, signupForm);
  check("campos inválidos", o.formFields.length === 2, o.formFields);
  const signupCta = o.ctas.find((c: { kind: string }) => c.kind === "signup");
  check("CTA agrupado con su texto de muestra", signupCta?.clicks === 1 && signupCta?.label === "Empezar", o.ctas);
  check("video", o.videos[0]?.play === 1 && o.videos[0]?.p50 === 1, o.videos);
  const ses = await recentSessions(parseRange({}));
  check("sesiones recientes", ses.length === 3, ses.length);
  const tl = await sessionTimeline("s1");
  check("recorrido ordenado", tl.length === 12 && tl[0].t === "page_view", tl.length);
  const rt = await realtime();
  check("en vivo", rt.active === 3, rt.active);
}

async function main() {
  const serve = process.argv.includes("--serve");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await MktSiteEvent.syncIndexes();

  if (!serve) {
    await contract();
    await mongoose.disconnect();
    await mem.stop();
    console.log(failures ? `\n${failures} FALLAS` : "\nTodo OK");
    process.exit(failures ? 1 : 0);
  }

  process.env.PMS_INTERNAL_SECRET = process.env.PMS_INTERNAL_SECRET || "smoke";
  const app = express();
  app.use(express.json());
  app.use("/public/mkt/events", publicMktEventsRouter);
  app.get("/debug/overview", async (req, res) => res.json(await overview(parseRange(req.query as never))));
  app.get("/debug/sessions", async (req, res) => res.json({ data: await recentSessions(parseRange(req.query as never)) }));
  app.get("/debug/sessions/:sid", async (req, res) => res.json({ data: await sessionTimeline(req.params.sid) }));
  app.get("/debug/realtime", async (_req, res) => res.json(await realtime()));
  app.get("/debug/raw", async (_req, res) => res.json(await MktSiteEvent.find().sort({ ts: 1 }).lean()));
  const port = Number(process.env.SMOKE_PORT) || 8699;
  app.listen(port, () => console.log(`smoke mkt-traffic sirviendo en :${port} (secret "${process.env.PMS_INTERNAL_SECRET}")`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
