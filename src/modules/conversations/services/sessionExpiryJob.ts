import cron from "node-cron";
import { AgentDefinition } from "../../agents/agents.model";
import { ConversationSession } from "../conversations.model";

let started = false;

export function startSessionExpiryJob() {
  if (started) return;
  started = true;

  cron.schedule("*/10 * * * *", async () => {
    try {
      const now = Date.now();
      const active = await ConversationSession.find({ status: "active" });
      if (active.length === 0) return;

      // Cache de limits por agente para evitar N queries por tick
      const agentIds = [...new Set(active.map((s) => s.agentId))];
      const agents = await AgentDefinition.find(
        { agentId: { $in: agentIds } },
        { agentId: 1, "limits.sessionTtlMinutes": 1 },
      );
      const ttlByAgent = new Map(
        agents.map((a) => [
          a.agentId,
          (a.limits?.sessionTtlMinutes ?? 60) * 60 * 1000,
        ]),
      );

      let expired = 0;
      for (const session of active) {
        const ttlMs = ttlByAgent.get(session.agentId) ?? 60 * 60 * 1000;
        if (now - session.lastActivityAt.getTime() > ttlMs) {
          session.status = "expired";
          session.endedAt = new Date();
          await session.save();
          expired++;
        }
      }
      if (expired > 0) {
        console.log(`[conversations] expired ${expired} sessions`);
      }
    } catch (err) {
      console.error("[conversations] sessionExpiryJob failed:", err);
    }
  });

  console.log("[conversations] sessionExpiryJob scheduled (*/10 min)");
}
