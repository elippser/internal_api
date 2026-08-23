/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { INITIAL_TOOLS, Tool } from "../modules/tools/tools.model";
import { AgentDefinition } from "../modules/agents/agents.model";
import {
  OPS_AGENT_SLUG,
  logPublishResult,
  publishOpsAgentVersion,
} from "./lib/engineAgentSync";

async function run() {
  await connectDB();

  // 1) Upsert de todas las tools del catalogo POR toolId (identificador
  //    estable). Keyear por toolId — y no por name — tolera renombres de tools
  //    (ej. list_web_projects -> list_site_projects reusa el mismo toolId): el
  //    doc existente se actualiza en vez de chocar con el indice unico de toolId.
  const toolIds: string[] = [];
  for (const t of INITIAL_TOOLS as any[]) {
    toolIds.push(t.toolId);
    await Tool.updateOne(
      { toolId: t.toolId },
      {
        $set: {
          toolId: t.toolId,
          name: t.name,
          displayName: t.displayName,
          description: t.description ?? "",
          category: t.category,
          inputSchema: t.inputSchema ?? { type: "object", properties: {}, required: [] },
          execution: {
            authStrategy: "staff_jwt",
            timeout: 10000,
            ...t.execution,
          },
          permissions: t.permissions,
          status: t.status ?? "active",
        },
      },
      { upsert: true },
    );
  }
  console.log(`✓ ${toolIds.length} tools upserted`);

  // 2) Limpiar tools viejas que ya no estan en el catalogo (por toolId). Esto
  //    tambien borra nombres huerfanos de renombres (ej. list_web_projects,
  //    list_sites) cuyos toolId fueron reasignados — el doc viejo por toolId ya
  //    se actualizo arriba, asi que aca solo caen toolIds realmente eliminados.
  const removed = await Tool.deleteMany({ toolId: { $nin: toolIds } });
  if (removed.deletedCount) {
    console.log(`✓ ${removed.deletedCount} tools obsoletas eliminadas`);
  }

  // 3) Habilitar TODAS las tools activas en el agente de operaciones.
  const activeTools = await Tool.find({ status: "active" }, { toolId: 1 });
  const activeToolIds = activeTools.map((t) => t.toolId);

  const agent = await AgentDefinition.findOne({ slug: OPS_AGENT_SLUG });
  if (!agent) {
    console.warn(
      `⚠ No se encontro el agente con slug "${OPS_AGENT_SLUG}". Tools quedaron upserted pero sin asignar.`,
    );
  } else {
    agent.enabledToolIds = activeToolIds;
    await agent.save();
    console.log(
      `✓ Agente "${agent.persona?.displayName ?? agent.name}" (${agent.agentId}) ahora tiene ${activeToolIds.length} tools habilitadas`,
    );
  }

  // 4) Publicar las tools EN EL MOTOR. Sin este paso el punto 3 no cambia nada
  //    de lo que corre: el chat resuelve el agente desde `engine_agents` y sólo
  //    cae a la colección vieja si no está migrado. Escribir únicamente en
  //    `agents` fue lo que dejó al agente sin las herramientas del RMS.
  const published = await publishOpsAgentVersion({
    tools: activeToolIds,
    changeNote: `seed:agent-tools — ${activeToolIds.length} tools del catálogo`,
  });
  logPublishResult(published, "tools");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("[seedAgentTools] error:", err);
  process.exit(1);
});
