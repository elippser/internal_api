import { makeId } from "../../shared/utils/ids";
import { CiDecision, sanitizeDoc, type DecisionType } from "./competitors.model";
import { CiError } from "./competitors.service";

/** Log de decisiones tomadas con esta herramienta (metrica de exito, spec §7 original). */

export interface CreateDecisionInput {
  type: DecisionType;
  title: string;
  description?: string | null;
  competitorIds?: string[];
  ticketId?: string | null;
  decidedAt?: Date | string;
}

export const decisionsService = {
  async list(limit = 200) {
    const [docs, total] = await Promise.all([
      CiDecision.find({}).sort({ decidedAt: -1 }).limit(limit).lean(),
      CiDecision.countDocuments({}),
    ]);
    return { data: docs.map((d) => sanitizeDoc(d)), total };
  },

  async create(input: CreateDecisionInput, userId: string | null) {
    const doc = await CiDecision.create({
      decisionId: makeId("cdec"),
      type: input.type,
      title: input.title.trim(),
      description: input.description ?? "",
      competitorIds: input.competitorIds ?? [],
      ticketId: input.ticketId || null,
      decidedAt: input.decidedAt ? new Date(input.decidedAt) : new Date(),
      byUserId: userId,
    });
    return sanitizeDoc(doc);
  },

  async remove(decisionId: string) {
    const res = await CiDecision.deleteOne({ decisionId });
    if (res.deletedCount === 0) throw new CiError(404, "Decisión no encontrada", "not_found");
    return { ok: true };
  },
};
