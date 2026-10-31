/**
 * Smoke de Sitios de clientes (web-stats). Corre sobre Mongo EN MEMORIA:
 * nunca toca la base compartida (dev y prod usan la misma URI).
 *
 *   npm run smoke:webstats
 */
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { AddressInfo } from "node:net";

process.env.JWT_SECRET = "smoke";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  process.env.PMS_MONGODB_URI = mem.getUri("pms");
  await mongoose.connect(mem.getUri("internal"));
  const { InternalUser } = await import("../modules/users/users.model");
  const { webStatsRouter } = await import("../modules/webStats/webStats.router");
  const { getPmsConnection } = await import("../shared/pmsDb");

  const person = (userId: string, role: string) =>
    InternalUser.create({ userId, email: `${userId}@smoke.test`, passwordHash: "x", firstName: userId, lastName: "Smoke", role });
  await person("ana", "analyst");
  await person("sole", "support");

  const db = (await getPmsConnection()).db!;
  const sub1 = new mongoose.Types.ObjectId();
  const sub2 = new mongoose.Types.ObjectId();
  const subB = new mongoose.Types.ObjectId();
  const hostId = new mongoose.Types.ObjectId();
  await db.collection("companies").insertMany([
    { companyId: "a", name: "Hotel A", plan: "pro" },
    { companyId: "b", name: "Hotel B", plan: "starter" },
    { companyId: "nosite", name: "Sin sitio" },
  ]);
  await db.collection("customhostnames").insertOne({ _id: hostId, domain: "hotela.com" });
  await db.collection("sites").insertMany([
    {
      companyId: "a",
      name: "Sitio de A",
      sitesByLanguage: [
        { _id: sub1, title: "Hotel A ES", language: "es", status: "active", domain: "a.roombir.site", customHostnames: [hostId], pages: [{ huge: true }] },
        { _id: sub2, title: "Hotel A EN", language: "en", status: "indraft", domain: "a-en.roombir.site" },
      ],
    },
    { companyId: "b", sitesByLanguage: [{ _id: subB, title: "Hotel B", status: "active", domain: "b.roombir.site" }] },
  ]);
  const day = (ago: number) => new Date(Date.now() - ago * 864e5);
  const ev = (companyId: string, subSiteId: unknown, o: Record<string, unknown>, ago = 0) => ({
    companyId,
    subSiteId: String(subSiteId),
    type: "view",
    kind: null,
    path: "/",
    label: "",
    country: "AR",
    referrerHost: null,
    device: "mobile",
    visitorId: "v1",
    day: day(ago).toISOString().slice(0, 10),
    createdAt: day(ago),
    ...o,
  });
  await db.collection("siteevents").insertMany([
    ev("a", sub1, {}),
    ev("a", sub1, { path: "/rooms", referrerHost: "www.hotela.com" }),
    ev("a", sub1, { visitorId: "v2", referrerHost: "www.google.com" }),
    ev("a", sub1, { visitorId: "v3", referrerHost: "gemini.google.com", device: "desktop" }, 2),
    ev("a", sub2, { visitorId: "v4", referrerHost: "agencia.com", country: "BR" }, 20),
    ev("a", sub1, { type: "click", kind: "whatsapp", label: "WhatsApp" }),
    ev("a", sub1, { type: "click", kind: "cta", label: "Reservar" }),
    ev("b", subB, { visitorId: "z1" }),
    ev("a", sub1, { visitorId: "viejo" }, 200),
  ]);

  const app = express();
  app.use(express.json());
  app.use("/api/v1/web-stats", webStatsRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/web-stats`;
  const call = async (who: string | null, path: string) => {
    const headers: Record<string, string> = who
      ? { Authorization: `Bearer ${jwt.sign({ userId: who, email: `${who}@smoke.test`, role: "analyst" }, "smoke")}` }
      : {};
    const r = await fetch(base + path, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };

  check("sin token: 401", (await call(null, "/")).status === 401);
  check("soporte no entra: 403", (await call("sole", "/")).status === 403);

  const o30 = (await call("ana", "/?days=30")).body;
  const a = o30.items.find((i: any) => i.companyId === "a");
  check("solo companias con sitio", o30.items.length === 2 && !o30.items.some((i: any) => i.companyId === "nosite"), o30.items);
  check("orden por visitantes", o30.items[0].companyId === "a");
  check("visitantes distintos", a.visitors === 4, a);
  check("vistas y clics", a.views === 5 && a.clicks === 2 && a.whatsapp === 1, a);
  check("sitios y publicados", a.sites === 2 && a.published === 1, a);
  check("no mezcla clientes", o30.items[1].visitors === 1 && o30.items[1].views === 1, o30.items[1]);

  const o7 = (await call("ana", "/?days=7")).body;
  check("ventana de 7 dias", o7.items[0].views === 4 && o7.items[0].visitors === 3, o7.items[0]);
  check("dias invalido cae en 30", (await call("ana", "/?days=9999")).body.range.days === 30);

  const d = (await call("ana", "/a?days=30")).body;
  const s = d.summary;
  const src = Object.fromEntries(s.sources.map((r: any) => [r.key, r.value]));
  check("detalle: totales", s.totals.views === 5 && s.totals.visitors === 4 && s.totals.whatsapp === 1, s.totals);
  check("fuentes: propio dominio afuera", src["hotela.com"] === undefined && src.direct === 1, src);
  check("fuentes: clasifica", src.google === 1 && src.ai === 1 && src["agencia.com"] === 1, src);
  check("serie completa", s.series.length === 30 && s.series[29].views === 3 && s.series[29].visitors === 2, s.series[29]);
  check("paginas y clics", s.pages.some((p: any) => p.key === "/rooms") && s.labels.some((l: any) => l.kind === "whatsapp" && l.label === "WhatsApp"));
  check("no expone el arbol ni hostnames", !JSON.stringify(d.sites).includes("huge") && !("customHostnames" in d.sites[0]), d.sites[0]);

  const only = (await call("ana", `/a?days=30&subSiteId=${sub2}`)).body.summary;
  check("filtro por sitio", only.totals.views === 1 && only.totals.visitors === 1, only.totals);
  check("subSiteId invalido se ignora", (await call("ana", "/a?subSiteId=%7B%7D")).body.summary.totals.views === 5);

  const empty = (await call("ana", "/nosite")).body.summary;
  check("sin datos no rompe", empty.totals.views === 0 && empty.totals.pagesPerVisit === 0 && empty.series.length === 30, empty.totals);
  check("compania inexistente: 404", (await call("ana", "/nada")).status === 404);

  server.close();
  await (await getPmsConnection()).close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} fallaron` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
