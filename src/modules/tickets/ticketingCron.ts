import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { FeedbackRequest } from "../feedback/feedback.model";
import { cosineSimilarity, getEmbedder } from "../../shared/rag/embedder";
import {
  ImprovementTicket,
  type TicketType,
} from "./tickets.model";
import {
  categoryToTicketType,
  computeImpact,
  computePriorityScore,
  scoreToPriority,
} from "./tickets.service";

const INTERVAL_HOURS = Number(
  process.env.FEEDBACK_CRON_INTERVAL_HOURS ?? 6,
);
const MIN_REQUESTS = Number(process.env.FEEDBACK_CRON_MIN_REQUESTS ?? 3);
const CLUSTER_THRESHOLD = Number(
  process.env.TICKET_CLUSTER_THRESHOLD ??
    (process.env.OPENAI_API_KEY ? 0.85 : 0.5),
);
const DEDUP_THRESHOLD = Number(
  process.env.TICKET_DEDUP_THRESHOLD ??
    (process.env.OPENAI_API_KEY ? 0.8 : 0.45),
);
const DEFAULT_MODEL =
  process.env.DEFAULT_AGENT_MODEL ?? "claude-sonnet-4-6";

let started = false;
let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY no esta configurada");
  cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

export interface CronRunSummary {
  runId: string;
  startedAt: Date | string;
  finishedAt: string;
  newFeedbacks: number;
  clusters: number;
  ticketsCreated: number;
  ticketsAppended: number;
  skipped: boolean;
  skipReason?: string;
}

export function startTicketingCron() {
  if (started) return;
  started = true;
  if (INTERVAL_HOURS <= 0) {
    console.log("[tickets] cron disabled (interval=0)");
    return;
  }
  const expression = `0 */${INTERVAL_HOURS} * * *`;
  cron.schedule(expression, async () => {
    try {
      await runTicketingCron({ triggeredManually: false });
    } catch (err) {
      console.error("[tickets] cron run failed:", err);
    }
  });
  console.log(`[tickets] ticketingCron scheduled (${expression})`);
}

interface RunOpts {
  triggeredManually: boolean;
}

export async function runTicketingCron(
  opts: RunOpts,
): Promise<CronRunSummary> {
  const runId = `cronrun-${uuidv4()}`;
  const startedAt = new Date();

  const news = await FeedbackRequest.find({ status: "new" });
  if (news.length < MIN_REQUESTS && !opts.triggeredManually) {
    return finalize({
      runId,
      startedAt,
      newFeedbacks: news.length,
      clusters: 0,
      ticketsCreated: 0,
      ticketsAppended: 0,
      skipped: true,
      skipReason: `solo ${news.length} feedbacks new (< ${MIN_REQUESTS})`,
    });
  }

  if (news.length === 0) {
    return finalize({
      runId,
      startedAt,
      newFeedbacks: 0,
      clusters: 0,
      ticketsCreated: 0,
      ticketsAppended: 0,
      skipped: true,
      skipReason: "no hay feedbacks new",
    });
  }

  // 1) Embedear summaries
  const embedder = getEmbedder();
  const summaries = news.map((fb) => fb.classification?.summary ?? "");
  const vectors = await embedder.embedBatch(summaries);

  // 2) Clustering greedy: cada feedback va al primer cluster cuyo
  //    centroide tenga similitud > threshold. Si no hay match, abre cluster.
  interface Cluster {
    centroid: number[];
    members: number[]; // indices en `news`
  }
  const clusters: Cluster[] = [];
  for (let i = 0; i < news.length; i++) {
    const v = vectors[i];
    let placed = false;
    for (const c of clusters) {
      if (cosineSimilarity(v, c.centroid) >= CLUSTER_THRESHOLD) {
        c.members.push(i);
        // Actualizar centroide como promedio simple
        for (let d = 0; d < c.centroid.length; d++) {
          c.centroid[d] =
            (c.centroid[d] * (c.members.length - 1) + v[d]) /
            c.members.length;
        }
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ centroid: [...v], members: [i] });
  }

  // 3) Procesar cada cluster
  let ticketsCreated = 0;
  let ticketsAppended = 0;
  const openTickets = await ImprovementTicket.find({
    status: { $in: ["open", "in_progress"] },
  });

  for (const c of clusters) {
    // Clusters de 1 solo request: ticket solo si confidence === "high"
    if (c.members.length === 1) {
      const fb = news[c.members[0]];
      if (fb.classification?.confidence !== "high") continue;
    }

    const fbs = c.members.map((i) => news[i]);
    const summariesIn = fbs.map((fb) => fb.classification?.summary ?? "");
    const messagesIn = fbs.map((fb) => fb.rawUserMessage);

    // 3a) Sintesis con Claude
    let synthesized: { title: string; description: string; type: TicketType };
    try {
      synthesized = await synthesize(fbs[0].classification?.category ?? "other", summariesIn, messagesIn);
    } catch (err) {
      console.error("[tickets] synthesis failed for cluster:", err);
      // Fallback: usar el summary del primero como title y juntar los messages
      synthesized = {
        title: summariesIn[0]?.slice(0, 120) || "Pedido sin clasificar",
        description: messagesIn.map((m, i) => `- ${m} _(feedback ${i + 1})_`).join("\n"),
        type: categoryToTicketType(fbs[0].classification?.category ?? "other"),
      };
    }

    // 3b) Buscar ticket abierto similar (dedup) via embedding
    const clusterVec = c.centroid;
    let dupTicket: typeof openTickets[number] | null = null;
    let bestScore = 0;
    for (const t of openTickets) {
      if (!t.embedding || t.embedding.length === 0) continue;
      const score = cosineSimilarity(clusterVec, t.embedding);
      if (score > bestScore && score >= DEDUP_THRESHOLD) {
        bestScore = score;
        dupTicket = t;
      }
    }

    const feedbackIds = fbs.map((fb) => fb.feedbackId);

    if (dupTicket) {
      // Agregar al ticket existente
      const merged = Array.from(
        new Set([...(dupTicket.linkedFeedbackIds ?? []), ...feedbackIds]),
      );
      const allFbs = await FeedbackRequest.find({
        feedbackId: { $in: merged },
      });
      const impact = computeImpact(allFbs);
      const score = computePriorityScore(allFbs);
      await ImprovementTicket.updateOne(
        { ticketId: dupTicket.ticketId },
        {
          $set: {
            linkedFeedbackIds: merged,
            impact,
            priorityScore: score,
            priority: scoreToPriority(score),
          },
        },
      );
      ticketsAppended++;
    } else {
      // Crear ticket nuevo
      const impact = computeImpact(fbs);
      const score = computePriorityScore(fbs);
      const ticketId = `ticket-${uuidv4()}`;
      const embedding = await embedder.embed(
        `${synthesized.title}\n${synthesized.description}`,
      );
      await ImprovementTicket.create({
        ticketId,
        title: synthesized.title,
        description: synthesized.description,
        type: synthesized.type,
        priority: scoreToPriority(score),
        priorityScore: score,
        impact,
        linkedFeedbackIds: feedbackIds,
        status: "open",
        createdByAgent: true,
        cronRunId: runId,
        embedding,
      });
      ticketsCreated++;
    }

    // 4) Marcar feedbacks como linked
    await FeedbackRequest.updateMany(
      { feedbackId: { $in: feedbackIds } },
      {
        $set: {
          status: "linked_to_ticket",
          linkedTicketId: dupTicket?.ticketId ?? undefined,
          reviewedAt: new Date(),
        },
      },
    );
  }

  return finalize({
    runId,
    startedAt,
    newFeedbacks: news.length,
    clusters: clusters.length,
    ticketsCreated,
    ticketsAppended,
    skipped: false,
  });
}

async function synthesize(
  category: string,
  summaries: string[],
  messages: string[],
): Promise<{ title: string; description: string; type: TicketType }> {
  const client = getClient();
  const sysPrompt =
    "Sos un product manager. Te paso varios pedidos de usuarios sobre " +
    "una misma necesidad. Tu trabajo es sintetizarlos en UN ticket de " +
    "mejora claro, accionable y sin ambiguedades.\n\n" +
    "Respondes SIEMPRE con JSON estricto, sin texto adicional, con esta forma:\n" +
    `{"title": string (<= 120 chars), "description": string (markdown, ` +
    `incluye contexto, problema, solucion sugerida y casos de uso), ` +
    `"type": "feature"|"integration"|"bug"|"improvement"}`;

  const userBlock =
    `Categoria: ${category}\n\n` +
    `Resumenes:\n${summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    `Mensajes originales:\n${messages
      .map((m, i) => `${i + 1}. "${m}"`)
      .join("\n")}`;

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1500,
    system: sysPrompt,
    messages: [{ role: "user", content: userBlock }],
  });

  const text =
    (response.content as any[]).find((b) => b.type === "text")?.text ?? "";

  const parsed = parseJsonStrict(text);
  return {
    title: parsed.title ?? summaries[0] ?? "Pedido sin titulo",
    description: parsed.description ?? "",
    type: ((TICKET_TYPES_SET.has(parsed.type)
      ? parsed.type
      : categoryToTicketType(category)) as TicketType),
  };
}

const TICKET_TYPES_SET = new Set([
  "feature",
  "integration",
  "bug",
  "improvement",
]);

function parseJsonStrict(text: string): any {
  // Extraer el primer objeto JSON aunque venga envuelto en backticks
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

async function finalize(
  summary: Omit<CronRunSummary, "finishedAt">,
): Promise<CronRunSummary> {
  const finishedAt = new Date();
  const startedAt =
    summary.startedAt instanceof Date
      ? summary.startedAt.toISOString()
      : String(summary.startedAt);
  const log = {
    ...summary,
    startedAt,
    finishedAt: finishedAt.toISOString(),
  };
  console.log("[tickets] cron run:", JSON.stringify(log));
  return log;
}
