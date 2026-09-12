/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Repunta a OpenRouter los modelos que estan GUARDADOS EN LA BASE.
 *
 * Cambiar los defaults del codigo no alcanza: el chat de Roombir IA lee el
 * modelo de la version activa del agente en `engine_agent_versions`, y los
 * agentes de la coleccion `agents` tienen su `modelOverride`. Mientras esos
 * documentos digan `claude-...`, el runtime va a seguir pidiendo un modelo de
 * Anthropic con una key de OpenRouter y cada turno va a morir en un 404.
 *
 * Por defecto NO escribe: informa que cambiaria. Para aplicar:
 *
 *   npm run migrate:models -- --apply
 *
 * El motor versiona: en vez de editar la version activa se PUBLICA una nueva
 * con el modelo nuevo, asi que volver atras es reactivar la anterior desde la
 * UI del editor de agentes.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { EngineAgent } from "../engine/models/agent.model";
import { EngineAgentVersion } from "../engine/models/agentVersion.model";
import { AgentDefinition } from "../modules/agents/agents.model";
import { engineModelFor, modelFor, tierOf } from "../shared/llm/provider";

const APPLY = process.argv.includes("--apply");

/**
 * A que tier va cada modelo viejo. El criterio es el mismo que se uso en el
 * codigo: haiku era el tier barato, sonnet el estandar y opus/fable el caro.
 */
function targetTier(old: string): "cheap" | "standard" | "premium" | null {
  const m = (old || "").toLowerCase();
  if (tierOf(m)) return null; // ya migrado
  if (m.includes("haiku")) return "cheap";
  if (m.includes("sonnet")) return "standard";
  if (m.includes("opus") || m.includes("fable")) return "premium";
  return null;
}

interface Change {
  coleccion: string;
  id: string;
  nombre: string;
  de: string;
  a: string;
}

async function main(): Promise<void> {
  await connectDB();
  const changes: Change[] = [];

  // ── Versiones activas del motor (lo que el chat lee de verdad) ─────────────
  const agents = await EngineAgent.find({ deletedAt: null }).lean();
  for (const agent of agents as any[]) {
    if (!agent.activeVersionId) continue;
    const version = (await EngineAgentVersion.findOne({
      versionId: agent.activeVersionId,
    }).lean()) as any;
    if (!version?.modelName) continue;

    const tier = targetTier(version.modelName);
    if (!tier) continue;

    changes.push({
      coleccion: "engine_agent_versions",
      id: version.versionId,
      nombre: `${agent.slug} v${version.version}`,
      de: version.modelName,
      a: engineModelFor(tier),
    });

    if (APPLY) {
      // Se publica una version nueva en vez de editar la activa: el historial
      // es el unico camino de vuelta si el modelo nuevo se porta distinto.
      const { publishOpsAgentVersion } = await import("./lib/engineAgentSync");
      const res = await publishOpsAgentVersion(
        {
          model: engineModelFor(tier),
          changeNote: `migrate:models — ${version.modelName} -> ${engineModelFor(tier)} (paso a OpenRouter)`,
        },
        agent.slug,
      );
      console.log(`  publicado ${agent.slug}: ${res.status}${res.version ? ` v${res.version}` : ""}`);
    }
  }

  // ── modelOverride de la coleccion vieja de agentes ─────────────────────────
  const defs = await AgentDefinition.find({}).lean();
  for (const def of defs as any[]) {
    const tier = targetTier(def.modelOverride);
    if (!tier) continue;
    changes.push({
      coleccion: "agents",
      id: def.agentId,
      nombre: def.slug ?? def.name ?? def.agentId,
      de: def.modelOverride,
      // Esta coleccion guarda el id DESNUDO (el motor es el unico que cualifica).
      a: modelFor(tier),
    });
    if (APPLY) {
      await AgentDefinition.updateOne(
        { agentId: def.agentId },
        { $set: { modelOverride: modelFor(tier) } },
      );
    }
  }

  // ── Informe ────────────────────────────────────────────────────────────────
  if (changes.length === 0) {
    console.log("\nNo quedan modelos de Anthropic guardados en la base.");
  } else {
    console.log(`\n${APPLY ? "Aplicados" : "Se aplicarian"} ${changes.length} cambios:\n`);
    for (const c of changes) {
      console.log(`  [${c.coleccion}] ${c.nombre}`);
      console.log(`      ${c.de}  ->  ${c.a}`);
    }
    if (!APPLY) {
      console.log("\nEnsayo. Para escribir de verdad:  npm run migrate:models -- --apply");
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("migrate:models error:", err);
  process.exit(1);
});
