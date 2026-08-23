import { makeId } from "../../shared/utils/ids";
import { FeedbackRequest, sanitizeFeedback } from "./feedback.model";

interface ListInput {
  status?: string;
  category?: string;
  agentId?: string;
  companyId?: string;
  userConfirmed?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
  skip: number;
}

interface CreateInput {
  agentId: string;
  sessionId: string;
  companyId?: string | null;
  propertyId?: string | null;
  rawUserMessage: string;
  agentResponse?: string;
  classification?: {
    intent?: string;
    category?: string;
    confidence?: string;
    summary?: string;
  };
  userConfirmed?: boolean;
  capturedAt?: Date | string;
}

export const feedbackService = {
  async list(input: ListInput) {
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;
    if (input.category) filter["classification.category"] = input.category;
    if (input.agentId) filter.agentId = input.agentId;
    if (input.companyId) filter.companyId = input.companyId;
    if (typeof input.userConfirmed === "boolean") {
      filter.userConfirmed = input.userConfirmed;
    }
    if (input.dateFrom || input.dateTo) {
      const range: Record<string, Date> = {};
      if (input.dateFrom) range.$gte = new Date(input.dateFrom);
      if (input.dateTo) range.$lte = new Date(input.dateTo);
      filter.capturedAt = range;
    }

    const [docs, total] = await Promise.all([
      FeedbackRequest.find(filter)
        .sort({ capturedAt: -1 })
        .skip(input.skip)
        .limit(input.limit),
      FeedbackRequest.countDocuments(filter),
    ]);

    return {
      data: docs.map(sanitizeFeedback),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  async getById(feedbackId: string) {
    const doc = await FeedbackRequest.findOne({ feedbackId });
    return doc ? sanitizeFeedback(doc) : null;
  },

  async create(input: CreateInput) {
    const doc = await FeedbackRequest.create({
      feedbackId: makeId("fb"),
      agentId: input.agentId,
      sessionId: input.sessionId,
      companyId: input.companyId ?? null,
      propertyId: input.propertyId ?? null,
      rawUserMessage: input.rawUserMessage,
      agentResponse: input.agentResponse ?? "",
      classification: input.classification ?? {},
      userConfirmed: input.userConfirmed ?? false,
      status: "new",
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
    });
    return sanitizeFeedback(doc);
  },

  async updateStatus(
    feedbackId: string,
    input: { status: string; linkedTicketId?: string | null },
  ) {
    const update: Record<string, unknown> = { status: input.status };
    if (input.status === "reviewed" || input.status === "discarded") {
      update.reviewedAt = new Date();
    }
    if (input.linkedTicketId !== undefined) {
      update.linkedTicketId = input.linkedTicketId || null;
    }

    const doc = await FeedbackRequest.findOneAndUpdate(
      { feedbackId },
      { $set: update },
      { new: true },
    );
    return doc ? sanitizeFeedback(doc) : null;
  },
};
