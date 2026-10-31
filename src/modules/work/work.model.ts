import { Schema, model } from "mongoose";

export const PROJECT_STATUSES = ["planned", "active", "paused", "done", "canceled"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "in_review", "done", "canceled"] as const;
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

const eventSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true },
    type: { type: String, required: true },
    note: { type: String, default: "" },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    projectId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    summary: { type: String, default: "" },
    details: { type: String, default: "" },
    status: { type: String, enum: PROJECT_STATUSES, default: "planned", index: true },
    ownerId: { type: String, default: null, index: true },
    startDate: { type: String, default: null },
    targetDate: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "work_projects" },
);

const taskSchema = new Schema(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    // Sin proyecto es una tarea suelta.
    projectId: { type: String, default: null, index: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, default: "" },
    status: { type: String, enum: TASK_STATUSES, default: "todo", index: true },
    priority: { type: String, enum: TASK_PRIORITIES, default: "medium" },
    assigneeId: { type: String, default: null, index: true },
    dueDate: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: "" },
    reviewScore: { type: Number, default: null },
    reviewComment: { type: String, default: "" },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    events: { type: [eventSchema], default: [] },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: "work_tasks" },
);

export const WorkProject = model("WorkProject", projectSchema);
export const WorkTask = model("WorkTask", taskSchema);
