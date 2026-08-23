import crypto from "crypto";
import { makeId } from "../../shared/utils/ids";
import { crmService } from "../crm/crm.service";
import { MktAccount } from "../crm/crm.model";
import {
  MktNps,
  MktReview,
  npsCategory,
  sanitize,
  type ReviewSource,
} from "./reputation.model";

interface HttpError extends Error {
  status: number;
  code?: string;
}
function httpError(status: number, message: string, code?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

export const reputationService = {
  // ---------- Reviews ----------

  async listReviews(input: { source?: ReviewSource; unanswered?: boolean }) {
    const q: Record<string, unknown> = {};
    if (input.source) q.source = input.source;
    if (input.unanswered) q.respondedAt = { $exists: false };
    const rows = await MktReview.find(q).sort({ publishedAt: -1 }).limit(300).lean();
    return rows.map(sanitize);
  },

  async createReview(input: Record<string, any>) {
    const sentiment =
      input.sentiment ??
      (typeof input.rating === "number"
        ? input.rating >= 4
          ? "positive"
          : input.rating >= 3
            ? "neutral"
            : "negative"
        : undefined);

    try {
      const doc = await MktReview.create({
        ...input,
        sentiment,
        reviewId: makeId("rev"),
      });
      return sanitize(doc.toObject());
    } catch (err: any) {
      if (err?.code === 11000) {
        throw httpError(409, "Esa reseña ya estaba cargada", "duplicate");
      }
      throw err;
    }
  },

  async updateReview(reviewId: string, patch: Record<string, any>) {
    // Escribir una respuesta la marca como respondida sin un paso extra.
    if (patch.responseText && !patch.respondedAt) patch.respondedAt = new Date();
    const doc = await MktReview.findOneAndUpdate(
      { reviewId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!doc) throw httpError(404, "Reseña no encontrada", "not_found");
    return sanitize(doc);
  },

  async deleteReview(reviewId: string) {
    const res = await MktReview.deleteOne({ reviewId });
    if (res.deletedCount === 0) throw httpError(404, "Reseña no encontrada", "not_found");
    return { deleted: true };
  },

  // ---------- NPS ----------

  /** Genera la encuesta y devuelve el link tokenizado para mandar. */
  async createNpsInvite(accountId: string, contactId?: string) {
    const account = await MktAccount.findOne({ accountId }).lean();
    if (!account) throw httpError(404, "Cuenta no encontrada", "not_found");

    const doc = await MktNps.create({
      npsId: makeId("nps"),
      accountId,
      contactId,
      token: crypto.randomBytes(24).toString("hex"),
      expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
    });

    const base = process.env.MKT_PUBLIC_URL ?? "http://localhost:8600";
    return {
      ...sanitize(doc.toObject()),
      url: `${base}/public/mkt/nps/${doc.token}`,
    };
  },

  /** Datos minimos para pintar el formulario publico. */
  async getNpsByToken(token: string) {
    const nps = await MktNps.findOne({ token }).lean();
    if (!nps) throw httpError(404, "Encuesta no encontrada", "not_found");
    if (nps.submittedAt) throw httpError(409, "Ya respondiste esta encuesta", "already_done");
    if (nps.expiresAt && nps.expiresAt.getTime() < Date.now()) {
      throw httpError(410, "La encuesta vencio", "expired");
    }
    const account = await MktAccount.findOne({ accountId: nps.accountId })
      .select({ name: 1 })
      .lean();
    return { token, accountName: account?.name ?? "" };
  },

  /**
   * Respuesta publica. El ruteo por score es el corazon del modulo: al promotor
   * se le pide la reseña publica, al detractor se lo escala internamente.
   */
  async submitNps(token: string, score: number, comment?: string) {
    const nps = await MktNps.findOne({ token });
    if (!nps) throw httpError(404, "Encuesta no encontrada", "not_found");
    if (nps.submittedAt) throw httpError(409, "Ya respondiste esta encuesta", "already_done");

    const category = npsCategory(score);
    nps.set("score", score);
    nps.set("comment", comment ?? "");
    nps.set("submittedAt", new Date());
    nps.set("followUpStatus", category === "promoter" ? "review_requested" : "escalated");
    await nps.save();

    // Queda como reseña propia para que entre en el promedio del tablero.
    await MktReview.create({
      reviewId: makeId("rev"),
      source: "direct",
      rating: Math.round((score / 10) * 5 * 10) / 10,
      text: comment ?? "",
      accountId: nps.accountId,
      publishedAt: new Date(),
      sentiment:
        category === "promoter"
          ? "positive"
          : category === "passive"
            ? "neutral"
            : "negative",
      ingestion: "manual",
    });

    await crmService.ingestEvent({
      type: "nps.submitted",
      correlationId: `nps:${nps.npsId}`,
      accountId: nps.accountId,
      payload: { score, category },
      source: "nps",
    });

    return {
      category,
      // Solo al promotor se lo empuja a reseñar en publico.
      askForPublicReview: category === "promoter",
      googleReviewUrl: process.env.MKT_GOOGLE_REVIEW_URL ?? "",
      capterraUrl: process.env.MKT_CAPTERRA_URL ?? "",
    };
  },

  async listNps() {
    const rows = await MktNps.find({ submittedAt: { $exists: true } })
      .sort({ submittedAt: -1 })
      .limit(300)
      .lean();
    return rows.map(sanitize);
  },

  // ---------- Tablero ----------

  async dashboard() {
    const [bySource, responses, unanswered, recentNegative] = await Promise.all([
      MktReview.aggregate<{ _id: string; count: number; avg: number }>([
        { $match: { rating: { $exists: true } } },
        { $group: { _id: "$source", count: { $sum: 1 }, avg: { $avg: "$rating" } } },
      ]),
      MktNps.find({ score: { $exists: true } }).select({ score: 1 }).lean(),
      MktReview.countDocuments({ respondedAt: { $exists: false } }),
      MktReview.find({ sentiment: "negative" })
        .sort({ publishedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    // NPS = %promotores - %detractores.
    const total = responses.length;
    const promoters = responses.filter((r) => (r.score ?? 0) >= 9).length;
    const detractors = responses.filter((r) => (r.score ?? 0) <= 6).length;
    const nps = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : null;

    const allRated = bySource.reduce(
      (acc, s) => ({ sum: acc.sum + s.avg * s.count, count: acc.count + s.count }),
      { sum: 0, count: 0 },
    );

    return {
      nps,
      npsResponses: total,
      promoters,
      detractors,
      passives: total - promoters - detractors,
      averageRating:
        allRated.count > 0 ? Math.round((allRated.sum / allRated.count) * 100) / 100 : null,
      totalReviews: allRated.count,
      unanswered,
      bySource: bySource.map((s) => ({
        source: s._id,
        count: s.count,
        avg: Math.round(s.avg * 100) / 100,
      })),
      recentNegative: recentNegative.map(sanitize),
    };
  },
};
