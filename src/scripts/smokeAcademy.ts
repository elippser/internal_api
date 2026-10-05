/**
 * Smoke de la Academia (ROOMBIR-ACADEMY-SPEC.md §6 y §7) por el router real,
 * con authenticate y authorize. Mongo EN MEMORIA: nunca toca la base
 * compartida.
 *
 *   npm run smoke:academy
 */
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { academyRouter } from "../modules/academy/academy.router";
import { AcademyAttempt, AcademyCard } from "../modules/academy/academy.model";
import { cbmScore } from "../modules/academy/academy.service";
import { BANK, BANK_BY_ID } from "../modules/academy/bank/items";
import { areaForPath, checkArea } from "../shared/access/areas";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([AcademyCard.syncIndexes(), AcademyAttempt.syncIndexes()]);
  process.env.JWT_SECRET = "smoke";
  process.env.NODE_ENV = "development";

  // ── Banco ────────────────────────────────────────────────────────────────
  const ids = new Set(BANK.map((b) => b.id));
  check("ids del banco unicos", ids.size === BANK.length);
  check("cada item tiene 3 opciones, 3 porques y correcta valida", BANK.every((b) => b.options.length === 3 && b.why.length === 3 && b.correct >= 0 && b.correct <= 2));
  check("opciones distintas dentro de cada item (la practica identifica por texto)", BANK.every((b) => new Set(b.options).size === 3));
  check("Roombir recien en el examen 3 (ningun item E/F en examenes 1 y 2)", BANK.every((b) => !/^[EF]./.test(b.lesson) || b.exam === 3));
  check("hay criticos en los tres examenes", [1, 2, 3].every((n) => BANK.some((b) => b.exam === n && b.critical)));
  check("Roombir no se nombra en los examenes 1 y 2", BANK.every((b) => b.exam === 3 || !/roombir/i.test([b.stem, ...b.options, ...b.why].join(" "))));
  // El largo no puede delatar la correcta: el banco llego a tenerla como opcion mas larga en 109 de 127 items.
  const longest = (b: (typeof BANK)[number]) => b.options[b.correct].length >= Math.max(...b.options.map((o) => o.length));
  const lengthCue = (b: (typeof BANK)[number]) => {
    const others = b.options.filter((_, i) => i !== b.correct).map((o) => o.length);
    const avg = (others[0] + others[1]) / 2;
    return b.options[b.correct].length > avg * 2 && b.options[b.correct].length - avg > 40;
  };
  check("ningun item delata la correcta por duplicar el largo de los distractores", !BANK.some(lengthCue), BANK.filter(lengthCue).map((b) => b.id));
  check(
    "la correcta es la opcion mas larga en menos de la mitad de cada examen",
    [1, 2, 3].every((n) => BANK.filter((b) => b.exam === n && longest(b)).length < BANK.filter((b) => b.exam === n).length / 2),
    [1, 2, 3].map((n) => BANK.filter((b) => b.exam === n && longest(b)).length),
  );
  check("CBM: +3 / -6 / 0", cbmScore(true, 3) === 3 && cbmScore(false, 3) === -6 && cbmScore(false, 1) === 0);

  // ── API ──────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use("/api/v1/academy", academyRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/academy`;
  const tok = (role: string, userId = "learner", areaAccess?: Record<string, string>) =>
    jwt.sign({ userId, email: `${userId}@x`, role, ...(areaAccess ? { areaAccess } : {}) }, "smoke");
  const call = async (method: string, p: string, body?: unknown, role = "support", userId = "learner", areaAccess?: Record<string, string>) => {
    const res = await fetch(base + p, {
      method,
      headers: { authorization: `Bearer ${tok(role, userId, areaAccess)}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };

  const me0 = await call("GET", "/me");
  check("GET /me 200 para support, sin oficio elegido", me0.status === 200 && me0.json.review.due === 0 && me0.json.track === null, me0);
  const en = await call("PUT", "/enrollment", { track: "ventas" });
  check("PUT /enrollment guarda el oficio", en.status === 200 && en.json.track === "ventas", en.json);
  const enBad = await call("PUT", "/enrollment", { track: "astronauta" });
  check("oficio inexistente → 400", enBad.status === 400, enBad);
  const me1 = await call("GET", "/me");
  check("GET /me devuelve el oficio", me1.json.track === "ventas", me1.json.track);

  // Quiz de leccion: nunca trae la correcta.
  const quiz = await call("GET", "/lessons/B.3/quiz");
  check("quiz B.3 trae todos sus items sin correcta ni porques", quiz.status === 200 && quiz.json.items.length === BANK.filter((b) => b.lesson === "B.3").length && quiz.json.items.every((i: any) => i.correctIndex === undefined && i.why === undefined), quiz.json);

  // Pregunta previa: se guarda sin correccion.
  const pre = quiz.json.items[0];
  const preRes = await call("POST", "/lessons/B.3/pre-answer", { itemId: pre.id, chosenText: pre.options[0], certainty: 2 });
  check("pre-answer guarda sin devolver correccion", preRes.status === 200 && preRes.json.saved === true && preRes.json.correct === undefined, preRes);
  const preWrong = await call("POST", "/lessons/A.1/pre-answer", { itemId: pre.id, chosenText: pre.options[0], certainty: 2 });
  check("pre-answer de un item de otra leccion → 400", preWrong.status === 400, preWrong);

  // Practica: acierto con certeza alta → caja 2; error con certeza alta → caja 1 mañana.
  const ok = BANK_BY_ID.get("b3-ocupacion-01")!;
  const ans1 = await call("POST", "/answer", { itemId: ok.id, chosenText: ok.options[ok.correct], certainty: 3 });
  check("practica correcta: correct y cbm +3", ans1.status === 200 && ans1.json.correct === true && ans1.json.cbm === 3, ans1.json);
  const bad = BANK_BY_ID.get("e5-pagos-01")!;
  const wrongText = bad.options.find((_, i) => i !== bad.correct)!;
  const ans2 = await call("POST", "/answer", { itemId: bad.id, chosenText: wrongText, certainty: 3 });
  check("practica incorrecta segura: cbm -6 y porques", ans2.json.correct === false && ans2.json.cbm === -6 && ans2.json.why.length === 3, ans2.json);
  const cOk = await AcademyCard.findOne({ userId: "learner", itemId: ok.id }).lean();
  const cBad = await AcademyCard.findOne({ userId: "learner", itemId: bad.id }).lean();
  const days = (d: Date) => Math.round((new Date(d).getTime() - Date.now()) / 86_400_000);
  check("tarjeta acertada: caja 2, vuelve en 3 dias", cOk?.box === 2 && days(cOk.dueAt) === 3, cOk);
  check("tarjeta errada: caja 1, vuelve mañana", cBad?.box === 1 && days(cBad.dueAt) === 1, cBad);
  const badOpt = await call("POST", "/answer", { itemId: ok.id, chosenText: "inventada", certainty: 1 });
  check("opcion inexistente → 400", badOpt.status === 400, badOpt);

  // Repaso: se adelanta el vencimiento y aparece.
  await AcademyCard.updateMany({ userId: "learner" }, { $set: { dueAt: new Date(Date.now() - 1000) } });
  const rev = await call("GET", "/review/today");
  check("repaso trae las 2 tarjetas vencidas, sin correcta", rev.status === 200 && rev.json.totalDue === 2 && rev.json.items.length === 2 && rev.json.items.every((i: any) => i.correctIndex === undefined), rev.json);

  // Explicalo + hecha.
  const upd = await call("PATCH", "/lessons/B.3", { explainBack: "Un hotel lleno puede ganar menos si bajó mucho el precio.", status: "hecha" });
  check("PATCH leccion → hecha con explainBack", upd.status === 200 && upd.json.status === "hecha" && upd.json.doneAt, upd.json);

  // Examen 1: empezar, retomar el mismo intento abierto, entregar.
  const st = await call("POST", "/attempts/examen1/start");
  const pool1 = BANK.filter((b) => b.exam === 1).length;
  check("start examen1: items sin correcta", st.status === 200 && st.json.items.length === Math.min(24, pool1) && st.json.items.every((i: any) => i.correctIndex === undefined), { status: st.status, n: st.json.items?.length });
  // Se aprueba con el 100% de los criticos: tienen que entrar todos, no los que toque el sorteo.
  const criticalIds = (n: number) => BANK.filter((b) => b.exam === n && b.critical).map((b) => b.id);
  const hasAll = (items: any[], wanted: string[]) => wanted.every((id) => items.some((i) => i.id === id));
  check("examen1 trae todos los criticos de su banco", hasAll(st.json.items, criticalIds(1)), criticalIds(1));
  const st2 = await call("POST", "/attempts/examen1/start");
  check("start de nuevo devuelve el MISMO intento abierto", st2.json.attemptId === st.json.attemptId);

  // Respuestas perfectas: hay que traducir la correcta al orden mostrado.
  const doc = await AcademyAttempt.findById(st.json.attemptId).lean();
  const orders = doc!.optionOrders as Record<string, number[]>;
  const perfect = st.json.items.map((it: any) => ({
    itemId: it.id,
    chosen: orders[it.id].indexOf(BANK_BY_ID.get(it.id)!.correct),
    certainty: 3,
  }));
  const sub = await call("POST", `/attempts/${st.json.attemptId}/submit`, { answers: perfect });
  check("examen perfecto: aprobado, 100%, criticos ok", sub.status === 200 && sub.json.passed === true && sub.json.pctCorrect === 1 && sub.json.criticalOk === true, { ...sub.json, items: undefined });
  check("la correccion trae correctIndex coincidente con lo elegido", sub.json.items.every((i: any) => i.correctIndex === i.chosenIndex));
  const again = await call("POST", `/attempts/${st.json.attemptId}/submit`, { answers: perfect });
  check("entregar dos veces → 409", again.status === 409, again);

  // Examen 2: todo bien MENOS un critico → no aprueba aunque supere el 80%, y bloquea 48 h.
  const s2 = await call("POST", "/attempts/examen2/start");
  check("examen2 trae todos los criticos de su banco", hasAll(s2.json.items, criticalIds(2)), criticalIds(2));
  const d2 = await AcademyAttempt.findById(s2.json.attemptId).lean();
  const o2 = d2!.optionOrders as Record<string, number[]>;
  let failedCritical = false;
  const answers2 = s2.json.items.map((it: any) => {
    const item = BANK_BY_ID.get(it.id)!;
    let chosen = o2[it.id].indexOf(item.correct);
    if (item.critical && !failedCritical) {
      failedCritical = true;
      chosen = (chosen + 1) % 3;
    }
    return { itemId: it.id, chosen, certainty: 3 };
  });
  const sub2 = await call("POST", `/attempts/${s2.json.attemptId}/submit`, { answers: answers2 });
  check("un critico mal → no aprueba aunque el % supere 80", sub2.json.passed === false && sub2.json.criticalOk === false && sub2.json.pctCorrect > 0.8, { pct: sub2.json.pctCorrect, passed: sub2.json.passed });
  check("el critico errado con certeza alta queda marcado como mal informada", sub2.json.items.some((i: any) => i.misinformed && i.critical));
  const retry = await call("POST", "/attempts/examen2/start");
  check("reintento antes de 48 h → 409 retake_wait", retry.status === 409 && retry.json.code === "retake_wait", retry);

  const att = await call("GET", "/attempts");
  check("GET /attempts lista 2 entregados", att.status === 200 && att.json.data.length === 2, att.json);
  const res1 = await call("GET", `/attempts/${st.json.attemptId}`);
  check("GET /attempts/:id trae la correccion", res1.status === 200 && res1.json.items.length === st.json.items.length);
  const foreign = await call("GET", `/attempts/${st.json.attemptId}`, undefined, "support", "otra");
  check("el intento de otra persona → 404", foreign.status === 404, foreign);

  // Pasadas las 48 h, el reintento vuelve a traer TODOS los criticos (aunque ya hayan salido) y
  // completa primero con lo que no salio antes.
  await AcademyAttempt.updateOne({ _id: s2.json.attemptId }, { $set: { submittedAt: new Date(Date.now() - 3 * 86_400_000) } });
  const retake = await call("POST", "/attempts/examen2/start");
  const prev2 = new Set<string>(s2.json.items.map((i: any) => i.id));
  const others = (retake.json.items ?? []).filter((i: any) => !BANK_BY_ID.get(i.id)!.critical);
  const freshPool = BANK.filter((b) => b.exam === 2 && !b.critical && !prev2.has(b.id)).length;
  check("reintento a las 48 h: trae todos los criticos otra vez", retake.status === 200 && hasAll(retake.json.items, criticalIds(2)), retake.status);
  check("reintento: completa primero con lo que no salio antes", others.filter((i: any) => !prev2.has(i.id)).length === Math.min(freshPool, others.length), { fresh: freshPool, n: others.length });

  // Piezas: guardar, enviar, revisar (admin).
  const p1 = await call("PUT", "/submissions/A", { draft: "Roombir junta reservas, web y motor en un solo lugar." });
  check("guardar entrega A en borrador", p1.status === 200 && p1.json.status === "borrador", p1.json);
  const p2 = await call("PUT", "/submissions/A", { submit: true });
  check("enviar entrega A", p2.json.status === "enviada", p2.json);
  const teamForbidden = await call("GET", "/team");
  check("GET /team con support → 403", teamForbidden.status === 403);
  const team = await call("GET", "/team", undefined, "admin", "founder");
  check("GET /team con admin → la persona y su pieza", team.status === 200 && team.json.people.some((p: any) => p.userId === "learner" && p.track === "ventas") && team.json.submissions.length === 1, team.json);
  const rv = await call("PATCH", `/team/submissions/${team.json.submissions[0].id}/review`, { rubric: { fidelidad: 2, reglas: 0, claridad: 2, oficio: 2 }, feedback: "Usaste 'todo en uno'." }, "admin", "founder");
  check("6/8 con un 0 en reglas → a corregir", rv.status === 200 && rv.json.status === "a_corregir", rv.json);
  const rv2 = await call("PATCH", `/team/submissions/${team.json.submissions[0].id}/review`, { rubric: { fidelidad: 2, reglas: 1, claridad: 2, oficio: 1 }, feedback: "Bien." }, "admin", "founder");
  check("6/8 sin ceros → aprobada", rv2.json.status === "aprobada", rv2.json);
  const locked = await call("PUT", "/submissions/A", { draft: "cambio" });
  check("pieza aprobada no se edita → 409", locked.status === 409, locked);

  // Fricciones.
  const fr = await call("POST", "/frictions", { source: "a-ciegas", screen: "alta: habitaciones", note: "No sé qué precio poner." });
  check("POST /frictions 201", fr.status === 201, fr);

  // Control de retencion: se habilita 30 dias despues de aprobar el examen 3.
  const meR0 = await call("GET", "/me", undefined, "support", "retencion");
  check("retencion: sin examen 3 aprobado no hay fecha", meR0.json.retention?.dueAt === null && meR0.json.retention?.due === false, meR0.json.retention);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  await AcademyAttempt.create({ userId: "retencion", kind: "examen3", itemIds: [], optionOrders: {}, startedAt: daysAgo(10), submittedAt: daysAgo(10), passed: true, pctCorrect: 1, cbmTotal: 0, criticalOk: true });
  const meR1 = await call("GET", "/me", undefined, "support", "retencion");
  check("retencion: aprobado hace 10 dias → con fecha, todavia no toca", Boolean(meR1.json.retention?.dueAt) && meR1.json.retention.due === false, meR1.json.retention);
  await AcademyAttempt.updateMany({ userId: "retencion", kind: "examen3" }, { $set: { submittedAt: daysAgo(31) } });
  const meR2 = await call("GET", "/me", undefined, "support", "retencion");
  check("retencion: aprobado hace 31 dias → toca y no esta hecho", meR2.json.retention?.due === true && meR2.json.retention.done === false, meR2.json.retention);

  // Area: el recorte corre en authenticate solo para usuarios del padron (los
  // sinteticos del smoke no lo pasan), asi que se prueba la regla directo.
  check("/academy cae en el area academy", areaForPath("/api/v1/academy/me") === "academy");
  check("area academy en none → rechaza", !checkArea({ academy: "none" }, "GET", "/api/v1/academy/me").ok);
  check("area academy en read → no puede responder", !checkArea({ academy: "read" }, "POST", "/api/v1/academy/answer").ok);
  check("solo academy: Asistencia en none → rechaza", !checkArea({ academy: "write", support: "none" }, "GET", "/api/v1/support-chat/conversations").ok);

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} FALLAS` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
