/**
 * Catálogo de herramientas del motor (§12).
 *
 * CRUD sobre `engine_tools` (niveles 2 y 3 de la resolución). Dos reglas de
 * negocio se aplican acá y no en el modelo, porque ambas necesitan contexto que
 * el esquema de Mongo no tiene:
 *
 *   - Una herramienta GESTIONADA POR CAPACIDAD no se puede crear por catálogo.
 *     Si se pudiera, cualquiera con permiso de crear herramientas se otorgaría
 *     a sí mismo el conjunto de memoria sin activar la capacidad, que es
 *     exactamente lo que la compuerta existe para impedir (§35.11).
 *   - La fila se CONSTRUYE al guardar, no sólo al ejecutar. Una `http` sin URL
 *     o una `mcp` (todavía sin fábrica) devuelven 422 acá, con el campo exacto,
 *     en vez de romper el grafo de todo agente que la declare.
 */
import type { Request, Response } from "express";
import { ConflictError, NotFoundError, ValidationError } from "../../engine/core/errors";
import { newId } from "../../engine/core/ids";
import { currentScope } from "../../engine/core/scope";
import { EngineTool, sanitizeTool, type EngineToolDoc } from "../../engine/models/tool.model";
import { scopedFilter } from "../../engine/repositories/base.repository";
import { listAvailableTools } from "../../engine/tools/catalog";
import { rowToTool } from "../../engine/tools/factories";
import { isCapabilityManaged } from "../../engine/tools/registry";
import { ok, paginated, parsePagination } from "../../shared/utils/http";
import { createToolSchema, validate } from "./engine.validation";

export const engineToolsController = {
  /**
   * Catálogo UNIFICADO de lo que un agente puede declarar: registro de código,
   * catálogo del motor y las ~165 del PMS, agrupadas y buscables.
   *
   * Es la pregunta inversa a la que contesta el resolutor, y la que necesita
   * quien configura un agente. Sin este endpoint la única forma de declarar
   * herramientas era tipear nombres a ciegas.
   */
  async available(req: Request, res: Response) {
    const scope = currentScope();
    return ok(
      res,
      await listAvailableTools({
        tenantId: scope.tenantId,
        search: req.query.search as string | undefined,
      }),
    );
  },

  async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = { deletedAt: null };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const scoped = scopedFilter(filter);
    const [docs, total] = await Promise.all([
      EngineTool.find(scoped).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      EngineTool.countDocuments(scoped),
    ]);

    return paginated(res, docs.map((d) => sanitizeTool(d)), total, page, limit);
  },

  async getOne(req: Request, res: Response) {
    const doc = await EngineTool.findOne(
      scopedFilter({ toolId: req.params.id, deletedAt: null }),
    ).lean();
    if (!doc) throw new NotFoundError(`Herramienta no encontrada: ${req.params.id}`);
    return ok(res, sanitizeTool(doc));
  },

  async create(req: Request, res: Response) {
    const payload = await validate<Record<string, unknown>>(createToolSchema, req.body);
    const scope = currentScope();
    const name = String(payload.name);

    if (isCapabilityManaged(name)) {
      throw new ConflictError(
        `"${name}" está gestionada por una capacidad de runtime y no existe en el catálogo. ` +
          `Llega al agente activando la capacidad correspondiente, no creando una fila.`,
      );
    }

    const tenantId = scope.crossTenant
      ? ((payload.tenantId as string | null) ?? null)
      : scope.tenantId;

    const exists = await EngineTool.findOne({ tenantId, name, deletedAt: null }).lean();
    if (exists) {
      throw new ConflictError(`Ya existe una herramienta llamada "${name}" en este ámbito`);
    }

    const doc: Partial<EngineToolDoc> = {
      toolId: newId("tool"),
      name,
      displayName: String(payload.displayName ?? name),
      description: String(payload.description ?? ""),
      type: payload.type as EngineToolDoc["type"],
      scope: (payload.scope as EngineToolDoc["scope"]) ?? "tenant",
      tenantId,
      inputSchema: (payload.inputSchema as EngineToolDoc["inputSchema"]) ?? {
        type: "object",
        properties: {},
        required: [],
      },
      config: (payload.config as Record<string, unknown>) ?? {},
      permissions: {
        roleFloor: ((payload.permissions as Record<string, unknown>)?.roleFloor as string) ?? null,
        requiresConfirmation: Boolean(
          (payload.permissions as Record<string, unknown>)?.requiresConfirmation,
        ),
        isDestructive: Boolean((payload.permissions as Record<string, unknown>)?.isDestructive),
      },
      concurrency: (payload.concurrency as EngineToolDoc["concurrency"]) ?? null,
      status: "active",
      createdByUserId: req.internalUser!.userId,
    };

    // Se construye AHORA para que un error de configuración sea un 422 acá.
    rowToTool(doc as EngineToolDoc, tenantId ? "tenant" : "global");

    const created = await EngineTool.create(doc);
    return ok(res, sanitizeTool(created), 201);
  },

  async update(req: Request, res: Response) {
    const current = await EngineTool.findOne(
      scopedFilter({ toolId: req.params.id, deletedAt: null }),
    ).lean();
    if (!current) throw new NotFoundError(`Herramienta no encontrada: ${req.params.id}`);

    const patch: Record<string, unknown> = {};
    for (const key of ["displayName", "description", "config", "permissions", "concurrency", "status", "inputSchema"]) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError("No hay nada que actualizar");
    }

    // Se valida el resultado FUSIONADO, no el parche: un parche que sólo toca
    // `config` puede dejar la herramienta inconsistente con su tipo.
    rowToTool({ ...current, ...patch } as EngineToolDoc, current.tenantId ? "tenant" : "global");

    const updated = await EngineTool.findOneAndUpdate(
      { toolId: req.params.id },
      { $set: patch },
      { new: true },
    ).lean();
    return ok(res, sanitizeTool(updated));
  },

  /**
   * Borrado LÓGICO. Un borrado duro rompería la lectura de cualquier ejecución
   * histórica que la usó: el paso guarda el nombre, y sin la fila no hay forma
   * de saber qué hacía esa herramienta.
   */
  async remove(req: Request, res: Response) {
    const doc = await EngineTool.findOneAndUpdate(
      scopedFilter({ toolId: req.params.id, deletedAt: null }),
      { $set: { status: "disabled", deletedAt: new Date() } },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundError(`Herramienta no encontrada: ${req.params.id}`);
    return ok(res, sanitizeTool(doc));
  },
};
