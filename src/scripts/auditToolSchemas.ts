/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Audita los JSON Schema de las tools guardadas en la base contra lo que exigen
 * los proveedores mas estrictos.
 *
 * Anthropic aceptaba `{"type":"array"}` pelado; Google lo rechaza con
 * `parameters.properties[x].items: missing field` y se lleva puesto el turno
 * ENTERO — no la tool, el pedido completo, porque las declaraciones viajan
 * todas juntas. Este script dice cuantas y cuales antes de tocar nada.
 *
 *   npm run audit:tool-schemas
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { Tool } from "../modules/tools/tools.model";
import { collectSchemaDefects } from "../shared/llm/toolSchema";

async function main(): Promise<void> {
  await connectDB();
  const tools = await Tool.find({ status: "active" }).lean();

  let conDefectos = 0;
  let defectosTotales = 0;
  for (const t of tools as any[]) {
    const defectos = collectSchemaDefects({
      type: "object",
      properties: t.inputSchema?.properties ?? {},
      required: t.inputSchema?.required ?? [],
    });
    if (defectos.length === 0) continue;
    conDefectos++;
    defectosTotales += defectos.length;
    console.log(`  ${t.name}`);
    for (const d of defectos) console.log(`      ${d}`);
  }

  console.log(
    `\n${tools.length} tools activas · ${conDefectos} con defectos · ${defectosTotales} defectos en total`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("audit:tool-schemas error:", err);
  process.exit(1);
});
