import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { hotelsService } from "../modules/hotels/hotels.service";

async function main() {
  await connectDB();

  console.log("=== list (page 1, limit 5) ===");
  const list = await hotelsService.list({ page: 1, limit: 5 });
  console.log(`total: ${list.total}`);
  for (const h of list.data) {
    console.log(
      `  ${h.companyId} | ${h.name?.slice(0, 30).padEnd(30)} | ${h.plan?.padEnd(10)} | props ${h.propertyCount ?? 0} | last: ${h.lastEventName ?? "—"}`,
    );
  }

  if (list.data.length === 0) {
    console.log("(no companies in PMS DB)");
    await mongoose.disconnect();
    process.exit(0);
  }

  const first = list.data[0];

  console.log("\n=== getById ===");
  const detail = await hotelsService.getById(first.companyId);
  console.log(JSON.stringify(detail?.stats, null, 2));

  console.log("\n=== listProperties ===");
  const props = await hotelsService.listProperties(first.companyId);
  console.log(`count: ${props.length}`);
  for (const p of props.slice(0, 3)) {
    console.log(
      `  ${p.propertyId} | ${p.name} | ${p.address?.city ?? "—"} | units ${p.unitCount ?? 0}`,
    );
  }

  console.log("\n=== listActivity (top 5) ===");
  const acts = await hotelsService.listActivity({
    companyId: first.companyId,
    limit: 5,
  });
  console.log(`count: ${acts.length}`);
  for (const a of acts) {
    console.log(
      `  ${new Date(a.serverTimestamp).toISOString()} | ${a.eventName} | ${a.category}`,
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("smokeHotels failed:", err);
  process.exit(1);
});
