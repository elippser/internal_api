/**
 * Limpia datos sinteticos (seed scripts) dejando solo lo generado por
 * testing real (smoke tests, sesiones que pasaron por Claude).
 *
 * Borra:
 *   - conversation_sessions con context.userId LIKE 'user-demo-%'
 *   - conversation_messages de esas sesiones (cascada)
 *   - feedback_requests cuyo sessionId NO existe en conversation_sessions
 *   - analytics_events (100% seed)
 *   - improvement_tickets creados por seed (createdByAgent: false, cronRunId: null)
 *     [si quedan algunos sueltos]
 *
 * Mantiene: agentes, KBs+chunks, tools, users, sesiones reales y sus
 * mensajes, feedbacks vinculados a sesiones reales.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";

interface Plan {
  syntheticSessionIds: string[];
  realSessionIds: string[];
  orphanFeedbackIds: string[];
  analyticsCount: number;
}

async function plan(db: mongoose.mongo.Db): Promise<Plan> {
  const sessions = await db
    .collection("conversation_sessions")
    .find({}, { projection: { sessionId: 1, "context.userId": 1 } })
    .toArray();

  const syntheticSessionIds: string[] = [];
  const realSessionIds: string[] = [];
  for (const s of sessions) {
    const uid: string | undefined = s.context?.userId;
    if (uid && uid.startsWith("user-demo-")) {
      syntheticSessionIds.push(s.sessionId);
    } else {
      realSessionIds.push(s.sessionId);
    }
  }

  const realSet = new Set(realSessionIds);
  const feedbacks = await db
    .collection("feedback_requests")
    .find({}, { projection: { feedbackId: 1, sessionId: 1 } })
    .toArray();
  const orphanFeedbackIds = feedbacks
    .filter((f) => !realSet.has(f.sessionId))
    .map((f) => f.feedbackId);

  const analyticsCount = await db
    .collection("analytics_events")
    .countDocuments();

  return {
    syntheticSessionIds,
    realSessionIds,
    orphanFeedbackIds,
    analyticsCount,
  };
}

async function main() {
  await connectDB();
  const db = mongoose.connection.db!;

  const p = await plan(db);

  console.log("=== plan ===");
  console.log(`sintéticas a borrar  : ${p.syntheticSessionIds.length}`);
  console.log(`reales a mantener    : ${p.realSessionIds.length}`);
  console.log(`feedbacks huérfanos  : ${p.orphanFeedbackIds.length}`);
  console.log(`analytics_events     : ${p.analyticsCount}`);
  console.log("");

  if (p.syntheticSessionIds.length > 0) {
    const r1 = await db
      .collection("conversation_messages")
      .deleteMany({ sessionId: { $in: p.syntheticSessionIds } });
    const r2 = await db
      .collection("conversation_sessions")
      .deleteMany({ sessionId: { $in: p.syntheticSessionIds } });
    console.log(
      `borradas: ${r2.deletedCount} sesiones + ${r1.deletedCount} mensajes`,
    );
  }

  if (p.orphanFeedbackIds.length > 0) {
    const r = await db
      .collection("feedback_requests")
      .deleteMany({ feedbackId: { $in: p.orphanFeedbackIds } });
    console.log(`borrados: ${r.deletedCount} feedbacks huérfanos`);
  }

  if (p.analyticsCount > 0) {
    const r = await db.collection("analytics_events").deleteMany({});
    console.log(`borrados: ${r.deletedCount} analytics_events`);
  }

  console.log("");
  console.log("=== estado final ===");
  const final = {
    sessions: await db.collection("conversation_sessions").countDocuments(),
    messages: await db.collection("conversation_messages").countDocuments(),
    feedbacks: await db.collection("feedback_requests").countDocuments(),
    analytics: await db.collection("analytics_events").countDocuments(),
    tickets: await db.collection("improvement_tickets").countDocuments(),
    agents: await db.collection("agents").countDocuments(),
    kbs: await db.collection("knowledge_bases").countDocuments(),
    chunks: await db.collection("knowledge_chunks").countDocuments(),
    tools: await db.collection("tools").countDocuments(),
    users: await db.collection("internal_users").countDocuments(),
  };
  for (const [k, v] of Object.entries(final)) {
    console.log(`  ${k.padEnd(10)}: ${v}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("cleanSeed failed:", err);
  process.exit(1);
});
