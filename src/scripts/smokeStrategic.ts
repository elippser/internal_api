/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smoke del turno estratégico contra DATOS REALES, sin gastar un token.
 *
 *   npm run smoke:strategic -- <propertyId> [userId] [companyId]
 *
 * Corre todo lo que pasa ANTES del modelo: lee la foto de la propiedad de sus
 * diez fuentes, resuelve qué playbooks aplican, arma el índice de palancas con
 * los permisos del usuario y renderiza los bloques del prompt. Después imprime
 * lo que le llegaría al modelo y cuánto pesa.
 *
 * Es la prueba que hay que correr antes de deployar, y es la que contesta las
 * preguntas que un typecheck no puede:
 *
 *   - ¿los recolectores le pegan a los endpoints correctos, o hay uno que
 *     devuelve 404 y deja su bloque en `missing` para siempre?
 *   - ¿la foto de un hotel real dispara algún playbook, o las reglas están
 *     calibradas para un hotel que no existe?
 *   - ¿cuántos tokens pesa realmente el prompt estratégico?
 *
 * No escribe nada. No llama al modelo. Se puede correr contra producción.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { prepareStrategicTurn } from "../modules/growth/strategicTurn";
import { resolveScopeForSession } from "../modules/conversations/services/toolAccess";
import { computeTurnToolAccess } from "../modules/conversations/services/toolAccess";
import { resolveAgent } from "../modules/conversations/services/agentResolver";
import { buildPropertySnapshot } from "../modules/growth/snapshot/snapshot.service";

const [propertyId, userId, companyId] = process.argv.slice(2);

/** Estimación de tokens. Grosera pero suficiente para decidir. */
function tokens(text: string): number {
  return Math.round(text.length / 3.6);
}

function box(title: string) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

async function main() {
  if (!propertyId) {
    console.error(
      "Uso: npm run smoke:strategic -- <propertyId> [userId] [companyId]",
    );
    process.exit(1);
  }
  await connectDB();

  // 1. La foto sola, primero: si falla acá no hay turno estratégico posible y
  //    el resto del diagnóstico sobra.
  box("1. FOTO DE LA PROPIEDAD");
  const t0 = Date.now();
  const snapshot = await buildPropertySnapshot({
    propertyId,
    companyId,
    userId,
    fresh: true,
  });
  if (!snapshot) {
    console.error(
      `✗ No se pudo leer la propiedad ${propertyId}. Sin identidad no hay foto.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Tardó ${Date.now() - t0} ms (${snapshot.collectedInMs} ms de recolección).`);
  console.log(`Propiedad: ${snapshot.identity.name} · ${snapshot.identity.type} · ${snapshot.identity.city}`);
  console.log(`Inventario: ${snapshot.identity.units} unidades / ${snapshot.identity.categories} categorías`);
  console.log(`Coordenadas: ${snapshot.identity.lat ?? "s/d"}, ${snapshot.identity.lng ?? "s/d"}`);
  console.log("");
  const blocks: Array<[string, unknown]> = [
    ["demand", snapshot.demand],
    ["ops", snapshot.ops],
    ["direct", snapshot.direct],
    ["presence", snapshot.presence],
    ["reputation", snapshot.reputation],
    ["market", snapshot.market],
    ["revenue", snapshot.revenue],
  ];
  for (const [name, value] of blocks) {
    console.log(`  ${value ? "✓" : "✗"} ${name.padEnd(12)} ${value ? "" : "← sin datos"}`);
  }
  if (snapshot.missing.length > 0) {
    console.log(
      `\n⚠ ${snapshot.missing.length} bloque(s) sin datos. Si es un hotel activo, revisá` +
        ` los logs de arriba: cada recolector que falla deja un warn con su motivo.`,
    );
  }

  // 2. El turno completo, con permisos reales.
  box("2. TURNO ESTRATÉGICO");
  const scope = userId
    ? await resolveScopeForSession({ userId, companyId })
    : null;
  if (userId && !scope?.resolved) {
    console.log(
      "⚠ No se pudo resolver el alcance del usuario contra pms-core: el índice de" +
        " palancas va a salir sin filtrar por permisos.",
    );
  }
  if (scope) {
    console.log(
      `Usuario: ${scope.role ?? "sin rol"}${scope.isAdmin ? " (admin)" : ""} · ` +
        `experiencia: ${scope.experienceLevel} · ` +
        `${scope.allProperties ? "todas las propiedades" : `${scope.propertyIds.length} propiedades`}`,
    );
  }

  const agent = await resolveAgent("asistente-de-operaciones").catch(() => null);
  const enabled = agent?.enabledToolIds ?? [];
  const access =
    scope && enabled.length
      ? await computeTurnToolAccess(enabled, scope)
      : { allowedToolIds: enabled, denied: [], appAccess: [] };
  console.log(
    `Tools del agente: ${enabled.length} · permitidas a este usuario: ${access.allowedToolIds.length}`,
  );

  const plan = await prepareStrategicTurn({
    propertyId,
    companyId,
    userId,
    scope,
    allowedToolIds: access.allowedToolIds,
    routedModel: "(router)",
  });
  if (!plan) {
    console.error("✗ prepareStrategicTurn devolvió null.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("");
  console.log(`Modelo: ${plan.model}`);
  console.log(`Playbooks aplicables: ${plan.meta.playbookIds.join(", ") || "(ninguno)"}`);
  console.log(`Palancas ofrecidas: ${plan.meta.leverCount}`);
  console.log(`Tools de drill-down: ${plan.toolIds.length}`);
  console.log(`Iteraciones: ${plan.profile.maxIterations} · razonamiento: ${plan.profile.thinkingBudget}`);
  if (plan.planContext.index.droppedByPolicy.length > 0) {
    console.log(
      `Palancas filtradas por permisos (${plan.planContext.index.droppedByPolicy.length}): ` +
        plan.planContext.index.droppedByPolicy.join(", "),
    );
  }

  // 3. Presupuesto. La razón entera del rediseño es este número.
  box("3. PRESUPUESTO DEL PROMPT");
  const parts: Array<[string, string]> = [
    ["Índice de palancas (estático, cacheable)", plan.staticBlock],
    ["Foto + playbooks + nivel + plan activo (dinámico)", plan.dynamicBlock],
    ["Especialización del turno", plan.specialization],
  ];
  let total = 0;
  for (const [label, text] of parts) {
    const t = tokens(text);
    total += t;
    console.log(`  ${String(t).padStart(6)} tok  ${label}`);
  }
  // Las definiciones de las tools de drill-down: ~130 tok cada una, medido
  // sobre el catálogo real.
  const toolsTok = plan.toolIds.length * 130;
  total += toolsTok;
  console.log(`  ${String(toolsTok).padStart(6)} tok  Definiciones de ${plan.toolIds.length} tools de lectura`);
  console.log(`  ${"─".repeat(6)}`);
  console.log(`  ${String(total).padStart(6)} tok  TOTAL del turno estratégico`);
  console.log("");
  console.log(
    `Referencia: un turno normal manda ~46.000 tokens sólo de definiciones de tools.`,
  );

  // 4. Lo que realmente lee el modelo. Es largo, pero es EL entregable: si esto
  //    no se entiende leyéndolo, el modelo tampoco lo va a entender.
  if (process.argv.includes("--print")) {
    box("4. PROMPT (bloque estático)");
    console.log(plan.staticBlock || "(vacío)");
    box("4. PROMPT (bloque dinámico)");
    console.log(plan.dynamicBlock);
    box("4. PROMPT (especialización)");
    console.log(plan.specialization);
  } else {
    console.log("\n(--print para ver el prompt completo)");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
