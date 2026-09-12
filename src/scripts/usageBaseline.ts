/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Baseline de consumo del chat. SÓLO LECTURA.
 *
 *   npm run usage:baseline            # últimos 14 días
 *   npm run usage:baseline -- 30      # últimos 30
 *
 * Responde las cuatro preguntas que deciden si vale la pena cambiar de modelo,
 * y que hasta ahora se contestaban de memoria:
 *
 *   1. ¿Cuántos tokens de entrada gasta realmente un turno, por tier?
 *   2. ¿El prompt caching funciona a través de OpenRouter? (`cacheRead` en cero
 *      significa que no, y entonces el prefijo de 46k se paga entero SIEMPRE.)
 *   3. ¿Cuántos turnos mueren por agotar las iteraciones?
 *   4. ¿Cómo escribe la gente los pedidos estratégicos? (para el set de eval)
 *
 * No escribe nada. Se puede correr contra producción.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { ConversationMessage } from "../modules/conversations/conversations.model";

const DAYS = Number(process.argv[2] ?? 14);

/** Pedidos de objetivo abierto, para armar el set de `eval:strategic`. */
const STRATEGIC_RE =
  /aument|mejor|crec|ocupaci|m[aá]s reservas|no s[eé] (por d[oó]nde|c[oó]mo)|estrateg|vender m[aá]s|ayudame a|llenar|dame ideas|un plan/i;

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fmt(v: number): string {
  return Math.round(v).toLocaleString("es-AR");
}

async function main() {
  await connectDB();
  const since = new Date(Date.now() - DAYS * 86_400_000);

  const rows = await ConversationMessage.aggregate([
    {
      $match: {
        role: "assistant",
        createdAt: { $gte: since },
        "agentMeta.modelUsed": { $exists: true, $ne: "" },
      },
    },
    {
      $group: {
        _id: { model: "$agentMeta.modelUsed", tier: "$agentMeta.routedTier" },
        n: { $sum: 1 },
        inTok: { $avg: "$agentMeta.inputTokens" },
        outTok: { $avg: "$agentMeta.outputTokens" },
        cacheRead: { $avg: "$agentMeta.cacheReadInputTokens" },
        cacheReadMax: { $max: "$agentMeta.cacheReadInputTokens" },
        cacheCreate: { $avg: "$agentMeta.cacheCreationInputTokens" },
        lat: { $avg: "$agentMeta.latencyMs" },
        tools: { $avg: { $size: { $ifNull: ["$agentMeta.toolsExecuted", []] } } },
        chars: { $avg: { $strLenCP: { $ifNull: ["$content", ""] } } },
        maxIter: {
          $sum: {
            $cond: [
              { $in: ["$agentMeta.stopReason", ["max_iterations_reached", "max_iterations_finalized"]] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { n: -1 } },
  ]);

  console.log(`\n=== CONSUMO POR MODELO · últimos ${DAYS} días ===\n`);
  if (rows.length === 0) {
    console.log("No hay turnos del asistente en la ventana.");
  }
  for (const r of rows) {
    const id = `${r._id.model}${r._id.tier ? ` (${r._id.tier})` : ""}`;
    console.log(id);
    console.log(`  turnos: ${r.n}`);
    console.log(`  entrada: ${fmt(r.inTok)} tok · salida: ${fmt(r.outTok)} tok`);
    console.log(
      `  caché: lee ${fmt(r.cacheRead)} (máx ${fmt(r.cacheReadMax)}) · escribe ${fmt(r.cacheCreate)}` +
        (n(r.cacheReadMax) === 0
          ? "   ← NUNCA leyó de caché: el prefijo se paga entero en cada turno"
          : ""),
    );
    console.log(
      `  latencia: ${fmt(r.lat)} ms · tools por turno: ${(r.tools ?? 0).toFixed(1)} · respuesta: ${fmt(r.chars)} chars`,
    );
    console.log(
      `  llegaron al tope de iteraciones: ${r.maxIter} (${((r.maxIter / r.n) * 100).toFixed(1)}%)`,
    );
    console.log("");
  }

  // Turnos estratégicos ya instrumentados (si el rediseño está desplegado).
  const strategic = await ConversationMessage.aggregate([
    {
      $match: {
        role: "assistant",
        createdAt: { $gte: since },
        "agentMeta.strategic": { $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        n: { $sum: 1 },
        snapshotMs: { $avg: "$agentMeta.strategic.snapshotMs" },
        inTok: { $avg: "$agentMeta.inputTokens" },
        steps: { $avg: "$agentMeta.strategic.stepsProposed" },
        dropped: { $avg: "$agentMeta.strategic.stepsDropped" },
        forced: { $sum: { $cond: ["$agentMeta.strategic.forced", 1, 0] } },
        conPlan: {
          $sum: { $cond: [{ $gt: ["$agentMeta.strategic.stepsProposed", 0] }, 1, 0] },
        },
      },
    },
  ]);
  if (strategic.length > 0) {
    const s = strategic[0];
    console.log("=== TURNOS ESTRATÉGICOS ===\n");
    console.log(`  turnos: ${s.n} · con plan entregado: ${s.conPlan}`);
    console.log(`  foto de la propiedad: ${fmt(s.snapshotMs)} ms`);
    console.log(`  entrada: ${fmt(s.inTok)} tok`);
    console.log(
      `  pasos propuestos: ${(s.steps ?? 0).toFixed(1)} · descartados por validación: ${(s.dropped ?? 0).toFixed(1)}`,
    );
    console.log(
      `  hubo que forzar la tool: ${s.forced} (${((s.forced / s.n) * 100).toFixed(1)}%)` +
        (s.forced / s.n > 0.3
          ? "   ← alto: el modelo del tier no entrega el plan solo"
          : ""),
    );
    console.log("");
  }

  // Muestra de pedidos estratégicos reales, para el set de evaluación.
  const asked = await ConversationMessage.find(
    { role: "user", createdAt: { $gte: since }, content: { $regex: STRATEGIC_RE } },
    { content: 1, _id: 0 },
  )
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  console.log(`=== PEDIDOS ESTRATÉGICOS REALES (${asked.length}) ===`);
  console.log("Para el set de `eval:strategic`. Copiar los que sean genuinos.\n");
  for (const a of asked) {
    console.log(`· ${String(a.content).slice(0, 160).replace(/\s+/g, " ")}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
