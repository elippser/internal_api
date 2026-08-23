import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { FeedbackRequest } from "../modules/feedback/feedback.model";
import { ImprovementTicket } from "../modules/tickets/tickets.model";
import { runTicketingCron } from "../modules/tickets/ticketingCron";

async function main() {
  await connectDB();

  const newCount = await FeedbackRequest.countDocuments({ status: "new" });
  console.log(`feedbacks new antes: ${newCount}`);

  if (newCount === 0) {
    console.log("(no hay feedbacks new — corre primero npm run seed:feedback)");
    await mongoose.disconnect();
    process.exit(0);
  }

  const summary = await runTicketingCron({ triggeredManually: true });
  console.log("\ncron summary:", JSON.stringify(summary, null, 2));

  const tickets = await ImprovementTicket.find()
    .sort({ priorityScore: -1 })
    .limit(10);
  console.log(`\ntickets en DB: ${tickets.length}`);
  for (const t of tickets) {
    console.log(
      `  ${t.ticketId.slice(-8)} | ${t.priority.padEnd(8)} | score ${String(t.priorityScore).padStart(3)} | ${t.type.padEnd(11)} | ${t.linkedFeedbackIds?.length ?? 0} fbs | ${t.title}`,
    );
  }

  const linkedAfter = await FeedbackRequest.countDocuments({
    status: "linked_to_ticket",
  });
  const newAfter = await FeedbackRequest.countDocuments({ status: "new" });
  console.log(`\nfeedbacks linked_to_ticket: ${linkedAfter}`);
  console.log(`feedbacks new restantes: ${newAfter}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
