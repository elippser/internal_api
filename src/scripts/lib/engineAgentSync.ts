/**
 * Publicación de configuración del agente de operaciones EN EL MOTOR.
 *
 * Por qué existe: `resolveAgent()` (conversations/services/agentResolver) lee
 * primero `engine_agents` + su versión activa y sólo cae a la colección `agents`
 * si el agente no está migrado. Desde que el agente de operaciones se migró, un
 * script que escribe en `agents` NO cambia nada de lo que corre: el chat sigue
 * leyendo la versión del motor. Ese fue exactamente el modo de falla que dejó al
 * agente sin las herramientas del RMS y sin la sección de revenue del prompt —
 * el código estaba escrito y sembrado en el lugar equivocado.
 *
 * Semántica: las versiones del motor son INMUTABLES (ver agentVersion.model).
 * "Editar" es crear la versión N+1 con la configuración nueva y mover el puntero
 * `activeVersionId`. Esta función respeta eso: nunca muta una versión existente.
 *
 * Idempotente: si el delta pedido no cambia nada respecto de la versión activa,
 * no crea una versión nueva. Correr el seed dos veces no llena el historial de
 * versiones idénticas.
 */
import { EngineAgent } from "../../engine/models/agent.model";
import { EngineAgentVersion } from "../../engine/models/agentVersion.model";
import { newId } from "../../engine/core/ids";

/** Slug del agente de operaciones (el que atiende el chat del PMS). */
export const OPS_AGENT_SLUG = "asistente-de-operaciones";

export interface PublishDelta {
  /** Lista COMPLETA de toolIds habilitados. Si falta, se conserva la actual. */
  tools?: string[];
  /** Nombres de habilidades declaradas. Si falta, se conserva la actual. */
  skills?: string[];
  /** System prompt. Si falta, se conserva el actual. */
  systemPrompt?: string;
  /**
   * Modelo SIN cualificar (ej. "claude-sonnet-4-6"). Se cualifica con
   * `anthropic/` si no trae proveedor. Si falta, se conserva el actual.
   */
  model?: string;
  changeNote: string;
  createdByUserId?: string;
}

export interface PublishResult {
  status: "published" | "unchanged" | "agent_not_found";
  agentId?: string;
  versionId?: string;
  version?: number;
  /** Campos que efectivamente cambiaron respecto de la versión activa. */
  changed?: string[];
}

function qualifyModel(raw: string): string {
  const bare = raw.trim();
  if (!bare) return bare;
  return bare.includes("/") ? bare : `anthropic/${bare}`;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Publica una versión nueva del agente de operaciones con el delta indicado.
 * Todo lo que el delta no menciona se hereda de la versión activa, de modo que
 * un script que sólo toca las tools no pisa el prompt que puso otro.
 */
export async function publishOpsAgentVersion(
  delta: PublishDelta,
  slug: string = OPS_AGENT_SLUG,
): Promise<PublishResult> {
  const agent = await EngineAgent.findOne({ slug, deletedAt: null }).lean();
  if (!agent) return { status: "agent_not_found" };

  const current = agent.activeVersionId
    ? await EngineAgentVersion.findOne({ versionId: agent.activeVersionId }).lean()
    : null;

  const nextTools = delta.tools ?? current?.tools ?? [];
  const nextSkills = delta.skills ?? current?.skills ?? [];
  const nextPrompt = delta.systemPrompt ?? current?.systemPrompt ?? "";
  const nextModel = delta.model
    ? qualifyModel(delta.model)
    : (current?.modelName ?? "anthropic/claude-sonnet-4-6");

  const changed: string[] = [];
  if (!sameList(nextTools, current?.tools ?? [])) changed.push("tools");
  if (!sameList(nextSkills, current?.skills ?? [])) changed.push("skills");
  if (nextPrompt !== (current?.systemPrompt ?? "")) changed.push("systemPrompt");
  if (nextModel !== (current?.modelName ?? "")) changed.push("modelName");

  if (current && changed.length === 0) {
    return {
      status: "unchanged",
      agentId: agent.agentId,
      versionId: current.versionId,
      version: current.version,
      changed: [],
    };
  }

  const last = await EngineAgentVersion.findOne({ agentId: agent.agentId })
    .sort({ version: -1 })
    .lean();
  const versionNumber = (last?.version ?? 0) + 1;
  const versionId = newId("ver");

  await EngineAgentVersion.create({
    versionId,
    agentId: agent.agentId,
    version: versionNumber,
    // Todo lo que no es parte del delta se copia de la versión activa: una
    // versión es una instantánea COMPLETA, no un parche.
    graphType: current?.graphType ?? "react_loop",
    systemPrompt: nextPrompt,
    tools: nextTools,
    skills: nextSkills,
    subAgents: current?.subAgents ?? [],
    modelName: nextModel,
    modelParams: current?.modelParams ?? { maxTokens: 4096 },
    outputSchema: current?.outputSchema ?? null,
    contextSchema: current?.contextSchema ?? null,
    contextProviders: current?.contextProviders ?? [],
    credentials: current?.credentials ?? [],
    graphConfig: current?.graphConfig ?? {},
    config: current?.config ?? {
      capabilities: { web_search: true, code_execution: true },
    },
    timeoutSeconds: current?.timeoutSeconds ?? 300,
    maxDurationSeconds: current?.maxDurationSeconds ?? 1800,
    maxRetries: current?.maxRetries ?? 0,
    changeNote: delta.changeNote,
    createdByUserId: delta.createdByUserId ?? "seed-script",
  });

  await EngineAgent.updateOne(
    { agentId: agent.agentId },
    { $set: { activeVersionId: versionId } },
  );

  return {
    status: "published",
    agentId: agent.agentId,
    versionId,
    version: versionNumber,
    changed,
  };
}

/** Log uniforme del resultado, para que los seeds no lo repitan. */
export function logPublishResult(result: PublishResult, label: string): void {
  if (result.status === "agent_not_found") {
    console.warn(
      `⚠ ${label}: el agente "${OPS_AGENT_SLUG}" no existe en el MOTOR. ` +
        `Corré: npm run migrate:agents -- --apply`,
    );
    return;
  }
  if (result.status === "unchanged") {
    console.log(
      `• ${label}: el motor ya estaba al día (versión ${result.version}); no se publicó una nueva`,
    );
    return;
  }
  console.log(
    `✓ ${label}: publicada la versión ${result.version} del motor (${result.versionId}) — cambió: ${result.changed?.join(", ")}`,
  );
}
