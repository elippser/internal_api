/**
 * Limpia TODO el dato de testing de internal-laupser (alcance: runtime +
 * artefactos de test), dejando una base demoable.
 *
 * BORRA:
 *   - conversation_sessions + conversation_messages (todo es de smoke/e2e/UI)
 *   - feedback_requests (capturados en testing)
 *   - improvement_tickets (sintetizados por el cron en testing)
 *   - analytics_events (100% seed)
 *   - agents creados en testing (createdByUserId !== "seed")
 *   - internal_users que no sean el super_admin seed (admin@laupser.com)
 *
 * MANTIENE:
 *   - internal_users: admin@laupser.com (super_admin seed)
 *   - tools: las 12 INITIAL_TOOLS
 *   - agents: el demo "asistente-de-operaciones" (createdByUserId === "seed")
 *   - knowledge_bases + knowledge_documents + knowledge_chunks (KB demo seed)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";

const KEEP_ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@bookfer.com";

async function snapshot(db: mongoose.mongo.Db) {
  const names = [
    "conversation_sessions",
    "conversation_messages",
    "feedback_requests",
    "improvement_tickets",
    "analytics_events",
    "agents",
    "knowledge_bases",
    "knowledge_documents",
    "knowledge_chunks",
    "internal_users",
    "tools",
  ];
  const out: Record<string, number> = {};
  for (const n of names) out[n] = await db.collection(n).countDocuments();
  return out;
}

function printSnapshot(label: string, s: Record<string, number>) {
  console.log(`\n=== ${label} ===`);
  for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(24)}: ${v}`);
}

async function main() {
  await connectDB();
  const db = mongoose.connection.db!;

  printSnapshot("estado inicial", await snapshot(db));

  // 1) Runtime de conversaciones — todo es de testing
  const msgs = await db.collection("conversation_messages").deleteMany({});
  const sess = await db.collection("conversation_sessions").deleteMany({});
  console.log(
    `\nborrado: ${sess.deletedCount} sesiones + ${msgs.deletedCount} mensajes`,
  );

  // 2) Feedback y tickets — generados en testing
  const fb = await db.collection("feedback_requests").deleteMany({});
  const tix = await db.collection("improvement_tickets").deleteMany({});
  console.log(`borrado: ${fb.deletedCount} feedbacks + ${tix.deletedCount} tickets`);

  // 3) Analytics — 100% seed
  const an = await db.collection("analytics_events").deleteMany({});
  console.log(`borrado: ${an.deletedCount} analytics_events`);

  // 4) Agentes creados en testing (mantener solo los del seed)
  const agentsToDelete = await db
    .collection("agents")
    .find(
      { createdByUserId: { $ne: "seed" } },
      { projection: { slug: 1 } },
    )
    .toArray();
  if (agentsToDelete.length > 0) {
    console.log(
      `\nagentes de testing a borrar: ${agentsToDelete
        .map((a) => a.slug)
        .join(", ")}`,
    );
    const ag = await db
      .collection("agents")
      .deleteMany({ createdByUserId: { $ne: "seed" } });
    console.log(`borrado: ${ag.deletedCount} agentes`);
  }

  // 5) Usuarios de testing (mantener solo el super_admin seed)
  const usersToDelete = await db
    .collection("internal_users")
    .find(
      { email: { $ne: KEEP_ADMIN_EMAIL } },
      { projection: { email: 1, role: 1 } },
    )
    .toArray();
  if (usersToDelete.length > 0) {
    console.log(
      `\nusuarios de testing a borrar: ${usersToDelete
        .map((u) => `${u.email} (${u.role})`)
        .join(", ")}`,
    );
    const us = await db
      .collection("internal_users")
      .deleteMany({ email: { $ne: KEEP_ADMIN_EMAIL } });
    console.log(`borrado: ${us.deletedCount} usuarios`);
  }

  printSnapshot("estado final", await snapshot(db));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("cleanTestingData failed:", err);
  process.exit(1);
});
