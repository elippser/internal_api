/**
 * Continuidad conversacional: historial de sesión <-> estado del grafo (§6.4, §16.3).
 *
 * El invariante que gobierna el archivo es §35.10: el historial que se reenvía
 * al proveedor SIEMPRE tiene que ser válido. Las dos formas de romperlo son
 * sutiles y las dos producen un 400 que no menciona la causa:
 *
 *   1. Un `tool_result` sin su `tool_use` (o al revés). Pasa si se recorta el
 *      historial por la mitad de un turno con herramientas.
 *   2. Un mensaje `assistant` como primer elemento.
 *
 * Por eso el historial se reconstruye desde BLOQUES persistidos y no desde el
 * texto plano: guardar sólo el texto pierde los pares y obliga a inventarlos.
 */
import { newId } from "../core/ids";
import { createLogger } from "../core/logger";
import {
  EngineSession,
  EngineSessionMessage,
  type SessionOrigin,
} from "../models/session.model";
import type { GraphMessage } from "../graph/types";

const log = createLogger("engine:session");

/** Cuántos turnos se reenvían. La escalera de compactación afina desde acá. */
const DEFAULT_HISTORY_TURNS = 20;

export interface EnsureSessionInput {
  sessionId?: string | null;
  agentId: string;
  tenantId: string | null;
  userId?: string | null;
  externalKey?: string | null;
  origin?: SessionOrigin;
  firstMessage?: string | null;
}

/**
 * Obtiene o crea la sesión. Es lo que hace que no exista endpoint de creación:
 * la carrera entre "creá la sesión" y "mandá el mensaje" desaparece porque son
 * la misma operación.
 */
export async function ensureSession(input: EnsureSessionInput): Promise<string | null> {
  if (!input.sessionId && !input.externalKey) return null;

  if (input.sessionId) {
    const existing = await EngineSession.findOne({ sessionId: input.sessionId }).lean();
    if (existing) return existing.sessionId;
  }

  if (input.externalKey) {
    const byKey = await EngineSession.findOne({
      agentId: input.agentId,
      externalKey: input.externalKey,
    }).lean();
    if (byKey) return byKey.sessionId;
  }

  const sessionId = input.sessionId ?? newId("sess");
  try {
    await EngineSession.create({
      sessionId,
      agentId: input.agentId,
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      externalKey: input.externalKey ?? null,
      origin: input.origin ?? "api",
      // El título sale del primer mensaje: una lista de conversaciones sin
      // títulos es una lista de ids.
      title: input.firstMessage?.trim().slice(0, 80) || null,
      status: "active",
    });
  } catch (err) {
    // Carrera: dos turnos del mismo hilo llegaron juntos y el índice único
    // cortó al segundo. La sesión existe, que es lo que importa.
    if ((err as { code?: number })?.code !== 11000) throw err;
  }
  return sessionId;
}

/**
 * Reconstruye el historial en la forma que espera el proveedor.
 *
 * Reglas que se aplican SIEMPRE, en este orden:
 *   - se toman los últimos N turnos,
 *   - se descarta cualquier prefijo que empiece con un `tool_result` huérfano,
 *   - se garantiza que el primer mensaje sea `user`.
 */
export async function loadHistory(
  sessionId: string,
  turns = DEFAULT_HISTORY_TURNS,
): Promise<GraphMessage[]> {
  const docs = await EngineSessionMessage.find({
    sessionId,
    role: { $in: ["user", "assistant"] },
  })
    .sort({ createdAt: -1 })
    .limit(turns * 2)
    .lean();

  const ordered = docs.reverse();

  const messages: GraphMessage[] = ordered.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    // Los bloques ganan sobre el texto: conservan los pares tool_use /
    // tool_result que el proveedor exige emparejados.
    content: m.blocks ?? m.content,
  }));

  return sanitizeHistory(messages);
}

/**
 * Deja el historial en un estado que el proveedor acepta. Exportada porque la
 * escalera de compactación tiene que poder llamarla después de podar.
 */
export function sanitizeHistory(messages: GraphMessage[]): GraphMessage[] {
  let start = 0;

  while (start < messages.length) {
    const m = messages[start];
    const hasOrphanResult =
      m.role === "user" &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some((b) => b?.type === "tool_result");

    if (hasOrphanResult || m.role !== "user") {
      start += 1;
      continue;
    }
    break;
  }

  const kept = messages.slice(start);

  // Un `assistant` colgando al final tampoco sirve: el turno nuevo va a
  // agregar un `user` y quedarían dos seguidos del mismo rol en el medio.
  while (kept.length > 0 && kept[kept.length - 1].role === "assistant") {
    const last = kept[kept.length - 1];
    const hasToolUse =
      Array.isArray(last.content) &&
      (last.content as Array<{ type?: string }>).some((b) => b?.type === "tool_use");
    // Un assistant con tool_use pendiente de resultado NO puede quedar último.
    if (!hasToolUse) break;
    kept.pop();
  }

  return kept;
}

/** Persiste el turno del usuario ANTES de correr (§10.3, fase 3). */
export async function recordUserMessage(
  sessionId: string,
  agentId: string,
  tenantId: string | null,
  content: string,
  executionId: string,
): Promise<void> {
  await EngineSessionMessage.create({
    messageId: newId("msg"),
    sessionId,
    agentId,
    tenantId,
    role: "user",
    content,
    executionId,
  });
  await EngineSession.updateOne(
    { sessionId },
    {
      $inc: { messageCount: 1 },
      $set: { lastActivityAt: new Date(), activeExecutionId: executionId, status: "active" },
    },
  );
}

/** Persiste la respuesta del asistente con sus bloques crudos. */
export async function recordAssistantMessage(
  sessionId: string,
  agentId: string,
  tenantId: string | null,
  content: string,
  blocks: unknown,
  executionId: string,
  usage: { tokensInput: number; tokensOutput: number; costUsd: number },
): Promise<void> {
  await EngineSessionMessage.create({
    messageId: newId("msg"),
    sessionId,
    agentId,
    tenantId,
    role: "assistant",
    content,
    blocks,
    executionId,
  });
  await EngineSession.updateOne(
    { sessionId },
    {
      $inc: {
        messageCount: 1,
        totalTokensInput: usage.tokensInput,
        totalTokensOutput: usage.tokensOutput,
        totalCostUsd: usage.costUsd,
      },
      $set: { lastActivityAt: new Date(), activeExecutionId: null },
    },
  );
  log.debug("turno del asistente persistido", { sessionId, executionId });
}
