import { Router, type Request, type Response } from "express";
import Joi from "joi";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize, hasMinRole } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { PROJECT_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from "./work.model";
import { WorkError, workService, type Viewer } from "./work.service";

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null);
const text = (max: number) => Joi.string().allow("").max(max);

const projectFields = {
  summary: text(500),
  details: text(50_000),
  status: Joi.string().valid(...PROJECT_STATUSES),
  ownerId: Joi.string().allow(null),
  startDate: day,
  targetDate: day,
};
const taskFields = {
  projectId: Joi.string().allow(null),
  details: text(50_000),
  priority: Joi.string().valid(...TASK_PRIORITIES),
  assigneeId: Joi.string().allow(null),
  dueDate: day,
};

const schemas = {
  projectCreate: Joi.object({ title: Joi.string().min(2).max(200).required(), ...projectFields }),
  projectUpdate: Joi.object({ title: Joi.string().min(2).max(200), ...projectFields }).min(1),
  taskCreate: Joi.object({ title: Joi.string().min(2).max(200).required(), ...taskFields }),
  // En review o hecha solo se llega resolviendo y evaluando, nunca por edicion directa.
  taskUpdate: Joi.object({
    title: Joi.string().min(2).max(200),
    status: Joi.string().valid(...TASK_STATUSES.filter((s) => s !== "in_review" && s !== "done")),
    ...taskFields,
  }).min(1),
  taskList: Joi.object({
    status: Joi.string().valid(...TASK_STATUSES),
    assigneeId: Joi.string(),
    projectId: Joi.string(),
  }),
  note: Joi.object({ note: Joi.string().min(1).max(5_000).required() }),
  resolve: Joi.object({ note: text(5_000).default("") }),
  review: Joi.object({
    approved: Joi.boolean().required(),
    score: Joi.number().integer().min(1).max(5).when("approved", { is: true, then: Joi.required(), otherwise: Joi.forbidden() }),
    comment: text(5_000).when("approved", { is: false, then: Joi.string().min(1).required() }),
  }),
};

const viewer = (req: Request): Viewer => ({
  userId: req.internalUser!.userId,
  manager: hasMinRole(req.internalUser!.role, "admin"),
});

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof WorkError) return fail(res, err.status, err.message);
      console.error("[work]", err);
      return fail(res, 500, "Error interno");
    }
  };
}

function valid<T = any>(schema: Joi.Schema, value: unknown): T {
  const r = schema.validate(value);
  if (r.error) throw new WorkError(400, r.error.message);
  return r.value;
}

const manager = authorize("admin");

export const workRouter = Router();

// Piso `support`: quien solo ejecuta tareas entra con el rol mas bajo. Cada
// servicio recorta a lo propio; crear, asignar y evaluar es de admin para arriba.
workRouter.use(authenticate, authorize("support"));

workRouter.get("/me", handle(async (req, res) => ok(res, await workService.me(viewer(req)))));
workRouter.get("/people", manager, handle(async (_req, res) => ok(res, await workService.people())));

workRouter.get("/reviews/count", handle(async (req, res) => ok(res, { total: await workService.reviewCount(viewer(req)) })));
workRouter.get("/reviews", manager, handle(async (_req, res) => ok(res, await workService.reviews())));

workRouter.get("/projects", handle(async (req, res) => ok(res, await workService.listProjects(viewer(req)))));
workRouter.post("/projects", manager, handle(async (req, res) => ok(res, await workService.createProject(viewer(req), valid(schemas.projectCreate, req.body)), 201)));
workRouter.get("/projects/:id", handle(async (req, res) => ok(res, await workService.getProject(viewer(req), req.params.id))));
workRouter.patch("/projects/:id", manager, handle(async (req, res) => ok(res, await workService.updateProject(viewer(req), req.params.id, valid(schemas.projectUpdate, req.body)))));
workRouter.delete("/projects/:id", manager, handle(async (req, res) => {
  await workService.deleteProject(req.params.id);
  return ok(res, { ok: true });
}));

workRouter.get("/tasks", handle(async (req, res) => ok(res, await workService.listTasks(viewer(req), valid(schemas.taskList, req.query)))));
workRouter.post("/tasks", manager, handle(async (req, res) => ok(res, await workService.createTask(viewer(req), valid(schemas.taskCreate, req.body)), 201)));
workRouter.get("/tasks/:id", handle(async (req, res) => ok(res, await workService.getTask(viewer(req), req.params.id))));
workRouter.patch("/tasks/:id", handle(async (req, res) => ok(res, await workService.updateTask(viewer(req), req.params.id, valid(schemas.taskUpdate, req.body)))));
workRouter.delete("/tasks/:id", manager, handle(async (req, res) => {
  await workService.deleteTask(req.params.id);
  return ok(res, { ok: true });
}));
workRouter.post("/tasks/:id/comments", handle(async (req, res) => ok(res, await workService.comment(viewer(req), req.params.id, valid(schemas.note, req.body).note), 201)));
workRouter.post("/tasks/:id/resolve", handle(async (req, res) => ok(res, await workService.resolve(viewer(req), req.params.id, valid(schemas.resolve, req.body).note))));
workRouter.post("/tasks/:id/review", manager, handle(async (req, res) => ok(res, await workService.review(viewer(req), req.params.id, valid(schemas.review, req.body)))));
