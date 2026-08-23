import { makeId } from "../../shared/utils/ids";
import { Tool, sanitizeTool } from "./tools.model";
import { describeToolRequirement } from "../conversations/services/toolAccess";

// El requisito de acceso de cada tool (rol / capability / app del espacio) se
// deriva de la política de rutas del agente, no se edita: la consola lo muestra
// para que se vea qué usuario del PMS puede usar cada herramienta.
function withAccess(doc: any) {
  const t = sanitizeTool(doc);
  if (!t) return t;
  try {
    return { ...t, accessRequirement: describeToolRequirement(t) };
  } catch {
    return t;
  }
}

interface ListInput {
  category?: string;
  status?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const toolsService = {
  async list(input: ListInput) {
    const filter: Record<string, unknown> = {};
    if (input.category) filter.category = input.category;
    if (input.status) filter.status = input.status;
    if (input.search) {
      const re = new RegExp(escapeRegex(input.search), "i");
      filter.$or = [{ name: re }, { displayName: re }, { description: re }];
    }

    const [docs, total] = await Promise.all([
      Tool.find(filter)
        .sort({ name: 1 })
        .skip(input.skip)
        .limit(input.limit),
      Tool.countDocuments(filter),
    ]);

    return {
      data: docs.map(withAccess),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  async create(input: Record<string, unknown>) {
    const existsName = await Tool.findOne({ name: input.name });
    if (existsName) {
      const err = new Error("Ya existe una tool con ese name") as Error & {
        status?: number;
      };
      err.status = 409;
      throw err;
    }
    const doc = await Tool.create({
      ...input,
      toolId: makeId("tool"),
      status: input.status ?? "active",
    });
    return sanitizeTool(doc);
  },

  async getById(toolId: string) {
    const doc = await Tool.findOne({ toolId });
    return doc ? withAccess(doc) : null;
  },

  async update(toolId: string, input: Record<string, unknown>) {
    if (input.name) {
      const conflict = await Tool.findOne({
        name: input.name,
        toolId: { $ne: toolId },
      });
      if (conflict) {
        const err = new Error("Ya existe una tool con ese name") as Error & {
          status?: number;
        };
        err.status = 409;
        throw err;
      }
    }
    const doc = await Tool.findOneAndUpdate(
      { toolId },
      { $set: input },
      { new: true },
    );
    return doc ? sanitizeTool(doc) : null;
  },

  async updateStatus(toolId: string, status: "active" | "inactive") {
    const doc = await Tool.findOneAndUpdate(
      { toolId },
      { $set: { status } },
      { new: true },
    );
    return doc ? sanitizeTool(doc) : null;
  },
};
