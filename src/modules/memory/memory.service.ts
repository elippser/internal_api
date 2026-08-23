import Anthropic from "@anthropic-ai/sdk";
import { makeId } from "../../shared/utils/ids";
import { AgentMemory, sanitizeMemory, type MemoryKind } from "./memory.model";

// Modelo barato para destilar memoria (no necesita razonar mucho).
const MEMORY_MODEL =
  process.env.MEMORY_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_MEMORIES_IN_PROMPT = 25;

function distillEnabled(): boolean {
  return process.env.MEMORY_DISTILL_ENABLED !== "off";
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

interface Scope {
  operativeSpaceId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
  agentId?: string | null;
}

export const memoryService = {
  async list(operativeSpaceId: string) {
    const docs = await AgentMemory.find({ operativeSpaceId })
      .sort({ updatedAt: -1 })
      .limit(200);
    return docs.map(sanitizeMemory);
  },

  async add(
    scope: Scope,
    content: string,
    kind: MemoryKind = "context",
    sourceSessionId?: string | null,
    createdByUserId?: string | null,
  ) {
    const doc = await AgentMemory.create({
      memoryId: makeId("mem"),
      agentId: scope.agentId ?? null,
      companyId: scope.companyId ?? null,
      propertyId: scope.propertyId ?? null,
      operativeSpaceId: scope.operativeSpaceId ?? null,
      content: content.trim(),
      kind,
      sourceSessionId: sourceSessionId ?? null,
      createdByUserId: createdByUserId ?? null,
    });
    return sanitizeMemory(doc);
  },

  async remove(memoryId: string) {
    await AgentMemory.deleteOne({ memoryId });
  },

  // Limpia toda la memoria de un espacio operativo.
  async clear(operativeSpaceId: string) {
    const res = await AgentMemory.deleteMany({ operativeSpaceId });
    return res.deletedCount ?? 0;
  },

  // Texto para inyectar en el system prompt (las memorias mas recientes).
  async forPrompt(operativeSpaceId: string): Promise<string[]> {
    if (!operativeSpaceId) return [];
    const docs = await AgentMemory.find({ operativeSpaceId })
      .sort({ updatedAt: -1 })
      .limit(MAX_MEMORIES_IN_PROMPT)
      .select({ content: 1 });
    return docs.map((d) => d.content);
  },

  /**
   * Destila hechos durables de un intercambio (user + assistant) y los guarda.
   * Fire-and-forget: el caller NO debe await-earlo en el path del usuario.
   * Usa un modelo barato y solo guarda cuando hay algo claramente memorable
   * (preferencias, datos recurrentes del hotel/operacion), evitando duplicar
   * lo que ya esta en memoria.
   */
  async distillFromExchange(input: {
    scope: Scope;
    userMessage: string;
    assistantMessage: string;
    sourceSessionId?: string | null;
    createdByUserId?: string | null;
  }): Promise<void> {
    if (!distillEnabled()) return;
    if (!input.scope.operativeSpaceId) return;
    const client = getClient();
    if (!client) return;

    try {
      const existing = await this.forPrompt(input.scope.operativeSpaceId);
      const existingBlock = existing.length
        ? existing.map((m) => `- ${m}`).join("\n")
        : "(ninguna todavia)";

      const res = await client.messages.create({
        model: MEMORY_MODEL,
        max_tokens: 400,
        system:
          "Sos un extractor de memoria de largo plazo para un asistente de operaciones hoteleras. " +
          "Dado un intercambio (usuario + asistente), devolves SOLO hechos durables que valga la pena " +
          "recordar en futuras conversaciones del mismo equipo: preferencias del hotel, datos recurrentes " +
          "de la operacion, convenciones, nombres propios relevantes. NO guardes cosas efimeras (una consulta " +
          "puntual, un saludo, datos que cambian a diario como disponibilidad de hoy). NO dupliques lo que ya " +
          "esta en memoria. Responde SOLO con un JSON array de strings cortos (cada uno un hecho), o [] si no hay nada.",
        messages: [
          {
            role: "user",
            content:
              `Memoria actual:\n${existingBlock}\n\n` +
              `Intercambio:\nUsuario: ${input.userMessage}\nAsistente: ${input.assistantMessage}\n\n` +
              `Hechos durables nuevos (JSON array de strings):`,
          },
        ],
      });

      const text =
        (res.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === "text",
        )?.text ?? "[]";
      const facts = parseFacts(text);
      for (const fact of facts.slice(0, 5)) {
        if (fact.trim().length < 3) continue;
        await this.add(
          input.scope,
          fact,
          "context",
          input.sourceSessionId,
          input.createdByUserId,
        );
      }
    } catch (err) {
      console.warn("[memory] distill fallo:", (err as Error)?.message);
    }
  },
};

function parseFacts(text: string): string[] {
  // El modelo puede envolver el array en texto; extraemos el primer [ ... ].
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (Array.isArray(arr)) {
      return arr.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* ignore */
  }
  return [];
}
