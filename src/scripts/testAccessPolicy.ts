/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Test de la POLÍTICA DE ACCESO del agente (sin DB, sin modelo).
 *
 *   npm run test:access-policy
 *
 * Simula alcances de usuario típicos del PMS (owner, staff con apps acotadas,
 * viewer sin espacio, editor con sites.manage, membership acotada por
 * propiedades) y verifica que `evaluateAccess` / `checkToolCall` decidan igual
 * que la cadena authorize → requireCapability → requireSpaceAccess del PMS, y
 * que las escrituras que el PMS deja pasar (rutas de pms-core sólo con
 * authenticateJWT) queden detrás de la app/capability correcta.
 *
 * Sale con código 1 si alguna expectativa falla.
 */
import { evaluateAccess, findRouteRule } from "../shared/agentAuth/routePolicy";
import type { UserScope } from "../shared/agentAuth/userScope";
import { checkToolCall } from "../modules/conversations/services/toolAccess";
import { INITIAL_TOOLS } from "../modules/tools/tools.model";

let failures = 0;
function expect(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  OK    ${label}`);
  } else {
    failures++;
    console.log(`  FALLA ${label}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ""}`);
  }
}

const base = (over: Partial<UserScope>): UserScope => ({
  userId: "u1",
  companyId: "c1",
  role: "staff",
  isAdmin: false,
  capabilities: [],
  allProperties: true,
  propertyIds: [],
  resolved: true,
  mustChangePassword: false,
  ...over,
});

const OWNER = base({ role: "owner", isAdmin: true, capabilities: [
  "users.manage", "users.assign_spaces", "properties.create", "properties.edit", "properties.switch",
  "spaces.manage", "apps.toggle", "company.settings", "billing.manage", "sites.manage",
] as any });

// Recepcionista: espacio "Recepción" en la propiedad p1, opera reservas y
// habitaciones, ve tarifas sin escribir, sin revenue ni marketing.
const RECEPCION = base({
  role: "staff",
  space: {
    spaceId: "s1",
    propertyId: "p1",
    isAdmin: false,
    apps: [
      { appId: "panel-reservas", access: "operate" },
      { appId: "todas-reservas", access: "operate" },
      { appId: "carga-manual", access: "operate" },
      { appId: "tarifas", access: "operate" },
      { appId: "estado-habitaciones", access: "operate" },
      { appId: "disponibilidad", access: "write" },
    ],
  },
});

// Revenue manager: sólo revenue con escritura, en p1.
const REVENUE = base({
  role: "staff",
  space: { spaceId: "s2", propertyId: "p1", isAdmin: false, apps: [{ appId: "revenue", access: "write" }] },
});

// Viewer sin espacio activo.
const VIEWER = base({ role: "viewer" });

// Editor web: capability sites.manage, sin espacio.
const EDITOR = base({ role: "editor", capabilities: ["sites.manage"] as any });

// Staff acotado a la propiedad p2 (allProperties=false) con espacio en p2.
const ACOTADO = base({
  role: "staff",
  allProperties: false,
  propertyIds: ["p2"],
  space: { spaceId: "s3", propertyId: "p2", isAdmin: false, apps: [{ appId: "todas-reservas", access: "operate" }] },
});

const UNRESOLVED = base({ resolved: false, role: undefined });

console.log("=== Reglas de ruta ===");
expect("booking GET /reservations → todas-reservas:operate",
  findRouteRule("booking-app", "GET", "/api/v1/reservations")?.app?.ids.includes("todas-reservas") === true);
expect("booking PATCH charge → todas-reservas:write",
  findRouteRule("booking-app", "PATCH", "/api/v1/reservations/res-1/charge")?.app?.level === "write");
expect("booking GET /reservations/search → todas-reservas",
  findRouteRule("booking-app", "GET", "/api/v1/reservations/search")?.app?.ids.includes("todas-reservas") === true);
expect("rms POST dry-run → operate",
  findRouteRule("rms-app", "POST", "/api/v1/rms/rules/dry-run?propertyId=p1")?.app?.level === "operate");
expect("rms PATCH rule → write",
  findRouteRule("rms-app", "PATCH", "/api/v1/rms/rules/{ruleId}?propertyId={propertyId}")?.app?.level === "write");
expect("pms-core PUT /site-data/... → sites.manage",
  findRouteRule("pms-core", "PUT", "/site-data/update-meta/abc")?.capability?.includes("sites.manage") === true);
expect("pms-core PUT /company/:id → company.settings",
  findRouteRule("pms-core", "PUT", "/company/c1")?.capability?.includes("company.settings") === true);
expect("pms-core POST /api/v1/site-templates → deny",
  findRouteRule("pms-core", "POST", "/api/v1/site-templates")?.access === "deny");
expect("pms-core PATCH units/:id/status → estado-habitaciones:operate",
  findRouteRule("pms-core", "PATCH", "/api/v1/properties/p1/units/u1/status")?.app?.ids[0] === "estado-habitaciones");
expect("rooms GET units/states → member",
  findRouteRule("rooms-app", "GET", "/api/v1/properties/p1/units/states")?.access === "member");
expect("staypass POST /api/v1/auth/register → deny",
  findRouteRule("staypass", "POST", "/api/v1/auth/register")?.access === "deny");

console.log("\n=== Owner ===");
expect("owner escribe tarifas", evaluateAccess(OWNER, { service: "booking-app", method: "POST", path: "/api/v1/rate-plans", propertyId: "p1" }).allowed);
expect("owner escribe /site-data", evaluateAccess(OWNER, { service: "pms-core", method: "PUT", path: "/site-data/update-meta/x" }).allowed);
expect("owner escritura cruda desconocida pasa", evaluateAccess(OWNER, { service: "pms-core", method: "POST", path: "/algo/nuevo" }).allowed);
expect("owner NO puede /user/login (deny)", !evaluateAccess(OWNER, { service: "pms-core", method: "POST", path: "/user/login" }).allowed);
expect("owner NO puede DELETE property (owner sí)", evaluateAccess(OWNER, { service: "pms-core", method: "DELETE", path: "/api/v1/properties/p1" }).allowed);

console.log("\n=== Recepción (staff, apps acotadas) ===");
let d = evaluateAccess(RECEPCION, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p1" });
expect("lista reservas de su propiedad", d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "booking-app", method: "PATCH", path: "/api/v1/reservations/r1/status", propertyId: "p1" });
expect("check-in (status) → operate OK", d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "booking-app", method: "PATCH", path: "/api/v1/reservations/r1/charge", propertyId: "p1" });
expect("cobro requiere write → denegado", !d.allowed && d.code === "insufficient_app_access", d);
d = evaluateAccess(RECEPCION, { service: "booking-app", method: "POST", path: "/api/v1/rate-plans", propertyId: "p1" });
expect("crear tarifa con tarifas:operate → denegado", !d.allowed && d.code === "insufficient_app_access", d);
d = evaluateAccess(RECEPCION, { service: "booking-app", method: "PUT", path: "/api/v1/day-restrictions/bulk", propertyId: "p1" });
expect("cerrar fechas con disponibilidad:write → OK", d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "rms-app", method: "GET", path: "/api/v1/rms/dashboard?propertyId=p1", propertyId: "p1" });
expect("revenue sin app → denegado", !d.allowed && d.code === "insufficient_app_access", d);
d = evaluateAccess(RECEPCION, { service: "rooms-app", method: "PATCH", path: "/api/v1/properties/p1/units/u1/status", propertyId: "p1" });
expect("cambiar estado habitación → OK", d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "rooms-app", method: "POST", path: "/api/v1/properties/p1/categories", propertyId: "p1" });
expect("crear categoría sin gestion-categorias → denegado", !d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "PUT", path: "/company/c1" });
expect("editar empresa sin company.settings → denegado", !d.allowed && d.code === "missing_capability", d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "PUT", path: "/site-data/update-meta/x" });
expect("escribir en el builder sin sites.manage → denegado", !d.allowed && d.code === "missing_capability", d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "POST", path: "/asset-library/files/upload-base64" });
expect("subir a la librería sin app → denegado", !d.allowed && d.code === "insufficient_app_access", d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "GET", path: "/api/v1/properties/p1/galleries", propertyId: "p1" });
expect("leer galerías sin app galerias → denegado", !d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "POST", path: "/algo/nuevo" });
expect("escritura cruda desconocida (staff) → denegado", !d.allowed && d.code === "unknown_write", d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "GET", path: "/algo/nuevo" });
expect("lectura cruda desconocida (staff) → pasa (el PMS autoriza)", d.allowed, d);
d = evaluateAccess(RECEPCION, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p9" });
expect("reservas de OTRA propiedad que la del espacio → space_property_mismatch", !d.allowed && d.code === "space_property_mismatch", d);
d = evaluateAccess(RECEPCION, { service: "pms-core", method: "GET", path: "/user/profile" });
expect("perfil propio → OK", d.allowed, d);

console.log("\n=== Revenue manager ===");
d = evaluateAccess(REVENUE, { service: "rms-app", method: "POST", path: "/api/v1/rms/recommendations/x/accept?propertyId=p1", propertyId: "p1" });
expect("acepta recomendación → OK", d.allowed, d);
d = evaluateAccess(REVENUE, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p1" });
expect("no lista reservas → denegado", !d.allowed, d);

console.log("\n=== Viewer sin espacio ===");
d = evaluateAccess(VIEWER, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p1" });
expect("sin espacio activo → no_active_space", !d.allowed && d.code === "no_active_space", d);
d = evaluateAccess(VIEWER, { service: "pms-core", method: "GET", path: "/api/v1/properties" });
expect("lista propiedades → OK (rol viewer)", d.allowed, d);
d = evaluateAccess(VIEWER, { service: "pms-core", method: "PATCH", path: "/api/v1/properties/p1" });
expect("edita propiedad → denegado (rol)", !d.allowed && d.code === "insufficient_role", d);

console.log("\n=== Editor web ===");
d = evaluateAccess(EDITOR, { service: "pms-core", method: "PUT", path: "/site-data/update-meta/x" });
expect("editor escribe en el builder → OK", d.allowed, d);
d = evaluateAccess(EDITOR, { service: "pms-core", method: "GET", path: "/api/v1/properties" });
expect("editor NO lista propiedades (rol) → denegado", !d.allowed && d.code === "insufficient_role", d);

console.log("\n=== Membership acotada a p2 ===");
d = evaluateAccess(ACOTADO, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p2" });
expect("reservas de p2 → OK", d.allowed, d);
d = evaluateAccess(ACOTADO, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p1" });
expect("reservas de p1 → property_out_of_scope", !d.allowed && d.code === "property_out_of_scope", d);
d = evaluateAccess(ACOTADO, { service: "pms-core", method: "GET", path: "/api/v1/properties/p1" });
expect("detalle de p1 por path → property_out_of_scope", !d.allowed && d.code === "property_out_of_scope", d);

console.log("\n=== Alcance no resuelto ===");
d = evaluateAccess(UNRESOLVED, { service: "booking-app", method: "GET", path: "/api/v1/reservations", propertyId: "p1" });
expect("sin perfil → scope_unavailable", !d.allowed && d.code === "scope_unavailable", d);
d = evaluateAccess(UNRESOLVED, { service: "booking-app", method: "GET", path: "/api/v1/availability" });
expect("público sigue pasando", d.allowed, d);

console.log("\n=== checkToolCall sobre el catálogo ===");
const byName = new Map((INITIAL_TOOLS as any[]).map((t) => [t.name, t]));
const tool = (n: string) => {
  const t = byName.get(n);
  if (!t) throw new Error(`tool ${n} no está en INITIAL_TOOLS`);
  return t;
};
d = checkToolCall(tool("update_reservation_status"), { reservationId: "r1", status: "checked-in" }, RECEPCION, { propertyId: "p1" });
expect("recepción: update_reservation_status → OK", d.allowed, d);
d = checkToolCall(tool("create_rate_plan"), {}, RECEPCION, { propertyId: "p1" });
expect("recepción: create_rate_plan → denegado", !d.allowed, d);
d = checkToolCall(tool("get_revenue_dashboard"), {}, RECEPCION, { propertyId: "p1" });
expect("recepción: get_revenue_dashboard → denegado", !d.allowed, d);
d = checkToolCall(tool("write_pms_core_api"), { method: "PUT", path: "/company/c1", body: { name: "x" } }, RECEPCION, { propertyId: "p1" });
expect("recepción: write_pms_core_api PUT /company → denegado", !d.allowed && d.code === "missing_capability", d);
d = checkToolCall(tool("write_pms_core_api"), { method: "PUT", path: "/company/c1", body: { name: "x" } }, OWNER, { propertyId: "p1" });
expect("owner: write_pms_core_api PUT /company → OK", d.allowed, d);
d = checkToolCall(tool("write_booking_api"), { method: "PATCH", path: "/api/v1/reservations/r1/notes", body: {} }, RECEPCION, { propertyId: "p1" });
expect("recepción: write_booking_api notes → OK (operate)", d.allowed, d);
d = checkToolCall(tool("write_booking_api"), { method: "POST", path: "/api/v1/promos", body: {} }, RECEPCION, { propertyId: "p1" });
expect("recepción: write_booking_api promos → denegado", !d.allowed, d);
d = checkToolCall(tool("read_rms_api"), { path: "/api/v1/rms/dashboard" }, REVENUE, { propertyId: "p1" });
expect("revenue: read_rms_api → OK", d.allowed, d);
d = checkToolCall(tool("read_rms_api"), { path: "/api/v1/rms/dashboard", query: { propertyId: "p7" } }, REVENUE, { propertyId: "p1" });
expect("revenue: read_rms_api con otra propiedad → mismatch", !d.allowed && d.code === "space_property_mismatch", d);
d = checkToolCall(tool("update_company_user_access"), { userId: "u2", capabilities: [] }, RECEPCION, { propertyId: "p1" });
expect("recepción: update_company_user_access → denegado (users.manage)", !d.allowed && d.code === "missing_capability", d);
d = checkToolCall(tool("set_dashboard_theme"), { mode: "dark" }, VIEWER, {});
expect("viewer: set_dashboard_theme (ui) → OK", d.allowed, d);
d = checkToolCall(tool("publish_linkhub"), {}, RECEPCION, { propertyId: "p1" });
expect("recepción: publish_linkhub → denegado (rol admin)", !d.allowed, d);
d = checkToolCall(tool("publish_linkhub"), {}, OWNER, { propertyId: "p1" });
expect("owner: publish_linkhub → OK", d.allowed, d);
d = checkToolCall(tool("get_company_profile"), {}, ACOTADO, { propertyId: "p1" });
expect("acotado: get_company_profile (sin propiedad) → OK aunque la sesión apunte a p1", d.allowed, d);
d = checkToolCall(tool("get_room_states"), {}, ACOTADO, { propertyId: "p1" });
expect("acotado: get_room_states sobre p1 (sesión) → property_out_of_scope", !d.allowed && d.code === "property_out_of_scope", d);

// Todas las tools del catálogo tienen que resolver a una regla (o ser crudas/ui).
console.log("\n=== Cobertura de reglas sobre el catálogo ===");
const uncovered: string[] = [];
for (const t of INITIAL_TOOLS as any[]) {
  if (t.category === "ui_action" || t.execution.pathTemplate === "{path}") continue;
  const svc = t.execution.targetService;
  const rule = findRouteRule(svc, t.execution.method, t.execution.pathTemplate);
  if (!rule) uncovered.push(`${t.name} (${t.execution.method} ${svc}${t.execution.pathTemplate})`);
}
expect(`todas las tools específicas matchean una regla (${uncovered.length} sin regla)`, uncovered.length === 0, uncovered);

console.log(`\n=== RESULTADO: ${failures === 0 ? "todo OK" : failures + " fallo(s)"} ===`);
process.exit(failures === 0 ? 0 : 1);
