/**
 * Smoke de Proyectos y tareas (modulo work). Corre sobre Mongo EN MEMORIA:
 * nunca toca la base compartida (dev y prod usan la misma URI).
 *
 *   npm run smoke:work
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
  await mongoose.connect(mem.getUri());
  const { InternalUser } = await import("../modules/users/users.model");
  const { workRouter } = await import("../modules/work/work.router");

  const person = (userId: string, role: string) =>
    InternalUser.create({ userId, email: `${userId}@smoke.test`, passwordHash: "x", firstName: userId, lastName: "Smoke", role });
  await person("jefe", "admin");
  await person("ana", "support");
  await person("beto", "support");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/work", workRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/work`;

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const token = jwt.sign({ userId: who, email: `${who}@smoke.test`, role: "support" }, "smoke");
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: (await r.json()) as any };
  };

  // Armado
  const project = await call("jefe", "POST", "/projects", { title: "Lanzamiento", details: "Detalle", targetDate: "2027-01-31", ownerId: "ana" });
  check("admin crea proyecto", project.status === 201, project);
  const pid = project.data.projectId;
  const denied = await call("ana", "POST", "/projects", { title: "No debería" });
  check("empleado no crea proyectos", denied.status === 403, denied);

  const t1 = await call("jefe", "POST", "/tasks", { title: "Del proyecto", details: "Hacer X", projectId: pid, assigneeId: "ana", dueDate: "2020-01-01" });
  const t2 = await call("jefe", "POST", "/tasks", { title: "Suelta", assigneeId: "ana" });
  const t3 = await call("jefe", "POST", "/tasks", { title: "De Beto", assigneeId: "beto" });
  check("tarea con proyecto", t1.status === 201 && t1.data.projectTitle === "Lanzamiento", t1);
  check("tarea suelta", t2.status === 201 && t2.data.projectId === null, t2);
  const bad = await call("jefe", "POST", "/tasks", { title: "Fantasma", assigneeId: "nadie" });
  check("no asigna a inexistentes", bad.status === 400, bad);

  // Aislamiento entre personas
  const mine = await call("ana", "GET", "/me");
  check("cada persona ve solo lo suyo", mine.data.tasks.length === 2, mine.data.tasks.length);
  check("cuenta vencidas", mine.data.stats.overdue === 1, mine.data.stats);
  const other = await call("ana", "GET", `/tasks/${t3.data.taskId}`);
  check("no ve tareas ajenas", other.status === 404, other);
  const list = await call("ana", "GET", "/tasks?assigneeId=beto");
  check("el filtro no abre lo ajeno", list.data.every((t: any) => t.assigneeId === "ana"), list.data);
  const people = await call("ana", "GET", "/people");
  check("personas es solo para admin", people.status === 403, people);

  // Limites del empleado
  const tid = t1.data.taskId;
  const rename = await call("ana", "PATCH", `/tasks/${tid}`, { title: "Cambiado" });
  check("empleado no edita el contenido", rename.status === 403, rename);
  const reassign = await call("ana", "PATCH", `/tasks/${tid}`, { assigneeId: "beto" });
  check("empleado no reasigna", reassign.status === 403, reassign);
  const force = await call("ana", "PATCH", `/tasks/${tid}`, { status: "done" });
  check("nadie la cierra sin evaluar", force.status === 400, force);
  const moving = await call("ana", "PATCH", `/tasks/${tid}`, { status: "in_progress" });
  check("empleado cambia el estado", moving.status === 200 && moving.data.status === "in_progress", moving);
  const foreign = await call("beto", "POST", `/tasks/${tid}/resolve`, { note: "mía" });
  check("no resuelve tareas ajenas", foreign.status === 403, foreign);

  // Resolver → evaluar
  const before = await call("jefe", "GET", "/reviews/count");
  check("cola vacía", before.data.total === 0, before);
  const resolved = await call("ana", "POST", `/tasks/${tid}/resolve`, { note: "Listo" });
  check("resuelta pasa a evaluación", resolved.data.status === "in_review", resolved);
  const count = await call("jefe", "GET", "/reviews/count");
  check("le aparece al evaluador", count.data.total === 1, count);
  const hidden = await call("ana", "GET", "/reviews/count");
  check("el empleado no ve la cola", hidden.data.total === 0, hidden);
  const self = await call("ana", "POST", `/tasks/${tid}/review`, { approved: true, score: 5 });
  check("no se autoevalúa", self.status === 403, self);
  const noComment = await call("jefe", "POST", `/tasks/${tid}/review`, { approved: false });
  check("devolver exige comentario", noComment.status === 400, noComment);
  const back = await call("jefe", "POST", `/tasks/${tid}/review`, { approved: false, comment: "Falta Y" });
  check("devuelta vuelve a la persona", back.data.status === "in_progress" && back.data.resolvedAt === null, back);
  await call("ana", "POST", `/tasks/${tid}/resolve`, { note: "Ahora sí" });
  const noScore = await call("jefe", "POST", `/tasks/${tid}/review`, { approved: true });
  check("aprobar exige puntaje", noScore.status === 400, noScore);
  const done = await call("jefe", "POST", `/tasks/${tid}/review`, { approved: true, score: 4, comment: "Bien" });
  check("aprobada queda hecha", done.data.status === "done" && done.data.reviewScore === 4, done);
  const again = await call("jefe", "POST", `/tasks/${tid}/review`, { approved: true, score: 5 });
  check("no se evalúa dos veces", again.status === 409, again);

  // Medicion
  const p = await call("jefe", "GET", `/projects/${pid}`);
  check("avance del proyecto", p.data.progress === 1 && p.data.tasks.length === 1, p.data);
  const team = await call("jefe", "GET", "/people");
  const ana = team.data.find((x: any) => x.userId === "ana");
  check("métricas por persona", ana.stats.done === 1 && ana.stats.avgScore === 4 && ana.stats.open === 1, ana);
  check("nunca expone contraseñas", !JSON.stringify(team.data).includes("passwordHash"));

  // Borrar un proyecto no pierde tareas
  await call("jefe", "DELETE", `/projects/${pid}`);
  const orphan = await call("jefe", "GET", `/tasks/${tid}`);
  check("sus tareas quedan sueltas", orphan.status === 200 && orphan.data.projectId === null, orphan);

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(failures ? `\n${failures} FALLARON` : "\nTODO OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
