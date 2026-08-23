/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { makeId } from "../shared/utils/ids";
import { AgentDefinition } from "../modules/agents/agents.model";
import { InternalUser } from "../modules/users/users.model";

// Slug canonico del agente del editor. DEBE coincidir con
// bookfer_EDITOR_AGENT_SLUG en pms-core/api (el reporter usa este slug al
// reportar consumo a /usage/records).
const EDITOR_AGENT_SLUG = "asistente-del-editor";

async function run() {
  await connectDB();

  const admin = await InternalUser.findOne({ role: "super_admin" });
  const createdByUserId = admin?.userId ?? "seed-script";

  const existing = await AgentDefinition.findOne({ slug: EDITOR_AGENT_SLUG });
  if (existing) {
    console.log(`• Agente del editor ya existe (${existing.agentId}), skip`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const agent = await AgentDefinition.create({
    agentId: makeId("agent"),
    name: "Asistente del Editor",
    slug: EDITOR_AGENT_SLUG,
    description:
      "Agente del editor/builder del PMS. Crea, edita y reordena secciones " +
      "del sitio a partir de instrucciones en lenguaje natural. Su runtime " +
      "vive en pms-core/api (socket /ai, streaming con tools client-side); " +
      "el internal guarda esta definicion canonica y mide su consumo via " +
      "/usage/records.",
    status: "active",
    persona: {
      displayName: "bookfer IA",
      tone: "friendly",
      language: "es",
      personality:
        "Asistente de diseno web: claro, directo, orientado a la accion. " +
        "Construye y modifica la pagina sin pedir confirmaciones innecesarias.",
    },
    instructions: {
      // El system prompt real del editor vive en pms-core/api
      // (aiBuilderPrompt.ts). Aca no lo duplicamos: el internal no ejecuta
      // este agente, solo lo cataloga y mide.
      systemPrompt: "",
      constraints: [],
      examples: [],
    },
    knowledgeBaseIds: [],
    enabledToolIds: [],
    modelOverride: null,
    deployment: {
      channel: "builder",
      allowedCompanyIds: [],
      requiresAuth: true,
    },
    feedbackCapture: { enabled: false, autoClassify: false, confirmWithUser: false },
    limits: { maxTurnsPerSession: 200, maxTokensPerTurn: 24576, sessionTtlMinutes: 120 },
    createdByUserId,
    version: 1,
  });

  console.log(
    `✓ Agente del editor creado: ${agent.agentId} (slug=${EDITOR_AGENT_SLUG}, status=active)`,
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seedEditorAgent] error:", err);
  process.exit(1);
});
