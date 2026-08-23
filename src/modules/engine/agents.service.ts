/**
 * Servicio de agentes: identidad + versionado inmutable (§6.2, §35.1).
 *
 * La regla que gobierna el archivo entero: NADA actualiza una fila de
 * `engine_agent_versions`. "Editar la configuración de un agente" es
 * `createVersion`, y el puntero `activeVersionId` se mueve. Revertir es mover
 * el puntero hacia atrás. Comparar dos versiones es leer dos filas.
 *
 * El costo es una colección que sólo crece; el beneficio es que la pregunta
 * "¿con qué configuración corrió esto?" siempre tiene respuesta exacta, y que
 * un cambio malo se revierte con una escritura en vez de reconstruirse de
 * memoria.
 */
import { ConflictError, NotFoundError, ValidationError } from "../../engine/core/errors";
import { newId } from "../../engine/core/ids";
import { currentScope } from "../../engine/core/scope";
import {
  EngineAgent,
  EngineAgentShare,
  sanitizeAgent,
  type EngineAgentDoc,
} from "../../engine/models/agent.model";
import {
  EngineAgentVersion,
  sanitizeVersion,
  type EngineAgentVersionDoc,
} from "../../engine/models/agentVersion.model";
import { validateInterruptions } from "../../engine/graph/factory";
import { capabilitiesFor } from "../../engine/llm/catalog";
import { scopedFilter } from "../../engine/repositories/base.repository";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface ListAgentsInput {
  status?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}

export const engineAgentsService = {
  async list(input: ListAgentsInput) {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (input.status) filter.status = input.status;
    if (input.search) {
      const re = new RegExp(input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: re }, { slug: re }, { description: re }];
    }

    const scoped = scopedFilter(filter);
    const [docs, total] = await Promise.all([
      EngineAgent.find(scoped).sort({ updatedAt: -1 }).skip(input.skip).limit(input.limit).lean(),
      EngineAgent.countDocuments(scoped),
    ]);

    return {
      data: docs.map((d) => sanitizeAgent(d)),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  async getById(agentId: string) {
    const doc = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!doc) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    const [activeVersion, versionCount] = await Promise.all([
      doc.activeVersionId
        ? EngineAgentVersion.findOne({ versionId: doc.activeVersionId }).lean()
        : null,
      EngineAgentVersion.countDocuments({ agentId }),
    ]);

    return {
      ...sanitizeAgent(doc),
      activeVersion: activeVersion ? sanitizeVersion(activeVersion) : null,
      versionCount,
      // Las concesiones se calculan desde la tabla y se REDACTAN cuando el
      // lector no es el dueño: un receptor no debe enterarse con quién más se
      // compartió el agente (§6.2).
      ...(await sharesFor(doc)),
    };
  },

  async create(payload: Record<string, unknown>, createdByUserId: string) {
    const scope = currentScope();
    const name = String(payload.name);
    const slug = (payload.slug as string) || slugify(name) || `agent-${Date.now()}`;

    // El inquilino explícito sólo lo puede fijar un ámbito de sistema; el resto
    // hereda el suyo. Sin esta regla, un operador de un hotel podría crear
    // agentes dentro de otro.
    const tenantId = scope.crossTenant
      ? ((payload.tenantId as string | null) ?? null)
      : scope.tenantId;

    const exists = await EngineAgent.findOne({ tenantId, slug, deletedAt: null }).lean();
    if (exists) throw new ConflictError(`Ya existe un agente con el slug "${slug}" en este ámbito`);

    const doc = await EngineAgent.create({
      agentId: newId("agent"),
      slug,
      name,
      description: String(payload.description ?? ""),
      imageUrl: (payload.imageUrl as string) ?? null,
      activeVersionId: null,
      tenantId,
      organizationId: scope.organizationId,
      status: "draft",
      availableInCopilot: Boolean(payload.availableInCopilot),
      createdByUserId,
    });

    return sanitizeAgent(doc);
  },

  /**
   * Actualiza sólo los METADATOS de identidad. La configuración ejecutable no
   * se toca acá: para eso está `createVersion`. Separar las dos operaciones
   * es lo que impide que "le cambié el nombre" quede registrado como una
   * versión nueva y ensucie el historial.
   */
  async update(agentId: string, patch: Record<string, unknown>) {
    const doc = await EngineAgent.findOneAndUpdate(
      scopedFilter({ agentId, deletedAt: null }),
      { $set: patch },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundError(`Agente no encontrado: ${agentId}`);
    return sanitizeAgent(doc);
  },

  /**
   * Crea una versión INMUTABLE y la activa. El número se calcula como
   * `max + 1`; si dos guardados concurrentes calculan el mismo, el índice único
   * `(agentId, version)` corta al segundo y se reintenta una vez.
   */
  async createVersion(
    agentId: string,
    payload: Record<string, unknown>,
    createdByUserId: string,
    opts: { activate?: boolean } = {},
  ) {
    const agent = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!agent) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    // Validaciones que DEBEN correr al guardar y no al ejecutar.
    validateInterruptions(
      ((payload.config as { interruptions?: [] })?.interruptions ?? []) as never,
    );
    await assertSubAgentsOwned(payload, agent);
    warnOnModelMismatch(payload);

    const version = await createVersionDoc(agentId, payload, createdByUserId);

    if (opts.activate !== false) {
      await EngineAgent.updateOne(
        { agentId },
        {
          $set: {
            activeVersionId: version.versionId,
            // Un agente en borrador que recibe su primera versión pasa a activo:
            // dejarlo en borrador obligaría a dos llamadas para algo que el
            // usuario ya expresó al guardar.
            ...(agent.status === "draft" ? { status: "active" } : {}),
          },
        },
      );
    }

    return sanitizeVersion(version);
  },

  async listVersions(agentId: string, limit = 50) {
    const agent = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!agent) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    const docs = await EngineAgentVersion.find({ agentId })
      .sort({ version: -1 })
      .limit(limit)
      .lean();

    return docs.map((d) => ({
      ...sanitizeVersion(d),
      isActive: d.versionId === agent.activeVersionId,
    }));
  },

  async getVersion(agentId: string, versionId: string) {
    const doc = await EngineAgentVersion.findOne({ agentId, versionId }).lean();
    if (!doc) throw new NotFoundError(`Versión no encontrada: ${versionId}`);
    return sanitizeVersion(doc);
  },

  /** Reversión: mover el puntero. La versión vieja nunca se copió ni se tocó. */
  async activateVersion(agentId: string, versionId: string) {
    const agent = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!agent) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    const version = await EngineAgentVersion.findOne({ agentId, versionId }).lean();
    if (!version) throw new NotFoundError(`Versión no encontrada: ${versionId}`);

    await EngineAgent.updateOne({ agentId }, { $set: { activeVersionId: versionId } });
    return { agentId, activeVersionId: versionId, version: version.version };
  },

  /** Clona identidad + versión activa. El clon arranca en borrador. */
  async clone(agentId: string, name: string, createdByUserId: string) {
    const source = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!source) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    const clone = await this.create(
      { name, description: source.description, availableInCopilot: false },
      createdByUserId,
    );

    if (source.activeVersionId) {
      const version = await EngineAgentVersion.findOne({
        versionId: source.activeVersionId,
      }).lean();
      if (version) {
        const { versionId, agentId: _a, version: _v, createdAt: _c, ...config } = version as Record<
          string,
          unknown
        >;
        void versionId;
        void _a;
        void _v;
        void _c;
        await this.createVersion(
          String((clone as Record<string, unknown>).agentId),
          { ...config, changeNote: `Clonado de ${source.slug}` },
          createdByUserId,
        );
      }
    }

    return this.getById(String((clone as Record<string, unknown>).agentId));
  },

  /** Exporta identidad + versión activa, en forma portable entre despliegues. */
  async exportAgent(agentId: string) {
    const agent = await EngineAgent.findOne(scopedFilter({ agentId, deletedAt: null })).lean();
    if (!agent) throw new NotFoundError(`Agente no encontrado: ${agentId}`);

    const version = agent.activeVersionId
      ? await EngineAgentVersion.findOne({ versionId: agent.activeVersionId }).lean()
      : null;

    return {
      format: "engine-agent-export/1",
      agent: {
        name: agent.name,
        slug: agent.slug,
        description: agent.description,
        availableInCopilot: agent.availableInCopilot,
      },
      // Sin ids ni marcas de tiempo: son de este despliegue y no significan
      // nada en otro.
      version: version ? stripVersionIdentity(version) : null,
    };
  },

  /** Borrado lógico. La historia de ejecuciones no se toca: es histórica. */
  async archive(agentId: string) {
    const doc = await EngineAgent.findOneAndUpdate(
      scopedFilter({ agentId, deletedAt: null }),
      { $set: { status: "archived", deletedAt: new Date() } },
      { new: true },
    ).lean();
    if (!doc) throw new NotFoundError(`Agente no encontrado: ${agentId}`);
    return sanitizeAgent(doc);
  },
};

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

async function createVersionDoc(
  agentId: string,
  payload: Record<string, unknown>,
  createdByUserId: string,
): Promise<EngineAgentVersionDoc> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await EngineAgentVersion.findOne({ agentId })
      .sort({ version: -1 })
      .select({ version: 1 })
      .lean();
    const next = (last?.version ?? 0) + 1;

    try {
      const doc = await EngineAgentVersion.create({
        versionId: newId("ver"),
        agentId,
        version: next,
        graphType: payload.graphType ?? "react_loop",
        systemPrompt: payload.systemPrompt ?? "",
        tools: payload.tools ?? [],
        skills: payload.skills ?? [],
        subAgents: payload.subAgents ?? [],
        modelName: payload.modelName,
        modelParams: payload.modelParams ?? {},
        outputSchema: payload.outputSchema ?? null,
        contextSchema: payload.contextSchema ?? null,
        contextProviders: payload.contextProviders ?? [],
        credentials: payload.credentials ?? [],
        graphConfig: payload.graphConfig ?? {},
        config: payload.config ?? {},
        timeoutSeconds: payload.timeoutSeconds ?? 300,
        maxDurationSeconds: payload.maxDurationSeconds ?? 1800,
        maxRetries: payload.maxRetries ?? 0,
        changeNote: payload.changeNote ?? null,
        createdByUserId,
      });
      return doc.toObject() as EngineAgentVersionDoc;
    } catch (err) {
      // Carrera por el número de versión: el índice único hizo su trabajo.
      const duplicate = (err as { code?: number })?.code === 11000;
      if (!duplicate || attempt === 2) throw err;
    }
  }
  throw new ConflictError("No se pudo asignar un número de versión; probá de nuevo");
}

/**
 * VALIDACIÓN DE PROPIEDAD de los sub-agentes, al guardar (§14).
 *
 * Correrla acá y no sólo al construir el grafo es lo que convierte el error en
 * un 422 con el campo exacto, en vez de una corrida que muere en producción.
 */
async function assertSubAgentsOwned(
  payload: Record<string, unknown>,
  agent: EngineAgentDoc,
): Promise<void> {
  const refs = (payload.subAgents ?? []) as Array<{ name: string; agentId: string }>;
  if (refs.length === 0) return;

  const names = new Set<string>();
  for (const ref of refs) {
    if (names.has(ref.name)) {
      throw new ValidationError(
        `El sub-agente "${ref.name}" está declarado dos veces: el modelo no podría distinguirlos.`,
      );
    }
    names.add(ref.name);
  }

  const targets = await EngineAgent.find({
    agentId: { $in: refs.map((r) => r.agentId) },
    deletedAt: null,
  })
    .select({ agentId: 1, tenantId: 1, name: 1 })
    .lean();
  const byId = new Map(targets.map((t) => [t.agentId, t]));

  for (const ref of refs) {
    const target = byId.get(ref.agentId);
    if (!target) {
      throw new ValidationError(
        `El sub-agente "${ref.name}" apunta a un agente inexistente (${ref.agentId}).`,
      );
    }
    if (target.tenantId !== null && target.tenantId !== agent.tenantId) {
      throw new ValidationError(
        `El sub-agente "${ref.name}" pertenece a otro inquilino y no hay concesión para usarlo. ` +
          `El runtime lo EJECUTA: cablearlo sin permiso sería ejecución de código ajeno.`,
      );
    }
  }
}

/**
 * Advierte (no bloquea) cuando los parámetros de razonamiento no encajan con el
 * modelo elegido. No bloquea porque el traductor MIGRA en runtime: un agente
 * viejo con presupuesto fijo corriendo contra un modelo nuevo se promueve solo.
 * La advertencia existe para que el autor sepa que su perilla no se está
 * aplicando literalmente.
 */
function warnOnModelMismatch(payload: Record<string, unknown>): void {
  const model = String(payload.modelName ?? "");
  const params = (payload.modelParams ?? {}) as Record<string, unknown>;
  const caps = capabilitiesFor(model);

  if (params.thinkingBudgetTokens && !caps.thinkingModes.includes("budget")) {
    console.warn(
      `[engine:agents] "${model}" no acepta budget_tokens; el presupuesto declarado se promoverá ` +
        `a modo adaptativo en runtime.`,
    );
  }
  if (
    (params.temperature !== undefined || params.topP !== undefined) &&
    !caps.supportsSampling
  ) {
    console.warn(
      `[engine:agents] "${model}" rechaza los parámetros de muestreo; se descartarán en runtime.`,
    );
  }
}

async function sharesFor(agent: EngineAgentDoc): Promise<Record<string, unknown>> {
  const scope = currentScope();
  const isOwner = scope.crossTenant || agent.tenantId === scope.tenantId;
  if (!isOwner) return {};

  const shares = await EngineAgentShare.find({ agentId: agent.agentId })
    .select({ granteeTenantId: 1, granteeOrganizationId: 1 })
    .lean();

  return {
    sharedWithTenantIds: shares.map((s) => s.granteeTenantId).filter(Boolean),
    sharedWithOrganizationIds: shares.map((s) => s.granteeOrganizationId).filter(Boolean),
  };
}

function stripVersionIdentity(version: Record<string, unknown>): Record<string, unknown> {
  const {
    _id,
    __v,
    versionId,
    agentId,
    version: _n,
    createdAt,
    createdByUserId,
    ...rest
  } = version;
  void _id;
  void __v;
  void versionId;
  void agentId;
  void _n;
  void createdAt;
  void createdByUserId;
  return rest;
}
