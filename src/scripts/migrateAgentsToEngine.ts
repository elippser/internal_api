/**
 * Migración de `agents` (modelo viejo) a `engine_agents` + `engine_agent_versions`.
 *
 *   npm run migrate:agents            # simulacro: dice qué haría, no escribe
 *   npm run migrate:agents -- --apply # escribe
 *
 * Es IDEMPOTENTE: correrla dos veces no duplica nada. La segunda pasada detecta
 * los agentes ya migrados por `slug` y los saltea, salvo que se pase `--force`,
 * que crea una versión NUEVA con la configuración actual del agente viejo (lo
 * cual es correcto: el versionado inmutable convierte una re-migración en un
 * punto más del historial, no en una sobrescritura).
 *
 * ── Qué se mapea 1:1 ────────────────────────────────────────────────────────
 *   instructions.systemPrompt  ->  version.systemPrompt
 *   enabledToolIds             ->  version.tools     (el puente al catálogo del
 *                                  PMS resuelve por toolId Y por nombre)
 *   modelOverride              ->  version.modelName (cualificado por proveedor)
 *   limits.maxTokensPerTurn    ->  version.modelParams.maxTokens
 *   status                     ->  agent.status
 *
 * ── Qué se preserva en `config.legacy` ──────────────────────────────────────
 * Persona, restricciones, ejemplos, bases de conocimiento, despliegue, captura
 * de feedback y límites de sesión. Son conceptos del runtime viejo que el motor
 * todavía no modela como campos propios; guardarlos textualmente permite que el
 * chat del PMS siga funcionando leyendo del motor (ver `agentResolver.ts`) sin
 * que la colección vieja siga siendo fuente de verdad. Cuando el motor gane
 * esos conceptos, se promueven desde acá.
 *
 * ── Qué NO se traslada, y por qué ───────────────────────────────────────────
 * El enrutado por tier de `subAgents.ts` (consulta/operativo/analista) elegía
 * modelo POR TURNO dentro del mismo chat. El motor corre un modelo por
 * ejecución, así que no hay equivalente automático: se migra al PISO operativo
 * (el modelo que el runtime viejo garantizaba para cualquier turno con
 * herramientas de escritura), que es el comportamiento seguro. El equivalente
 * expresivo en el motor es el menú de modelos por complejidad de un sub-agente,
 * pero eso es una decisión de autoría, no una traducción mecánica: inventarla
 * acá cambiaría el comportamiento del agente sin que nadie lo haya pedido.
 */
import "dotenv/config";
import mongoose from "mongoose";

import { connectDB } from "../shared/db";
import { AgentDefinition } from "../modules/agents/agents.model";
import { EngineAgent } from "../engine/models/agent.model";
import { EngineAgentVersion } from "../engine/models/agentVersion.model";
import { newId } from "../engine/core/ids";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

/**
 * Piso operativo del runtime viejo. Un modelo de la familia haiku no orquesta
 * herramientas de forma confiable, así que el runner elevaba a esto cualquier
 * turno con escrituras. Migrar por debajo del piso degradaría agentes que hoy
 * funcionan.
 */
const OPERATIONAL_FLOOR = process.env.OPERATIONAL_MODEL_FLOOR ?? "claude-sonnet-4-6";

interface Row {
  slug: string;
  name: string;
  action: "crear" | "versión nueva" | "saltear";
  model: string;
  tools: number;
  note: string;
}

function qualifyModel(raw: string | null | undefined, hasTools: boolean): string {
  const bare = (raw ?? "").trim();
  if (!bare) {
    // Sin override explícito el runtime viejo usaba el tier estándar.
    return `anthropic/${OPERATIONAL_FLOOR}`;
  }
  if (bare.includes("/")) return bare;

  // Un agente con herramientas no puede quedar por debajo del piso: el runtime
  // viejo lo elevaba en caliente y acá esa red de seguridad no existe.
  if (hasTools && /haiku/i.test(bare)) {
    return `anthropic/${OPERATIONAL_FLOOR}`;
  }
  return `anthropic/${bare}`;
}

async function main(): Promise<void> {
  await connectDB();

  const legacyAgents = await AgentDefinition.find({}).lean();
  console.log(
    `\nMigración de agentes al motor — ${APPLY ? "APLICANDO" : "SIMULACRO (usá --apply para escribir)"}\n`,
  );
  console.log(`Agentes en el modelo viejo: ${legacyAgents.length}\n`);

  if (legacyAgents.length === 0) {
    console.log("No hay nada que migrar.\n");
    await mongoose.disconnect();
    return;
  }

  const rows: Row[] = [];

  for (const legacy of legacyAgents) {
    const slug = String(legacy.slug);
    const existing = await EngineAgent.findOne({ slug, deletedAt: null }).lean();

    if (existing && !FORCE) {
      // Backfill del puntero al id viejo aunque se saltee el resto. Es lo que
      // permite que las conversaciones PREEXISTENTES —cuyas sesiones guardan el
      // id del módulo viejo— resuelvan al agente del motor. Sin esto seguirían
      // leyendo la colección congelada sin que nada falle.
      const needsBackfill = existing.legacyAgentId !== legacy.agentId;
      if (needsBackfill && APPLY) {
        await EngineAgent.updateOne(
          { agentId: existing.agentId },
          { $set: { legacyAgentId: String(legacy.agentId) } },
        );
      }
      rows.push({
        slug,
        name: String(legacy.name),
        action: "saltear",
        model: "—",
        tools: 0,
        note: needsBackfill
          ? `ya existe (${existing.agentId}) · enlace al id viejo ${APPLY ? "escrito" : "pendiente"}`
          : `ya existe (${existing.agentId})`,
      });
      continue;
    }

    const tools = (legacy.enabledToolIds ?? []).map(String);
    const modelName = qualifyModel(legacy.modelOverride, tools.length > 0);
    const elevated =
      legacy.modelOverride && !modelName.endsWith(String(legacy.modelOverride));

    // Todo lo que el motor todavía no modela como campo propio viaja textual.
    const legacyConfig = {
      migratedFrom: legacy.agentId,
      migratedAt: new Date().toISOString(),
      persona: legacy.persona ?? null,
      instructions: {
        constraints: legacy.instructions?.constraints ?? [],
        examples: legacy.instructions?.examples ?? [],
      },
      knowledgeBaseIds: legacy.knowledgeBaseIds ?? [],
      deployment: legacy.deployment ?? null,
      feedbackCapture: legacy.feedbackCapture ?? null,
      limits: legacy.limits ?? null,
    };

    const versionPayload = {
      graphType: "react_loop" as const,
      systemPrompt: buildSystemPrompt(legacy),
      tools,
      skills: [],
      subAgents: [],
      modelName,
      modelParams: {
        maxTokens: legacy.limits?.maxTokensPerTurn ?? 4096,
      },
      outputSchema: null,
      contextSchema: null,
      contextProviders: [],
      credentials: [],
      graphConfig: {},
      config: {
        capabilities: {
          // El runtime viejo daba búsqueda web y ejecución de código a los
          // tiers Sonnet/Opus. Se preservan como capacidades explícitas.
          web_search: true,
          code_execution: true,
        },
        legacy: legacyConfig,
      },
      timeoutSeconds: 300,
      maxDurationSeconds: 1800,
      maxRetries: 0,
      changeNote: `Migrado del módulo agents (${legacy.agentId})`,
      createdByUserId: String(legacy.createdByUserId ?? "migration"),
    };

    rows.push({
      slug,
      name: String(legacy.name),
      action: existing ? "versión nueva" : "crear",
      model: modelName.replace("anthropic/", ""),
      tools: tools.length,
      note: elevated
        ? `modelo elevado al piso operativo (era ${legacy.modelOverride})`
        : "",
    });

    if (!APPLY) continue;

    let agentId: string;
    if (existing) {
      agentId = existing.agentId;
    } else {
      agentId = newId("agent");
      await EngineAgent.create({
        agentId,
        slug,
        name: String(legacy.name),
        description: String(legacy.description ?? ""),
        imageUrl: legacy.avatarUrl ?? null,
        activeVersionId: null,
        // Puente para las sesiones de chat que ya existían.
        legacyAgentId: String(legacy.agentId),
        // Los agentes viejos no tienen inquilino: sirven a todos los hoteles y
        // acotan por `deployment.allowedCompanyIds`. Eso es exactamente un
        // agente GLOBAL de plataforma en el modelo del motor.
        tenantId: null,
        organizationId: process.env.ENGINE_ORGANIZATION_ID ?? "laupser",
        status: mapStatus(String(legacy.status)),
        availableInCopilot: legacy.deployment?.channel === "pms_app",
        createdByUserId: String(legacy.createdByUserId ?? "migration"),
      });
    }

    const last = await EngineAgentVersion.findOne({ agentId })
      .sort({ version: -1 })
      .select({ version: 1 })
      .lean();

    const versionId = newId("ver");
    await EngineAgentVersion.create({
      versionId,
      agentId,
      version: (last?.version ?? 0) + 1,
      ...versionPayload,
    });

    await EngineAgent.updateOne({ agentId }, { $set: { activeVersionId: versionId } });
  }

  // --- Reporte ------------------------------------------------------------
  const width = Math.max(12, ...rows.map((r) => r.slug.length));
  console.log(
    `${"SLUG".padEnd(width)}  ${"ACCIÓN".padEnd(14)} ${"MODELO".padEnd(22)} TOOLS  NOTA`,
  );
  console.log("─".repeat(width + 60));
  for (const r of rows) {
    console.log(
      `${r.slug.padEnd(width)}  ${r.action.padEnd(14)} ${r.model.padEnd(22)} ${String(r.tools).padStart(5)}  ${r.note}`,
    );
  }

  const created = rows.filter((r) => r.action !== "saltear").length;
  console.log(
    `\n${created} agente(s) ${APPLY ? "migrados" : "por migrar"}, ` +
      `${rows.length - created} salteados.`,
  );

  if (!APPLY) {
    console.log("\nSimulacro: no se escribió nada. Volvé a correr con --apply.\n");
  } else {
    console.log(
      "\nListo. El chat del PMS ya lee del motor vía agentResolver; " +
        "la colección vieja queda como respaldo de sólo lectura.\n",
    );
  }

  await mongoose.disconnect();
}

/**
 * Compone el prompt de sistema desde los tres campos que el runtime viejo
 * ensamblaba en caliente. Se materializa AL MIGRAR y no se deja para el
 * runtime porque el motor guarda el prompt como texto versionado: si siguiera
 * componiéndose en caliente, dos corridas de la "misma versión" podrían diferir.
 */
function buildSystemPrompt(legacy: Record<string, unknown>): string {
  const instructions = (legacy.instructions ?? {}) as {
    systemPrompt?: string;
    constraints?: string[];
  };
  const persona = (legacy.persona ?? {}) as {
    displayName?: string;
    tone?: string;
    language?: string;
    personality?: string;
  };

  const parts: string[] = [];

  if (persona.displayName) {
    const traits = [
      persona.tone ? `tono ${persona.tone}` : null,
      persona.language ? `idioma ${persona.language}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    parts.push(`## Persona\nSos "${persona.displayName}"${traits ? ` (${traits})` : ""}.`);
    if (persona.personality?.trim()) parts.push(persona.personality.trim());
  }

  if (instructions.systemPrompt?.trim()) {
    parts.push(instructions.systemPrompt.trim());
  }

  if (instructions.constraints?.length) {
    parts.push(
      ["## Restricciones", ...instructions.constraints.map((c) => `- ${c}`)].join("\n"),
    );
  }

  return parts.join("\n\n---\n\n");
}

function mapStatus(legacy: string): "draft" | "active" | "paused" | "archived" {
  if (legacy === "active" || legacy === "paused" || legacy === "archived") return legacy;
  return "draft";
}

main().catch(async (err) => {
  console.error("\nLa migración falló:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
