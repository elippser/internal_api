import { makeId } from "../../shared/utils/ids";
import { InternalUser } from "../users/users.model";
import { WorkProject, WorkTask } from "./work.model";

export interface Viewer {
  userId: string;
  manager: boolean;
}

export class WorkError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, any>;

const OPEN = ["todo", "in_progress", "blocked"];
const today = () => new Date().toISOString().slice(0, 10);

async function namesFor(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  const users = unique.length
    ? await InternalUser.find({ userId: { $in: unique } }, "userId firstName lastName").lean()
    : [];
  return new Map(users.map((u) => [u.userId, `${u.firstName} ${u.lastName}`.trim()]));
}

async function decorateTasks(rows: Row[]) {
  const names = await namesFor(rows.flatMap((t) => [t.assigneeId, t.reviewedBy, ...(t.events ?? []).map((e: Row) => e.by)]));
  const projects = await WorkProject.find(
    { projectId: { $in: [...new Set(rows.map((t) => t.projectId).filter(Boolean))] } },
    "projectId title",
  ).lean();
  const titles = new Map(projects.map((p) => [p.projectId, p.title]));
  return rows.map(({ _id, __v, ...t }) => ({
    ...t,
    attachments: t.attachments ?? [],
    assigneeName: t.assigneeId ? (names.get(t.assigneeId) ?? null) : null,
    reviewedByName: t.reviewedBy ? (names.get(t.reviewedBy) ?? null) : null,
    projectTitle: t.projectId ? (titles.get(t.projectId) ?? null) : null,
    events: (t.events ?? []).map((e: Row) => ({ ...e, byName: names.get(e.by) ?? null })),
  }));
}

function stats(tasks: Row[]) {
  const reviewed = tasks.filter((t) => typeof t.reviewScore === "number" && t.status === "done");
  const done = tasks.filter((t) => t.status === "done");
  const withDue = done.filter((t) => t.dueDate && t.resolvedAt);
  const onTime = withDue.filter((t) => new Date(t.resolvedAt).toISOString().slice(0, 10) <= t.dueDate);
  return {
    total: tasks.filter((t) => t.status !== "canceled").length,
    open: tasks.filter((t) => OPEN.includes(t.status)).length,
    overdue: tasks.filter((t) => OPEN.includes(t.status) && t.dueDate && t.dueDate < today()).length,
    inReview: tasks.filter((t) => t.status === "in_review").length,
    done: done.length,
    avgScore: reviewed.length ? reviewed.reduce((s, t) => s + t.reviewScore, 0) / reviewed.length : null,
    onTimeRate: withDue.length ? onTime.length / withDue.length : null,
  };
}

async function findTask(id: string) {
  const task = await WorkTask.findOne({ taskId: id });
  if (!task) throw new WorkError(404, "Tarea no encontrada");
  return task;
}

async function assertAssignee(userId: unknown) {
  if (!userId) return;
  const user = await InternalUser.exists({ userId, status: "active" });
  if (!user) throw new WorkError(400, "La persona asignada no existe o está inactiva");
}

async function assertProject(projectId: unknown) {
  if (!projectId) return;
  if (!(await WorkProject.exists({ projectId }))) throw new WorkError(400, "El proyecto no existe");
}

export const workService = {
  async listTasks(viewer: Viewer, filters: Row) {
    const q: Row = {};
    if (!viewer.manager) q.assigneeId = viewer.userId;
    else if (filters.assigneeId === "none") q.assigneeId = null;
    else if (filters.assigneeId) q.assigneeId = filters.assigneeId;
    if (filters.status) q.status = filters.status;
    if (filters.projectId === "none") q.projectId = null;
    else if (filters.projectId) q.projectId = filters.projectId;
    const rows = await WorkTask.find(q).sort({ updatedAt: -1 }).limit(500).lean();
    return decorateTasks(rows);
  },

  async getTask(viewer: Viewer, id: string) {
    const row = await WorkTask.findOne({ taskId: id }).lean();
    if (!row || (!viewer.manager && row.assigneeId !== viewer.userId)) throw new WorkError(404, "Tarea no encontrada");
    return (await decorateTasks([row]))[0];
  },

  async createTask(viewer: Viewer, input: Row) {
    await assertAssignee(input.assigneeId);
    await assertProject(input.projectId);
    const task = await WorkTask.create({
      ...input,
      taskId: makeId("work-task"),
      createdBy: viewer.userId,
      events: [{ at: new Date(), by: viewer.userId, type: "created" }],
    });
    return this.getTask(viewer, task.taskId);
  },

  async updateTask(viewer: Viewer, id: string, input: Row) {
    const task = await findTask(id);
    if (!viewer.manager) {
      if (task.assigneeId !== viewer.userId) throw new WorkError(404, "Tarea no encontrada");
      const keys = Object.keys(input);
      if (keys.some((k) => k !== "status") || !OPEN.includes(input.status)) {
        throw new WorkError(403, "Solo podés cambiar el estado de tus tareas");
      }
      if (!OPEN.includes(task.status)) throw new WorkError(409, "Esta tarea ya no se puede cambiar");
    }
    await assertAssignee(input.assigneeId);
    await assertProject(input.projectId);
    const previous = task.status;
    task.set(input);
    if (input.status && input.status !== previous) {
      task.events.push({ at: new Date(), by: viewer.userId, type: `status:${input.status}` });
    }
    if (input.assigneeId !== undefined) task.events.push({ at: new Date(), by: viewer.userId, type: "assigned" });
    await task.save();
    return this.getTask(viewer, id);
  },

  async deleteTask(id: string) {
    const { deletedCount } = await WorkTask.deleteOne({ taskId: id });
    if (!deletedCount) throw new WorkError(404, "Tarea no encontrada");
  },

  async comment(viewer: Viewer, id: string, note: string) {
    const task = await findTask(id);
    if (!viewer.manager && task.assigneeId !== viewer.userId) throw new WorkError(404, "Tarea no encontrada");
    task.events.push({ at: new Date(), by: viewer.userId, type: "comment", note });
    await task.save();
    return this.getTask(viewer, id);
  },

  /** La persona asignada la da por resuelta: pasa a la cola de evaluacion. */
  async resolve(viewer: Viewer, id: string, note: string) {
    const task = await findTask(id);
    if (task.assigneeId !== viewer.userId) throw new WorkError(403, "Solo la persona asignada puede resolverla");
    if (!OPEN.includes(task.status)) throw new WorkError(409, "Esta tarea no está abierta");
    task.status = "in_review";
    task.resolvedAt = new Date();
    task.resolutionNote = note;
    task.events.push({ at: new Date(), by: viewer.userId, type: "resolved", note });
    await task.save();
    return this.getTask(viewer, id);
  },

  /** Aprobada queda hecha con su puntaje; devuelta vuelve a la persona con el comentario. */
  async review(viewer: Viewer, id: string, input: { approved: boolean; score?: number; comment?: string }) {
    const task = await findTask(id);
    if (task.status !== "in_review") throw new WorkError(409, "Esta tarea no está para evaluar");
    const comment = input.comment ?? "";
    task.reviewedBy = viewer.userId;
    task.reviewedAt = new Date();
    task.reviewComment = comment;
    if (input.approved) {
      task.status = "done";
      task.reviewScore = input.score ?? null;
    } else {
      task.status = "in_progress";
      task.reviewScore = null;
      task.resolvedAt = null;
    }
    task.events.push({ at: new Date(), by: viewer.userId, type: input.approved ? "approved" : "returned", note: comment });
    await task.save();
    return this.getTask(viewer, id);
  },

  async reviews() {
    const rows = await WorkTask.find({ status: "in_review" }).sort({ resolvedAt: 1 }).lean();
    return decorateTasks(rows);
  },

  async reviewCount(viewer: Viewer) {
    return viewer.manager ? WorkTask.countDocuments({ status: "in_review" }) : 0;
  },

  async listProjects(viewer: Viewer) {
    const q: Row = {};
    let mine: Row[] = [];
    if (!viewer.manager) {
      mine = await WorkTask.find({ assigneeId: viewer.userId, projectId: { $ne: null } }, "projectId").lean();
      q.$or = [{ ownerId: viewer.userId }, { projectId: { $in: mine.map((t) => t.projectId) } }];
    }
    const rows = await WorkProject.find(q).sort({ targetDate: 1, createdAt: 1 }).lean();
    const tasks = await WorkTask.find({ projectId: { $in: rows.map((p) => p.projectId) } }).lean();
    const names = await namesFor(rows.map((p) => p.ownerId));
    return rows.map(({ _id, __v, ...p }: Row): Row => {
      const s = stats(tasks.filter((t) => t.projectId === p.projectId));
      return {
        ...p,
        ownerName: p.ownerId ? (names.get(p.ownerId) ?? null) : null,
        stats: s,
        progress: s.total ? s.done / s.total : 0,
      };
    });
  },

  async getProject(viewer: Viewer, id: string) {
    const project = (await this.listProjects(viewer)).find((p) => p.projectId === id);
    if (!project) throw new WorkError(404, "Proyecto no encontrado");
    return { ...project, tasks: await this.listTasks(viewer, { projectId: id }) };
  },

  async createProject(viewer: Viewer, input: Row) {
    await assertAssignee(input.ownerId);
    const p = await WorkProject.create({ ...input, projectId: makeId("work-project"), createdBy: viewer.userId });
    return this.getProject(viewer, p.projectId);
  },

  async updateProject(viewer: Viewer, id: string, input: Row) {
    await assertAssignee(input.ownerId);
    const p = await WorkProject.findOneAndUpdate({ projectId: id }, { $set: input }, { new: true });
    if (!p) throw new WorkError(404, "Proyecto no encontrado");
    return this.getProject(viewer, id);
  },

  /** Sus tareas no se pierden: quedan sueltas. */
  async deleteProject(id: string) {
    const { deletedCount } = await WorkProject.deleteOne({ projectId: id });
    if (!deletedCount) throw new WorkError(404, "Proyecto no encontrado");
    await WorkTask.updateMany({ projectId: id }, { $set: { projectId: null } });
  },

  async me(viewer: Viewer) {
    const tasks = await this.listTasks({ ...viewer, manager: false }, {});
    const projects = await this.listProjects({ ...viewer, manager: false });
    return { stats: stats(tasks), tasks, projects };
  },

  async people() {
    const users = await InternalUser.find({ status: "active" }, "userId firstName lastName email role")
      .sort({ firstName: 1 })
      .lean();
    const tasks = await WorkTask.find({ assigneeId: { $in: users.map((u) => u.userId) } }).lean();
    return users.map((u) => ({
      userId: u.userId,
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      role: u.role,
      stats: stats(tasks.filter((t) => t.assigneeId === u.userId)),
    }));
  },
};
