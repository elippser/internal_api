/**
 * Servicio del módulo DEPRECADO `/agents`.
 *
 * Ya no lee de la colección `agents`: proyecta los agentes del MOTOR a la forma
 * vieja. Es la mitad de lectura de la deprecación — la de escritura la corta el
 * router con un 410.
 *
 * Que las lecturas viejas devuelvan datos del motor (y no de la colección
 * congelada) es lo que hace que la deprecación sea segura: un cliente que
 * todavía no migró ve los cambios que se hacen en la consola nueva, en vez de
 * una foto vieja que va divergiendo en silencio. La colección `agents` queda
 * como respaldo de la migración y nada la vuelve a leer en el camino caliente.
 *
 * Las funciones de escritura se eliminaron a propósito en vez de dejarlas
 * inertes: código muerto que "parece" que escribe es una trampa para el próximo
 * que lo lea.
 */
import { EngineAgent } from "../../engine/models/agent.model";
import { EngineAgentVersion } from "../../engine/models/agentVersion.model";
import { stripProvider } from "../../engine/llm/catalog";
import { resolveAgent } from "../conversations/services/agentResolver";

interface ListInput {
  status?: string;
  channel?: string;
  search?: string;
  page: number;
  limit: number;
  skip: number;
}

/** Proyecta un agente del motor a la forma que espera el cliente viejo. */
async function project(agentId: string): Promise<Record<string, unknown> | null> {
  const resolved = await resolveAgent(agentId);
  if (!resolved) return null;

  return {
    agentId: resolved.agentId,
    slug: resolved.slug,
    name: resolved.name,
    description: resolved.description,
    status: resolved.status,
    persona: resolved.persona,
    instructions: resolved.instructions,
    knowledgeBaseIds: resolved.knowledgeBaseIds,
    enabledToolIds: resolved.enabledToolIds,
    modelOverride: resolved.modelOverride,
    deployment: resolved.deployment,
    feedbackCapture: resolved.feedbackCapture,
    limits: resolved.limits,
    // Señales de la deprecación, para que un cliente viejo pueda detectarla sin
    // leer cabeceras.
    __deprecated: true,
    __source: resolved.__source,
    __engineVersionId: resolved.__versionId ?? null,
  };
}

export const agentsService = {
  async list(input: ListInput) {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (input.status) filter.status = input.status;
    if (input.search) {
      const re = new RegExp(input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: re }, { slug: re }, { description: re }];
    }

    const [docs, total] = await Promise.all([
      EngineAgent.find(filter)
        .sort({ updatedAt: -1 })
        .skip(input.skip)
        .limit(input.limit)
        .lean(),
      EngineAgent.countDocuments(filter),
    ]);

    const projected = (
      await Promise.all(docs.map((d) => project(d.agentId)))
    ).filter((a): a is Record<string, unknown> => a !== null);

    // El canal vive en `config.legacy.deployment` de la versión activa, así que
    // el filtro se aplica DESPUÉS de proyectar. Filtrar en la consulta exigiría
    // un `$lookup` a las versiones para un endpoint que está por borrarse.
    const data = input.channel
      ? projected.filter(
          (a) => (a.deployment as { channel?: string })?.channel === input.channel,
        )
      : projected;

    return { data, total, page: input.page, limit: input.limit };
  },

  async getById(agentId: string) {
    return project(agentId);
  },

  /** Runtime del PMS embebido: descriptor mínimo desde un slug. NO deprecado. */
  async resolveBySlug(slug: string) {
    const agent = await EngineAgent.findOne({ slug, deletedAt: null }).lean();
    if (!agent?.activeVersionId) {
      // Reserva a la resolución completa, que a su vez cae a la colección vieja
      // si el agente todavía no se migró.
      const resolved = await resolveAgent(slug);
      if (!resolved) return null;
      return {
        agentId: resolved.agentId,
        slug: resolved.slug,
        displayName: resolved.persona.displayName,
        tone: resolved.persona.tone,
        language: resolved.persona.language,
        status: resolved.status,
        channel: resolved.deployment.channel,
      };
    }

    const version = await EngineAgentVersion.findOne({
      versionId: agent.activeVersionId,
    })
      .select({ config: 1, modelName: 1 })
      .lean();

    const legacy = ((version?.config as Record<string, unknown>)?.legacy ?? {}) as {
      persona?: Record<string, string>;
      deployment?: Record<string, unknown>;
    };

    return {
      agentId: agent.agentId,
      slug: agent.slug,
      displayName: legacy.persona?.displayName ?? agent.name,
      tone: legacy.persona?.tone ?? "neutral",
      language: legacy.persona?.language ?? "es",
      status: agent.status,
      channel: String(legacy.deployment?.channel ?? "internal"),
      model: version?.modelName ? stripProvider(version.modelName) : null,
    };
  },
};
