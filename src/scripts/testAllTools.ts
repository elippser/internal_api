/* eslint-disable @typescript-eslint/no-explicit-any */
// Test E2E real: ejecuta TODAS las tools de lectura por el mismo path que usa
// el agente (executeTool -> mintAgentJwt -> pmsProxy -> servicio real).
// Encadena IDs de los listados para probar los "detail". Los writes/destructivos
// NO se ejecutan (solo se reportan). Contexto = Diplomatic Hotel (17 units).
import "dotenv/config";
import { connectDB } from "../shared/db";
import mongoose from "mongoose";
import { executeTool, ToolExecutionError } from "../modules/conversations/services/toolExecutor";
import { Tool } from "../modules/tools/tools.model";

// Contexto real: usuario admin con membership activa en la company de los units.
const CTX = {
  userId: "user-a0d6653c-0397-4ed9-82aa-ea4729ebd05a", // hcguitarras, admin, membership bd8cd057
  companyId: "elippser-bd8cd057-c7d9-42ac-8745-72195f5808b8",
  propertyId: "prop-59f127d5-271c-4e24-b025-94d848495482", // Diplomatic Hotel
  agentId: "agent-test",
  sessionId: "sess-test",
};

let pass = 0;
let failC = 0;
let empty = 0;
const failed: string[] = [];

function summarize(res: any): string {
  if (Array.isArray(res)) return `array(${res.length})`;
  if (res && typeof res === "object") {
    if (Array.isArray(res.data)) return `data[${res.data.length}]`;
    if (Array.isArray(res.units)) return `units[${res.units.length}]`;
    if (Array.isArray(res.items)) return `items[${res.items.length}]`;
    return `obj{${Object.keys(res).slice(0, 6).join(",")}}`;
  }
  return String(res);
}

function isEmpty(res: any): boolean {
  if (Array.isArray(res)) return res.length === 0;
  if (res && typeof res === "object") {
    for (const k of ["data", "units", "items", "reservations", "categories"]) {
      if (Array.isArray(res[k])) return res[k].length === 0;
    }
  }
  return false;
}

async function run(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  try {
    const res = await executeTool(tool, args, CTX);
    const e = isEmpty(res);
    if (e) {
      empty++;
      console.log(`  ⚠ ${tool} — VACIO (${summarize(res)})`);
    } else {
      pass++;
      console.log(`  ✓ ${tool} — ${summarize(res)}`);
    }
    return res;
  } catch (err) {
    failC++;
    const e = err as ToolExecutionError;
    const detail = e.kind ? `${e.kind}/${e.status}: ${e.message}` : (err as Error).message;
    console.log(`  ✗ ${tool} — ${detail}`);
    failed.push(`${tool}: ${detail}`);
    return null;
  }
}

function firstId(res: any, ...keys: string[]): string | undefined {
  const arr = Array.isArray(res) ? res : res?.data ?? res?.units ?? res?.items ?? [];
  const item = Array.isArray(arr) ? arr[0] : undefined;
  if (!item) return undefined;
  for (const k of keys) if (item[k]) return item[k];
  return undefined;
}

async function main() {
  await connectDB();
  const total = await Tool.countDocuments({ status: "active" });
  console.log(`\n=== TEST TODAS LAS TOOLS DE LECTURA (catalogo activo: ${total}) ===`);
  console.log(`ctx: company=${CTX.companyId.slice(0, 24)}… property=${CTX.propertyId.slice(0, 24)}…\n`);

  console.log("[PROPIEDADES]");
  await run("list_properties");
  await run("get_property_detail");
  await run("list_property_services");
  await run("list_property_amenities");
  await run("list_property_reviews");
  await run("list_property_galleries");
  await run("list_property_templates");

  console.log("\n[HABITACIONES] (el bug reportado)");
  const states = await run("get_room_states");
  const units = await run("list_units");
  const cats = await run("list_room_categories");
  const unitId = firstId(units, "unitId", "_id") || firstId(states, "unitId", "_id");
  const catId = firstId(cats, "categoryId", "_id");
  if (unitId) {
    await run("get_unit_detail", { unitId });
    await run("get_unit_history", { unitId });
  } else console.log("  · (sin unitId para detail/history)");
  if (catId) {
    await run("get_room_category_detail", { categoryId: catId });
    await run("get_category_model_audit");
  } else console.log("  · (sin categoryId)");

  console.log("\n[RESERVAS / MOTOR]");
  await run("check_availability", { checkIn: "2026-07-01", checkOut: "2026-07-03", adults: 2 });
  await run("get_availability_calendar", { from: "2026-07-01", to: "2026-07-10" });
  const resv = await run("get_reservations");
  await run("get_unassigned_reservations");
  await run("get_rate_plans");
  await run("get_promos");
  await run("get_engine_settings");
  await run("get_dashboard_report");
  await run("get_exchange_rate_preview", { base: "USD", currencies: "ARS" });
  const rid = firstId(resv, "reservationId", "_id", "id");
  if (rid) {
    await run("get_reservation_detail", { reservationId: rid });
    await run("get_reservation_services", { reservationId: rid });
  } else console.log("  · (sin reservationId para detail)");

  console.log("\n[ESPACIOS OPERATIVOS / INICIO]");
  const spaces = await run("list_operative_spaces");
  const spaceId = firstId(spaces, "spaceId", "operativeSpaceId", "_id");
  if (spaceId) {
    await run("get_operative_space", { spaceId });
    await run("get_my_space_permissions", { spaceId });
    await run("list_space_users", { spaceId });
    await run("list_dashboards", { spaceId });
    await run("get_active_dashboard", { spaceId });
  } else console.log("  · (sin spaceId)");

  console.log("\n[MARKETING — WEB BUILDER (Proyecto > Sitio > Pagina)]");
  const projects = await run("list_site_projects");
  const siteId = firstId(projects, "_id", "siteId");
  if (siteId) {
    const proj = await run("get_site_project", { siteId });
    await run("list_site_languages", { siteId });
    // subSite (Sitio) del proyecto
    const subs = (proj && (proj as any).sitesByLanguage) || [];
    const subSiteId = Array.isArray(subs) && subs[0] ? (subs[0]._id || subs[0].subSiteId) : undefined;
    if (subSiteId) {
      await run("get_site", { subSiteId, siteId });
      await run("list_site_pages", { subSiteId, siteId });
      await run("list_site_domains", { subSiteId, siteId });
    } else console.log("  · (proyecto sin subsitios)");
  } else console.log("  · (sin proyectos web)");
  await run("list_all_domains");
  await run("list_site_templates");
  await run("get_asset_library");
  await run("list_asset_folders");
  await run("list_asset_files");
  await run("get_review_stats");

  console.log("\n[AJUSTES / EQUIPO]");
  await run("get_company_profile");
  await run("list_my_companies");
  await run("list_company_users");
  await run("get_user_profile");
  await run("list_service_categories");
  await run("get_custom_catalog");
  await run("list_catalog_items");
  await run("list_notifications");

  console.log("\n[LECTURA CRUDA DE LA API (raw_read)]");
  await run("read_pms_core_api", { path: "/api/v1/properties" });
  await run("read_pms_core_api", { path: "/company/profile" });
  await run("read_booking_api", { path: "/api/v1/rate-plans" });
  await run("read_rooms_api", { path: `/api/v1/properties/${CTX.propertyId}/units/states` });
  // Escenario clave: el agente escanea TODAS las propiedades para encontrar la
  // que tiene inventario (lo que evita el falso "sistema vacio").
  const propsRaw = await run("read_pms_core_api", { path: "/api/v1/properties" });
  const propList = propsRaw?.data ?? propsRaw?.items ?? propsRaw ?? [];
  if (Array.isArray(propList) && propList.length) {
    let withInv = 0;
    for (const p of propList.slice(0, 10)) {
      const pid = p.propertyId || p._id;
      if (!pid) continue;
      try {
        const st: any = await executeTool("read_rooms_api", { path: `/api/v1/properties/${pid}/units/states` }, CTX);
        const n = Array.isArray(st) ? st.length : (st?.units?.length ?? 0);
        if (n > 0) { withInv++; console.log(`    · ${pid.slice(0, 18)}… → ${n} units`); }
      } catch { /* ignore */ }
    }
    console.log(`  ✓ scan propiedades: ${withInv}/${Math.min(propList.length, 10)} con inventario`);
  }

  console.log("\n=================================================");
  console.log(`RESULTADO: ${pass} OK · ${empty} VACIO · ${failC} FAIL`);
  if (failed.length) {
    console.log("\nFALLOS:");
    for (const f of failed) console.log(`  - ${f}`);
  }
  await mongoose.disconnect();
  process.exit(failC > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
