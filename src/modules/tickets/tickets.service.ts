import { v4 as uuidv4 } from "uuid";
import { FeedbackRequest, sanitizeFeedback } from "../feedback/feedback.model";
import { getEmbedder } from "../../shared/rag/embedder";
import {
  ImprovementTicket,
  sanitizeTicket,
  type TicketEffort,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "./tickets.model";

interface ListInput {
  status?: string;
  priority?: string;
  type?: string;
  assignedTo?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  limit: number;
}

interface CreateInput {
  title: string;
  description?: string;
  type: TicketType;
  priority?: TicketPriority;
  linkedFeedbackIds?: string[];
  assignedTo?: string;
  estimatedEffort?: TicketEffort;
  internalNotes?: string;
  createdByAgent?: boolean;
  cronRunId?: string;
}

interface UpdateInput {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assignedTo?: string | null;
  estimatedEffort?: TicketEffort | null;
  internalNotes?: string;
  duplicateOfTicketId?: string | null;
}

const CATEGORY_WEIGHT: Record<string, number> = {
  payment: 10,
  integration: 9,
  bug: 8,
  feature: 5,
  reporting: 4,
  ui_ux: 3,
  other: 1,
};

const CONFIDENCE_NUM: Record<string, number> = {
  high: 1,
  medium: 0.66,
  low: 0.33,
};

export interface PriorityImpactInput {
  feedbackIds: string[];
}

export const ticketsService = {
  async list(opts: ListInput) {
    const filter: Record<string, unknown> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.priority) filter.priority = opts.priority;
    if (opts.type) filter.type = opts.type;
    if (opts.assignedTo) filter.assignedTo = opts.assignedTo;
    if (opts.dateFrom || opts.dateTo) {
      const range: Record<string, Date> = {};
      if (opts.dateFrom) range.$gte = new Date(opts.dateFrom);
      if (opts.dateTo) range.$lte = new Date(opts.dateTo);
      filter.createdAt = range;
    }

    const skip = (opts.page - 1) * opts.limit;
    const [docs, total] = await Promise.all([
      ImprovementTicket.find(filter)
        .sort({ priorityScore: -1, createdAt: -1 })
        .skip(skip)
        .limit(opts.limit),
      ImprovementTicket.countDocuments(filter),
    ]);

    return {
      data: docs.map(sanitizeTicket),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  },

  async getById(ticketId: string) {
    const doc = await ImprovementTicket.findOne({ ticketId });
    if (!doc) return null;
    const feedbacks = doc.linkedFeedbackIds?.length
      ? await FeedbackRequest.find({
          feedbackId: { $in: doc.linkedFeedbackIds },
        }).sort({ capturedAt: -1 })
      : [];
    return {
      ...sanitizeTicket(doc),
      feedbacks: feedbacks.map(sanitizeFeedback),
    };
  },

  async create(input: CreateInput) {
    const ticketId = `ticket-${uuidv4()}`;
    const feedbacks = input.linkedFeedbackIds?.length
      ? await FeedbackRequest.find({
          feedbackId: { $in: input.linkedFeedbackIds },
        })
      : [];
    const impact = computeImpact(feedbacks);
    const score = computePriorityScore(feedbacks);
    const priority = input.priority ?? scoreToPriority(score);
    const embedding = await embedIdentity(
      `${input.title}\n${input.description ?? ""}`,
    );

    const doc = await ImprovementTicket.create({
      ticketId,
      title: input.title,
      description: input.description ?? "",
      type: input.type,
      priority,
      priorityScore: score,
      impact,
      linkedFeedbackIds: input.linkedFeedbackIds ?? [],
      assignedTo: input.assignedTo,
      estimatedEffort: input.estimatedEffort,
      internalNotes: input.internalNotes ?? "",
      createdByAgent: input.createdByAgent ?? false,
      cronRunId: input.cronRunId,
      embedding,
    });

    if (input.linkedFeedbackIds?.length) {
      await FeedbackRequest.updateMany(
        { feedbackId: { $in: input.linkedFeedbackIds } },
        {
          $set: {
            status: "linked_to_ticket",
            linkedTicketId: ticketId,
            reviewedAt: new Date(),
          },
        },
      );
    }

    return sanitizeTicket(doc);
  },

  async update(ticketId: string, input: UpdateInput) {
    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) set.description = input.description;
    if (input.status !== undefined) {
      set.status = input.status;
      if (
        input.status === "done" ||
        input.status === "wont_do" ||
        input.status === "duplicate"
      ) {
        set.resolvedAt = new Date();
      } else {
        set.resolvedAt = null;
      }
    }
    if (input.priority !== undefined) set.priority = input.priority;
    if (input.assignedTo !== undefined) set.assignedTo = input.assignedTo;
    if (input.estimatedEffort !== undefined) {
      set.estimatedEffort = input.estimatedEffort;
    }
    if (input.internalNotes !== undefined) {
      set.internalNotes = input.internalNotes;
    }
    if (input.duplicateOfTicketId !== undefined) {
      set.duplicateOfTicketId = input.duplicateOfTicketId;
    }

    // Si cambio title/description, re-embedear
    if (input.title !== undefined || input.description !== undefined) {
      const current = await ImprovementTicket.findOne({ ticketId });
      if (current) {
        const next = `${input.title ?? current.title}\n${
          input.description ?? current.description ?? ""
        }`;
        set.embedding = await embedIdentity(next);
      }
    }

    const doc = await ImprovementTicket.findOneAndUpdate(
      { ticketId },
      { $set: set },
      { new: true },
    );
    return doc ? sanitizeTicket(doc) : null;
  },

  async appendFeedbacks(ticketId: string, feedbackIds: string[]) {
    if (feedbackIds.length === 0) return null;
    const ticket = await ImprovementTicket.findOne({ ticketId });
    if (!ticket) return null;

    const merged = Array.from(
      new Set([...(ticket.linkedFeedbackIds ?? []), ...feedbackIds]),
    );
    const feedbacks = await FeedbackRequest.find({
      feedbackId: { $in: merged },
    });
    const impact = computeImpact(feedbacks);
    const score = computePriorityScore(feedbacks);
    const priority = scoreToPriority(score);

    const updated = await ImprovementTicket.findOneAndUpdate(
      { ticketId },
      {
        $set: {
          linkedFeedbackIds: merged,
          impact,
          priorityScore: score,
          priority,
        },
      },
      { new: true },
    );

    await FeedbackRequest.updateMany(
      { feedbackId: { $in: feedbackIds } },
      {
        $set: {
          status: "linked_to_ticket",
          linkedTicketId: ticketId,
          reviewedAt: new Date(),
        },
      },
    );

    return updated ? sanitizeTicket(updated) : null;
  },
};

// ─────────────────────────────────────────────────────────
// Helpers exportados para que el cron y el service compartan logica
// ─────────────────────────────────────────────────────────

export function computeImpact(feedbacks: Array<{
  companyId?: string | null;
  propertyId?: string | null;
}>) {
  const companies = new Set<string>();
  const properties = new Set<string>();
  for (const fb of feedbacks) {
    if (fb.companyId) companies.add(fb.companyId);
    if (fb.propertyId) properties.add(fb.propertyId);
  }
  return {
    requestCount: feedbacks.length,
    uniqueCompanies: companies.size,
    uniqueProperties: properties.size,
  };
}

export function computePriorityScore(feedbacks: Array<{
  classification?: { category?: string; confidence?: string };
  companyId?: string | null;
}>) {
  if (feedbacks.length === 0) return 0;

  // Normalizamos en 0-100 con weights del spec:
  // requestCount × 0.40, uniqueCompanies × 0.30, avgConfidence × 0.15,
  // categoryWeight × 0.15
  const impact = computeImpact(feedbacks as any);
  const requestNorm = Math.min(impact.requestCount / 20, 1) * 100;
  const companiesNorm = Math.min(impact.uniqueCompanies / 10, 1) * 100;

  const avgConfidence =
    feedbacks.reduce(
      (acc, f) =>
        acc + (CONFIDENCE_NUM[f.classification?.confidence ?? "medium"] ?? 0.66),
      0,
    ) / feedbacks.length;
  const confidenceNorm = avgConfidence * 100;

  // Toma la categoria del primer feedback como representativa del cluster
  const cat = feedbacks[0]?.classification?.category ?? "other";
  const catWeight = CATEGORY_WEIGHT[cat] ?? 1;
  const categoryNorm = (catWeight / 10) * 100;

  const score =
    requestNorm * 0.4 +
    companiesNorm * 0.3 +
    confidenceNorm * 0.15 +
    categoryNorm * 0.15;
  return Math.round(score);
}

export function scoreToPriority(score: number): TicketPriority {
  if (score >= 75) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

export function categoryToTicketType(category: string): TicketType {
  if (category === "bug") return "bug";
  if (category === "integration") return "integration";
  if (category === "feature") return "feature";
  return "improvement";
}

async function embedIdentity(text: string): Promise<number[]> {
  const e = getEmbedder();
  return e.embed(text);
}
