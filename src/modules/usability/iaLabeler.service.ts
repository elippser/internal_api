import Joi from "joi";
import { modelFor } from "../../shared/llm/provider";
import { callJson } from "../competitors/ciLlm";
import { ConversationMessage, ConversationSession } from "../conversations/conversations.model";
import {
  IA_INTENTS,
  IA_LABEL_VERSION,
  IA_RESOLVED,
  IA_TOPICS,
  IaMessageLabel,
} from "./iaLabels.model";
import { UsabilityJobState } from "./usability.model";

/**
 * Etiquetado nocturno de lo que le preguntan a Roombir IA (USABILIDAD-SPEC.md §6).
 *
 * 1. Señales gratis para TODOS los mensajes (idioma, largo, reformulacion,
 *    voto, herramientas con error).
 * 2. Lotes de 20 al modelo barato (deepseek-v4-flash via OpenRouter, mismo
 *    cliente que Competencia) con la pregunta, la respuesta, las herramientas
 *    del turno y lo que el usuario dijo despues: tema, intencion, si quedo
 *    resuelta, frustracion, pregunta normalizada y capacidad faltante.
 *
 * Tope por corrida: USD 1 y 2000 mensajes; lo que falta queda para la noche
 * siguiente. Un mensaje que el modelo no pudo etiquetar queda con sus señales
 * (`llm: false`) y se reintenta hasta 3 veces.
 */

const BATCH = 20;
const MAX_ATTEMPTS = 3;
const LOOKBACK_DAYS = 30;
const REPHRASE_MS = 2 * 60_000;

// ── Señales sin modelo ───────────────────────────────────────────────────────

/**
 * Palabras que DISTINGUEN cada idioma. Nada compartido con el español ("a",
 * "de", "que", "la", "para"): con esas, una pregunta en español contaba como
 * portugues o frances.
 */
const STOPWORDS: Record<string, string[]> = {
  es: ["el", "los", "las", "una", "como", "cuantas", "cuantos", "hay", "puedo", "tengo", "quiero", "mañana", "hoy", "por", "del", "con", "mi"],
  en: ["the", "is", "and", "to", "of", "how", "what", "my", "can", "for", "with", "are", "do", "i", "you"],
  pt: ["não", "você", "uma", "meu", "minha", "está", "são", "isso", "obrigado", "posso", "tenho", "quero", "amanhã", "hoje"],
  fr: ["les", "et", "est", "une", "pour", "avec", "comment", "mon", "je", "des", "ma", "vous", "aujourd", "demain"],
  de: ["der", "die", "das", "und", "ist", "ich", "wie", "mit", "für", "ein", "eine", "mein", "nicht", "heute"],
};

export function detectLang(text: string): string | null {
  const words = text.toLowerCase().match(/[a-záéíóúâêôãõçàèùäöüßñ]+/g) ?? [];
  if (words.length < 2) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, sw] of Object.entries(STOPWORDS)) {
    const score = words.filter((w) => sw.includes(w)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
}

/** Jaccard de palabras: ≥ 0,6 = esta preguntando lo mismo otra vez. */
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Ultima red de privacidad sobre la pregunta normalizada. */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[correo]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[telefono]")
    .replace(/\b[A-Z0-9]{2,}-?\d{3,}\b/g, "[codigo]")
    .replace(/\b\d{4,}\b/g, "[numero]")
    .slice(0, 200)
    .trim();
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM = `Clasificas mensajes que hoteleros le escriben al asistente de IA de un PMS hotelero (Roombir).
Para cada item recibis: "pregunta" (lo que escribio el usuario), "respuesta" (lo que contesto el asistente), "herramientas" (acciones que ejecuto y su resultado) y "despues" (lo proximo que escribio el usuario, si existe).
Devolve SOLO un JSON: {"items":[{"id":..., "topic":..., "intent":..., "resolved":..., "frustration":..., "question":..., "missingCapability":...}]}

- topic: uno de ${IA_TOPICS.join(", ")}.
- intent: consultar (pide un dato), accion (quiere que haga algo), aprender (como se hace algo), problema (algo no funciona o reclama), charla (saludo, agradecimiento).
- resolved: si (la respuesta resolvio), parcial, no (no resolvio, se equivoco, o el usuario repregunta/se queja despues), no-se-sabe.
- frustration: 0 (neutral), 1 (impaciencia, repeticion), 2 (enojo explicito).
- question: la pregunta reescrita en español, corta (max 12 palabras), GENERICA: sin nombres de personas ni hoteles, sin numeros de reserva, montos, fechas concretas, correos ni telefonos. Ej: "como cambio la tarifa de un fin de semana".
- missingCapability: si pidio algo que el sistema no puede hacer, describilo en max 10 palabras; si no, null.`;

const itemSchema = Joi.object({
  id: Joi.string().required(),
  topic: Joi.string().valid(...IA_TOPICS).required(),
  intent: Joi.string().valid(...IA_INTENTS).required(),
  resolved: Joi.string().valid(...IA_RESOLVED).required(),
  frustration: Joi.number().integer().min(0).max(2).required(),
  // null en charla ("gracias"): no hay pregunta que normalizar.
  question: Joi.string().allow(null, "").max(400).required(),
  missingCapability: Joi.string().allow(null, "").max(300),
}).unknown(true);

const cut = (s: string | undefined | null, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

interface Pending {
  messageId: string;
  sessionId: string;
  text: string;
  reply: string;
  tools: string;
  after: string;
  base: Record<string, unknown>;
}

export interface LabelRunResult {
  scanned: number;
  labeled: number;
  signalsOnly: number;
  costUsd: number;
  stoppedBy: "done" | "budget" | "max";
}

/**
 * Corre el etiquetado. `budgetUsd` y `maxMessages` acotan la corrida;
 * `llm: false` arma solo las señales (para tests o si no hay clave).
 */
export async function runIaLabeling(
  opts: { budgetUsd?: number; maxMessages?: number; llm?: boolean; now?: Date } = {},
): Promise<LabelRunResult> {
  const budget = opts.budgetUsd ?? 1;
  const max = opts.maxMessages ?? 2000;
  const useLlm = opts.llm ?? Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
  const since = new Date((opts.now ?? new Date()).getTime() - LOOKBACK_DAYS * 86_400_000);

  // Mensajes ya etiquetados por el modelo (o agotados): no se vuelven a mandar.
  const done = new Set(
    (
      await IaMessageLabel.find(
        { $or: [{ llm: true, labelVersion: IA_LABEL_VERSION }, { attempts: { $gte: MAX_ATTEMPTS } }] },
        { messageId: 1 },
      ).lean()
    ).map((d) => d.messageId),
  );

  const userMsgs = await ConversationMessage.find({ role: "user", createdAt: { $gte: since } }, { messageId: 1, sessionId: 1, content: 1, createdAt: 1 })
    .sort({ createdAt: 1 })
    .lean();
  const todo = userMsgs.filter((m) => !done.has(m.messageId) && (m.content ?? "").trim()).slice(0, max);
  const result: LabelRunResult = { scanned: todo.length, labeled: 0, signalsOnly: 0, costUsd: 0, stoppedBy: "done" };
  if (!todo.length) return finish(result);

  const sessionIds = [...new Set(todo.map((m) => m.sessionId))];
  const [sessions, thread] = await Promise.all([
    ConversationSession.find({ sessionId: { $in: sessionIds } }, { sessionId: 1, context: 1 }).lean(),
    ConversationMessage.find(
      { sessionId: { $in: sessionIds }, role: { $in: ["user", "assistant"] } },
      { messageId: 1, sessionId: 1, role: 1, content: 1, createdAt: 1, feedback: 1, "agentMeta.toolsExecuted": 1 },
    )
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const ctxBy = new Map(sessions.map((s) => [s.sessionId, s.context ?? {}]));
  const bySession = new Map<string, typeof thread>();
  for (const m of thread) {
    const l = bySession.get(m.sessionId) ?? [];
    l.push(m);
    bySession.set(m.sessionId, l);
  }

  const pending: Pending[] = [];
  for (const m of todo) {
    const list = bySession.get(m.sessionId) ?? [];
    const i = list.findIndex((x) => x.messageId === m.messageId);
    const reply = list.slice(i + 1).find((x) => x.role === "assistant");
    const nextUser = list.slice(i + 1).find((x) => x.role === "user");
    const prevUser = [...list.slice(0, Math.max(0, i))].reverse().find((x) => x.role === "user");
    const tools = ((reply as any)?.agentMeta?.toolsExecuted ?? []) as Array<{ toolName?: string; outcome?: string; errorMessage?: string }>;
    // Solo "error": cancelar o quedar esperando confirmacion no es una falla del sistema.
    const failed = (t: { outcome?: string; errorMessage?: string }) => t.outcome === "error" || Boolean(t.errorMessage);
    const toolErrors = tools.filter(failed).length;
    const at = new Date(m.createdAt as Date);
    const ctx = ctxBy.get(m.sessionId) as Record<string, any>;
    const text = m.content ?? "";
    const base = {
      messageId: m.messageId,
      sessionId: m.sessionId,
      companyId: ctx?.companyId ?? null,
      userId: ctx?.userId ?? null,
      channel: ctx?.channel ?? null,
      day: at.toISOString().slice(0, 10),
      hourUtc: at.getUTCHours(),
      dowUtc: at.getUTCDay(),
      lang: detectLang(text),
      length: text.length,
      rephrase: Boolean(
        prevUser &&
          at.getTime() - new Date(prevUser.createdAt as Date).getTime() <= REPHRASE_MS &&
          similarity(prevUser.content ?? "", text) >= 0.6,
      ),
      vote: ((reply as any)?.feedback?.rating as "up" | "down" | undefined) ?? null,
      toolCount: tools.length,
      toolErrors,
    };
    pending.push({
      messageId: m.messageId,
      sessionId: m.sessionId,
      text,
      reply: (reply as any)?.content ?? "",
      tools: tools.map((t) => `${t.toolName ?? "tool"}:${t.outcome ?? (failed(t) ? "error" : "ok")}`).join(", "),
      after: nextUser?.content ?? "",
      base,
    });
  }

  const model = modelFor("cheap");
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const labels = new Map<string, Record<string, any>>();
    if (useLlm) {
      if (result.costUsd >= budget) {
        result.stoppedBy = "budget";
        break;
      }
      // Hasta 2 pases: el segundo manda SOLO los items que el modelo salteo o
      // devolvio fuera de contrato (pasa con 1 de cada ~10).
      for (let attempt = 0; attempt < 2; attempt++) {
        const missing = batch.map((p, k) => ({ p, k })).filter(({ k }) => !labels.has(String(k)));
        if (!missing.length) break;
        const user = JSON.stringify({
          items: missing.map(({ p, k }) => ({
            id: String(k),
            pregunta: cut(p.text, 600),
            respuesta: cut(p.reply, 500),
            herramientas: p.tools || "ninguna",
            despues: cut(p.after, 200) || null,
          })),
        });
        try {
          const r = await callJson({ model, system: SYSTEM, user, maxTokens: 2500, timeoutMs: 90_000 });
          result.costUsd += r.usage.costUsd;
          const items = Array.isArray(r.json?.items) ? r.json.items : [];
          for (const it of items) {
            const { error, value } = itemSchema.validate(it);
            if (!error) labels.set(String(value.id), value);
          }
        } catch (err) {
          console.warn("[usability-ia] lote fallo:", err instanceof Error ? err.message : err);
        }
      }
    }
    const ops = batch.map((p, k) => {
      const l = labels.get(String(k));
      const set: Record<string, unknown> = { ...p.base, labelVersion: IA_LABEL_VERSION, labeledAt: new Date() };
      if (l) {
        Object.assign(set, {
          llm: true,
          model,
          topic: l.topic,
          intent: l.intent,
          resolved: l.resolved,
          frustration: l.frustration,
          question: l.question ? scrub(l.question) : null,
          missingCapability: l.missingCapability ? scrub(l.missingCapability) : null,
        });
        result.labeled++;
      } else {
        set.llm = false;
        result.signalsOnly++;
      }
      return {
        updateOne: {
          filter: { messageId: p.messageId },
          update: { $set: set, ...(l ? {} : { $inc: { attempts: useLlm ? 1 : 0 } }) },
          upsert: true,
        },
      };
    });
    await IaMessageLabel.bulkWrite(ops, { ordered: false });
    if (i + BATCH >= max) result.stoppedBy = "max";
  }
  result.costUsd = Math.round(result.costUsd * 1_000_000) / 1_000_000;
  return finish(result);
}

async function finish(result: LabelRunResult): Promise<LabelRunResult> {
  const month = new Date().toISOString().slice(0, 7);
  const prev = await UsabilityJobState.findOne({ jobId: "ia_labels" }).lean();
  const sameMonth = (prev as any)?.costMonth === month;
  await UsabilityJobState.updateOne(
    { jobId: "ia_labels" },
    {
      $set: {
        lastRunAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
        lastDurationMs: 0,
        lastResult: result,
        costMonth: month,
        monthCostUsd: Math.round(((sameMonth ? (prev as any).monthCostUsd ?? 0 : 0) + result.costUsd) * 1e6) / 1e6,
      },
    },
    { upsert: true, strict: false },
  );
  return result;
}
