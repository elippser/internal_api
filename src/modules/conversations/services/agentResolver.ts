/**
 * Resolución de agentes para el runtime de conversaciones, leyendo del MOTOR.
 *
 * Es la pieza que deprecia de verdad la colección `agents`. Sin esto, el motor
 * sería la superficie de edición y `agents` seguiría siendo lo que el chat del
 * PMS lee: dos fuentes de verdad, y todo cambio hecho en la consola nueva
 * invisible para los usuarios reales. La deprecación tiene que cortar la
 * LECTURA, no sólo la escritura.
 *
 * Devuelve la forma que el runtime viejo ya sabe consumir (`persona`,
 * `instructions`, `enabledToolIds`, `limits`, …) reconstruida desde
 * `EngineAgent` + su versión activa. Eso permite deprecar el modelo viejo sin
 * reescribir `conversations.service`, `promptAssembler` ni `conversationRunner`
 * en el mismo cambio — que es exactamente la clase de reescritura simultánea
 * que rompe un chat en producción.
 *
 * Hay un camino de reserva a `AgentDefinition` para los agentes que todavía no
 * se migraron. Es deliberadamente ruidoso: avisa una vez por agente, para que
 * un agente sin migrar se note en los logs en vez de quedar funcionando en
 * silencio contra la colección vieja para siempre.
 */
import { AgentDefinition } from "../../agents/agents.model";
import { EngineAgent } from "../../../engine/models/agent.model";
import { EngineAgentVersion } from "../../../engine/models/agentVersion.model";
import { stripProvider } from "../../../engine/llm/catalog";

/** Forma legada que consume el runtime de conversaciones. */
export interface ResolvedLegacyAgent {
  agentId: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  persona: {
    displayName: string;
    tone: string;
    language: string;
    personality: string;
  };
  instructions: {
    systemPrompt: string;
    constraints: string[];
    examples: unknown[];
  };
  knowledgeBaseIds: string[];
  enabledToolIds: string[];
  /**
   * Habilidades declaradas en la versión (revelación progresiva, §19). Actúa
   * como selector: vacío = todas las del ámbito. La colección vieja no modela
   * habilidades, así que por ese camino siempre viene vacío.
   */
  skillNames: string[];
  modelOverride: string | null;
  deployment: {
    channel: string;
    allowedCompanyIds: string[];
    requiresAuth: boolean;
  };
  feedbackCapture: {
    enabled: boolean;
    autoClassify: boolean;
    confirmWithUser: boolean;
  };
  limits: {
    maxTurnsPerSession: number;
    maxTokensPerTurn: number;
    sessionTtlMinutes: number;
  };
  /** De dónde salió. Lo usa la telemetría y el aviso de agente sin migrar. */
  __source: "engine" | "legacy";
  /** Versión del motor que se resolvió, para trazar qué configuración corrió. */
  __versionId?: string;
}

const warnedLegacy = new Set<string>();

/**
 * Resuelve por `agentId` o por `slug`. Prueba primero el motor; si no está,
 * cae a la colección vieja y avisa.
 */
export async function resolveAgent(
  idOrSlug: string,
): Promise<ResolvedLegacyAgent | null> {
  const fromEngine = await resolveFromEngine(idOrSlug);
  if (fromEngine) return fromEngine;

  const legacy = await AgentDefinition.findOne({
    $or: [{ agentId: idOrSlug }, { slug: idOrSlug }],
  }).lean();
  if (!legacy) return null;

  if (!warnedLegacy.has(idOrSlug)) {
    warnedLegacy.add(idOrSlug);
    console.warn(
      `[conversations] el agente "${legacy.slug}" todavía no está migrado al motor y se está ` +
        `sirviendo desde la colección vieja (DEPRECADA). Corré: npm run migrate:agents -- --apply`,
    );
  }

  return {
    agentId: String(legacy.agentId),
    slug: String(legacy.slug),
    name: String(legacy.name),
    description: String(legacy.description ?? ""),
    status: String(legacy.status),
    persona: {
      displayName: legacy.persona?.displayName ?? legacy.name,
      tone: legacy.persona?.tone ?? "neutral",
      language: legacy.persona?.language ?? "es",
      personality: legacy.persona?.personality ?? "",
    },
    instructions: {
      systemPrompt: legacy.instructions?.systemPrompt ?? "",
      constraints: legacy.instructions?.constraints ?? [],
      examples: legacy.instructions?.examples ?? [],
    },
    knowledgeBaseIds: (legacy.knowledgeBaseIds ?? []).map(String),
    enabledToolIds: (legacy.enabledToolIds ?? []).map(String),
    // El modelo viejo no tiene habilidades. Vacío acá significaría "todas las del
    // ámbito", así que el runtime desactiva la revelación progresiva para los
    // agentes sin migrar (ver `skillsEnabled` en conversations.service).
    skillNames: [],
    modelOverride: legacy.modelOverride ?? null,
    deployment: {
      channel: legacy.deployment?.channel ?? "internal",
      allowedCompanyIds: (legacy.deployment?.allowedCompanyIds ?? []).map(String),
      requiresAuth: legacy.deployment?.requiresAuth ?? true,
    },
    feedbackCapture: {
      enabled: legacy.feedbackCapture?.enabled ?? false,
      autoClassify: legacy.feedbackCapture?.autoClassify ?? true,
      confirmWithUser: legacy.feedbackCapture?.confirmWithUser ?? true,
    },
    limits: {
      maxTurnsPerSession: legacy.limits?.maxTurnsPerSession ?? 50,
      maxTokensPerTurn: legacy.limits?.maxTokensPerTurn ?? 4096,
      sessionTtlMinutes: legacy.limits?.sessionTtlMinutes ?? 60,
    },
    __source: "legacy",
  };
}

async function resolveFromEngine(idOrSlug: string): Promise<ResolvedLegacyAgent | null> {
  const agent = await EngineAgent.findOne({
    // `legacyAgentId` es la rama que hace que las conversaciones PREEXISTENTES
    // sigan funcionando: sus sesiones guardan el id del módulo viejo, y sin
    // esta condición caerían a la colección congelada sin dar ningún error.
    $or: [{ agentId: idOrSlug }, { slug: idOrSlug }, { legacyAgentId: idOrSlug }],
    deletedAt: null,
  }).lean();
  if (!agent?.activeVersionId) return null;

  const version = await EngineAgentVersion.findOne({
    versionId: agent.activeVersionId,
  }).lean();
  if (!version) return null;

  // Los conceptos que el motor todavía no modela como campos propios viven en
  // `config.legacy`, puestos ahí por la migración.
  const legacy = ((version.config as Record<string, unknown>)?.legacy ?? {}) as {
    persona?: Record<string, string>;
    instructions?: { constraints?: string[]; examples?: unknown[] };
    knowledgeBaseIds?: string[];
    deployment?: Record<string, unknown>;
    feedbackCapture?: Record<string, boolean>;
    limits?: Record<string, number>;
  };

  return {
    agentId: agent.agentId,
    slug: agent.slug,
    name: agent.name,
    description: agent.description ?? "",
    status: agent.status,
    persona: {
      displayName: legacy.persona?.displayName ?? agent.name,
      tone: legacy.persona?.tone ?? "neutral",
      language: legacy.persona?.language ?? "es",
      personality: legacy.persona?.personality ?? "",
    },
    instructions: {
      // El prompt YA viene compuesto y versionado: la persona y las
      // restricciones se materializaron al migrar, así que no se vuelven a
      // concatenar acá. Hacerlo duplicaría la persona en el prompt.
      systemPrompt: version.systemPrompt ?? "",
      constraints: [],
      examples: legacy.instructions?.examples ?? [],
    },
    knowledgeBaseIds: (legacy.knowledgeBaseIds ?? []).map(String),
    enabledToolIds: (version.tools ?? []).map(String),
    skillNames: (version.skills ?? []).map(String),
    // El runtime viejo espera el id desnudo, sin prefijo de proveedor.
    modelOverride: version.modelName ? stripProvider(version.modelName) : null,
    deployment: {
      channel: String(legacy.deployment?.channel ?? "internal"),
      allowedCompanyIds: ((legacy.deployment?.allowedCompanyIds as string[]) ?? []).map(String),
      requiresAuth: legacy.deployment?.requiresAuth !== false,
    },
    feedbackCapture: {
      enabled: legacy.feedbackCapture?.enabled ?? false,
      autoClassify: legacy.feedbackCapture?.autoClassify ?? true,
      confirmWithUser: legacy.feedbackCapture?.confirmWithUser ?? true,
    },
    limits: {
      maxTurnsPerSession: legacy.limits?.maxTurnsPerSession ?? 50,
      maxTokensPerTurn:
        legacy.limits?.maxTokensPerTurn ??
        ((version.modelParams as { maxTokens?: number })?.maxTokens ?? 4096),
      sessionTtlMinutes: legacy.limits?.sessionTtlMinutes ?? 60,
    },
    __source: "engine",
    __versionId: version.versionId,
  };
}

/** Descriptor mínimo para que el PMS arranque una sesión desde un slug. */
export async function resolveAgentDescriptor(slug: string): Promise<{
  agentId: string;
  slug: string;
  displayName: string;
  tone: string;
  language: string;
  status: string;
  channel: string;
} | null> {
  const agent = await resolveAgent(slug);
  if (!agent) return null;
  return {
    agentId: agent.agentId,
    slug: agent.slug,
    displayName: agent.persona.displayName,
    tone: agent.persona.tone,
    language: agent.persona.language,
    status: agent.status,
    channel: agent.deployment.channel,
  };
}
