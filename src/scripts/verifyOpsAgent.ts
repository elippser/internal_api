/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verificacion de cableado del agente de operaciones.
 *
 *   npm run verify:ops-agent
 *
 * Reproduce EXACTAMENTE lo que el runtime del chat resuelve para un turno, sin
 * llamar al modelo (no gasta tokens). Recorre la cadena completa:
 *   resolveAgent -> version del motor -> tools efectivas -> habilidades -> prompt
 *
 * Por que existe: los seeds escriben en la coleccion `agents` (vieja) Y en la
 * version del motor. El chat lee SOLO la del motor. Cuando esas dos se separan,
 * nada falla — el agente simplemente pierde herramientas o instrucciones y
 * empieza a improvisar (a contestar por competidores con web_search, por
 * ejemplo). Este script hace visible esa deriva en una corrida.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { resolveAgent } from "../modules/conversations/services/agentResolver";
import { resolveTools, filterReadOnlyToolIds } from "../modules/conversations/services/toolExecutor";
import { resolveSkills, renderSkillsBlock, loadSkillBody } from "../engine/skills/resolver";
import { buildSystemPromptParts } from "../modules/conversations/services/promptAssembler";
import { routeTurn } from "../modules/conversations/services/taskRouter";
import {
  computeTurnToolAccess,
  renderPermissionsBlock,
} from "../modules/conversations/services/toolAccess";
import type { UserScope } from "../shared/agentAuth/userScope";

/** Fallos acumulados: el script sale con codigo 1 si hay alguno. */
const problems: string[] = [];

function check(label: string, ok: boolean): void {
  if (!ok) problems.push(label);
  console.log(`  ${ok ? "OK   " : "FALLA"} ${label}`);
}

async function main() {
  await connectDB();

  const agent = await resolveAgent("asistente-de-operaciones");
  if (!agent) throw new Error("agente no resuelto");
  if (agent.__source !== "engine") {
    problems.push(
      "el agente resuelve de la coleccion VIEJA, no del motor — corre: npm run migrate:agents -- --apply",
    );
  }

  console.log("=== AGENTE RESUELTO ===");
  console.log("  fuente:", agent.__source, "| version:", agent.__versionId);
  console.log("  modelo:", agent.modelOverride);
  console.log("  tools:", agent.enabledToolIds.length);
  console.log("  skills declaradas:", agent.skillNames.length, JSON.stringify(agent.skillNames));

  // --- Tools efectivas ---
  const tools = await resolveTools(agent.enabledToolIds);
  const names = new Set(tools.map((t) => t.name));
  console.log("\n=== TOOLS EFECTIVAS ===");
  console.log("  total resueltas:", tools.length);
  const must = [
    "list_competitors",
    "get_competitor_rates_grid",
    "discover_competitors",
    "update_compset",
    "get_revenue_dashboard",
    "get_pace_alerts",
    "get_pace_curve",
    "list_market_events",
    "list_pricing_rules",
    "list_rate_recommendations",
    "dry_run_pricing_rule",
    "read_rms_api",
    "write_rms_api",
    // Alcance completo (agosto 2026): reservas extras, marca, linkhub,
    // presencia online, builder extras, equipo, buscador.
    "search_reservations",
    "move_reservation",
    "create_unit_block",
    "set_day_restrictions",
    "update_property_brand",
    "get_linkhub_page",
    "publish_linkhub",
    "get_social_hub_overview",
    "update_gbp_profile",
    "publish_site_changes",
    "create_site_page",
    "update_company_user_access",
    "global_search",
  ];
  for (const m of must) {
    if (!names.has(m)) problems.push(`tool faltante en la version del motor: ${m}`);
    console.log(`  ${names.has(m) ? "OK  " : "FALTA"} ${m}`);
  }

  // Descripcion que ve el modelo para la tool del reclamo del usuario
  const lc = tools.find((t) => t.name === "list_competitors");
  console.log("\n  list_competitors.description:\n   ", lc?.description);

  // --- Ruteo del turno tipico del reclamo ---
  console.log("\n=== RUTEO ===");
  for (const q of [
    "quienes son mis competidores?",
    "mostrame el comp-set",
    "como venimos de revenue este mes?",
    "buscame hoteles cerca",
  ]) {
    const r = await routeTurn({ userMessage: q, enabledToolIds: agent.enabledToolIds });
    console.log(`  "${q}" -> ${r.subAgent.id} (${r.subAgent.model}) tools=${r.toolIds.length} [${r.reason}]`);
  }

  // Solo-lectura (sub-agente consulta): que las de revenue read sobrevivan
  const ro = await filterReadOnlyToolIds(agent.enabledToolIds);
  const roTools = await resolveTools(ro);
  const roNames = new Set(roTools.map((t) => t.name));
  console.log(`\n  solo-lectura: ${ro.length} tools · list_competitors=${roNames.has("list_competitors")} · discover_competitors=${roNames.has("discover_competitors")} (debe ser false: es write)`);

  // --- Habilidades ---
  console.log("\n=== HABILIDADES ===");
  const skills = await resolveSkills({
    tenantId: null,
    agentId: agent.agentId,
    userId: null,
    declared: agent.skillNames,
  });
  console.log("  resueltas:", skills.length);
  const block = renderSkillsBlock(skills);
  console.log("  --- bloque nivel 1 que va al prompt ---");
  console.log(block.split("\n").map((l) => "  " + l).join("\n"));

  const body = await loadSkillBody("comp-set-y-competencia", {
    tenantId: null,
    agentId: agent.agentId,
    userId: null,
    declared: agent.skillNames,
  });
  console.log(`\n  load_skill("comp-set-y-competencia") -> ok=${body.ok} bytes=${body.body?.length ?? 0}`);
  check("las 5 habilidades de revenue resuelven", skills.length === 5);
  check("load_skill devuelve el cuerpo", body.ok === true);
  check(
    "la habilidad de comp-set trae la regla de precedencia",
    /nunca `web_search`/i.test(body.body ?? ""),
  );

  // --- Permisos por usuario (política de acceso) ---
  // Simula dos alcances típicos y verifica que el filtrado de tools por turno
  // recorte lo que corresponde. La política en sí se testea en
  // test:access-policy (sin DB); acá se valida el cableado con el catálogo real.
  console.log("\n=== PERMISOS POR USUARIO ===");
  const ownerScope: UserScope = {
    userId: "u-owner", companyId: "c", role: "owner", isAdmin: true,
    capabilities: [] as any, allProperties: true, propertyIds: [], resolved: true, mustChangePassword: false,
  };
  const recepScope: UserScope = {
    userId: "u-staff", companyId: "c", role: "staff", isAdmin: false, capabilities: [],
    allProperties: true, propertyIds: [], resolved: true, mustChangePassword: false,
    space: { spaceId: "s", propertyId: "p", isAdmin: false, apps: [
      { appId: "todas-reservas", access: "operate" }, { appId: "panel-reservas", access: "operate" },
      { appId: "carga-manual", access: "operate" }, { appId: "estado-habitaciones", access: "operate" },
    ] },
  };
  const ownerAccess = await computeTurnToolAccess(agent.enabledToolIds, ownerScope);
  const recepAccess = await computeTurnToolAccess(agent.enabledToolIds, recepScope);
  console.log(`  owner: ${ownerAccess.allowedToolIds.length} tools, ${ownerAccess.denied.length} filtradas`);
  console.log(`  recepción: ${recepAccess.allowedToolIds.length} tools, ${recepAccess.denied.length} filtradas`);
  const recepDenied = new Set(recepAccess.denied.map((d) => d.name));
  const recepAllowedNames = new Set(
    (await resolveTools(recepAccess.allowedToolIds)).map((t) => t.name),
  );
  check("owner: ninguna tool filtrada", ownerAccess.denied.length === 0);
  check("recepción: conserva get_reservations", recepAllowedNames.has("get_reservations"));
  check("recepción: conserva update_reservation_status", recepAllowedNames.has("update_reservation_status"));
  check("recepción: conserva change_room_status", recepAllowedNames.has("change_room_status"));
  check("recepción: pierde create_rate_plan", recepDenied.has("create_rate_plan"));
  check("recepción: pierde get_revenue_dashboard", recepDenied.has("get_revenue_dashboard"));
  check("recepción: pierde update_company", recepDenied.has("update_company"));
  check("recepción: pierde publish_linkhub", recepDenied.has("publish_linkhub"));
  check("recepción: conserva write_booking_api (se valida por path)", recepAllowedNames.has("write_booking_api"));
  const permBlock = renderPermissionsBlock(recepScope, recepAccess, { propertyId: "p" });
  check("bloque de permisos menciona apps sin acceso", /Apps SIN acceso/.test(permBlock));
  console.log("  --- bloque de permisos (recepción) ---");
  console.log(permBlock.split("\n").slice(0, 8).map((l) => "  " + l).join("\n"));

  // --- Prompt final ---
  const session = {
    context: {
      userId: "u", companyId: "c", propertyId: "p",
      userRole: "admin", userName: "Sergio", propertyName: "Diplomatic Hotel",
    },
  };
  const { static: st, dynamic: dy } = buildSystemPromptParts(
    agent as any, session as any, [], [], block,
  );
  console.log("\n=== PROMPT ===");
  console.log("  static:", st.length, "chars | dynamic:", dy.length, "chars");
  check("seccion REVENUE en el prompt", /REVENUE \(Hub Revenue/.test(st));
  check("seccion PERMISOS en el prompt", /PERMISOS \(critico\)/.test(st));
  check("prompt menciona search_reservations", /search_reservations/.test(st));
  check("prompt menciona LinkHub", /LinkHub/.test(st));
  check("regla FUENTE DE VERDAD", /FUENTE DE VERDAD/.test(st));
  check("bloque de habilidades (nivel 1)", /Habilidades disponibles/.test(st));
  check(
    "regla anti web_search para competidores",
    /NUNCA contestes esa pregunta con resultados de web_search/.test(st),
  );

  console.log("\n=== RESULTADO ===");
  if (problems.length === 0) {
    console.log("  Todo cableado: el chat ve el RMS completo.");
  } else {
    console.log(`  ${problems.length} problema(s):`);
    for (const p of problems) console.log(`   - ${p}`);
  }

  await mongoose.disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
