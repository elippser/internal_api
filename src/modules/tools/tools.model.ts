import { Schema, model, type InferSchemaType } from "mongoose";

export const TOOL_CATEGORIES = [
  "reservations_read",
  "reservations_write",
  "rooms_read",
  "rooms_write",
  "guests_read",
  "analytics_read",
  "property_read",
  "property_write",
  // Marketing: sitios web (proyectos), galerias, reseñas, libreria de archivos.
  "marketing_read",
  "marketing_write",
  // Ajustes / administracion: empresa, equipo/usuarios, espacios operativos,
  // dashboards (Inicio), catalogos, plantillas, notificaciones, servicios.
  "settings_read",
  "settings_write",
  // Revenue (rms-app, appId "revenue"): dataset analitico, pickup/booking pace,
  // comp-set y tarifas de competencia, eventos de mercado, reglas de pricing,
  // decisiones del motor y bandeja de recomendaciones.
  "revenue_read",
  "revenue_write",
  // Lectura cruda (GET) de cualquier endpoint de un microservicio. Cubre el
  // 100% de la API para lectura sin enumerar endpoint por endpoint.
  "raw_read",
  // Escritura cruda (POST/PATCH/PUT/DELETE) a cualquier endpoint. Cobertura
  // TOTAL de acciones; el PMS sigue aplicando authorize/membership real.
  "raw_write",
  // Acciones de UI ejecutadas en el CLIENTE (no pegan al backend): cambiar el
  // tema (claro/oscuro), navegar, etc. executeTool las corta y devuelve una
  // directiva que el chat (frontend) ejecuta.
  "ui_action",
] as const;

export const TARGET_SERVICES = [
  "booking-app",
  "rooms-app",
  "pms-core",
  "analytics",
  // staypass (public-side): huespedes y confirmaciones de reserva por email.
  "staypass",
  // rms-app: Hub Revenue. DB propia (bookfer_rms) y espacio operativo "revenue".
  "rms-app",
] as const;

export const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export const AUTH_STRATEGIES = ["staff_jwt", "internal_secret", "none"] as const;

// Roles del PMS — son los UserRole reales (pms-core/api User.role enum).
// `Tool.permissions.requiredRoles[]` SIEMPRE es subconjunto de estos cinco.
// Se usa para:
//   1) pre-check de UX en el runtime del agente antes de pegar al PMS
//   2) doc/UI del editor de tools en internal-laupser
// La autorizacion real la sigue haciendo el PMS via authorize(role) +
// membership check. Si el pre-check esta desactualizado, el PMS responde
// 403 y el runtime lo mapea a "permisos insuficientes" para el usuario.
//
// IMPORTANTE: estos roles son distintos de los de internal-laupser
// (super_admin > admin > developer > analyst > support), que gobiernan
// quien administra agentes/tools/KBs dentro del CRM.
export const PMS_USER_ROLES = [
  "owner",
  "admin",
  "staff",
  "viewer",
  "editor",
] as const;
export type PmsUserRole = (typeof PMS_USER_ROLES)[number];

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
export type TargetService = (typeof TARGET_SERVICES)[number];

const inputSchemaSchema = new Schema(
  {
    type: { type: String, default: "object" },
    properties: { type: Schema.Types.Mixed, default: {} },
    required: { type: [String], default: [] },
  },
  { _id: false },
);

const executionSchema = new Schema(
  {
    targetService: {
      type: String,
      enum: TARGET_SERVICES,
      required: true,
    },
    method: { type: String, enum: HTTP_METHODS, required: true },
    pathTemplate: { type: String, required: true },
    authStrategy: {
      type: String,
      enum: AUTH_STRATEGIES,
      default: "staff_jwt",
    },
    timeout: { type: Number, default: 10000 },
  },
  { _id: false },
);

const permissionsSchema = new Schema(
  {
    // Subconjunto de PMS_USER_ROLES (owner|admin|staff|viewer|editor).
    // Ver comentario en PMS_USER_ROLES arriba.
    requiredRoles: {
      type: [String],
      enum: PMS_USER_ROLES,
      default: ["owner", "admin", "staff"],
    },
    requiresConfirmation: { type: Boolean, default: false },
    isDestructive: { type: Boolean, default: false },
  },
  { _id: false },
);

const toolSchema = new Schema(
  {
    toolId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, enum: TOOL_CATEGORIES, required: true, index: true },
    inputSchema: { type: inputSchemaSchema, default: () => ({}) },
    execution: { type: executionSchema, required: true },
    permissions: { type: permissionsSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true, collection: "tools" },
);

export type ToolDoc = InferSchemaType<typeof toolSchema>;
export const Tool = model("Tool", toolSchema);

export function sanitizeTool(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, __v, ...rest } = obj;
  return rest;
}

// Helpers de inputSchema reutilizables.
const PROPERTY_PARAM = {
  propertyId: {
    type: "string",
    description:
      "ID de la propiedad. Si se omite se usa la propiedad activa del contexto.",
  },
};
const COMPANY_PARAM = {
  companyId: {
    type: "string",
    description:
      "ID de la company. Si se omite se usa la company activa del contexto.",
  },
};
function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return { type: "object" as const, properties, required };
}

const READ_ROLES = ["owner", "admin", "staff", "viewer"];
const WRITE_ROLES = ["owner", "admin", "staff"];
const CONFIG_ROLES = ["owner", "admin"];
const OWNER_ROLES = ["owner"];

// Catalogo completo de tools del agente de operaciones (bookfer-IA). Expone
// TODAS las funcionalidades operables de la plataforma, alineadas 1:1 con el menu
// del PMS:
//   - Inicio (dashboards/widgets de cada espacio operativo)
//   - Reservas (panel del dia, lista, carga manual, tarifas y disponibilidad,
//     promociones, servicios extra, asignacion de unidad, migraciones)
//   - Habitaciones (estado, plano/listado, categorias, alta masiva, auditoria)
//   - Propiedades (propiedades, espacios operativos y sus usuarios)
//   - Marketing (sitios web/proyectos, galerias, reseñas, libreria de archivos)
//   - Ajustes (empresa, equipo/usuarios, servicios, amenities, catalogos,
//     plantillas, notificaciones)
//   - Informes (KPIs/reportes)
//   - Revenue (rms-app: dataset analitico, pickup/booking pace, comp-set y
//     tarifas de competencia, eventos de mercado, reglas, decisiones del motor
//     y bandeja de recomendaciones)
// Paths verificados contra los routers reales de booking-app/rooms-app/pms-core/rms-app.
// Reads = acceso a informacion (sin confirmacion). Writes = acciones, casi todas
// con requiresConfirmation: true (el runtime pide confirmacion al usuario antes
// de ejecutar). isDestructive marca las irreversibles/sensibles.
//
// IMPORTANTE — autorizacion real: requiredRoles aca es solo un pre-check de UX.
// El enforcement real lo hace el PMS: el runtime mintea un JWT delegado con la
// identidad del usuario y el PMS corre authenticate -> authorize(role) ->
// membership/space-access. Si el usuario no tiene permiso, el PMS devuelve 403
// y el runtime lo traduce a "permisos insuficientes". Por eso es seguro exponer
// todo el catalogo a todos: cada usuario solo podra ejecutar lo que su rol real
// le habilita.
//
// Fuera de alcance a proposito (no son acciones de agente):
//   - Edicion granular de componentes de pagina del web-builder (PUT de
//     /site-data/.../pages/...): requieren arboles de componentes completos; se
//     manejan desde el editor visual (GDE). Se exponen CRUD de sitio y metadata.
//   - Flujo de huesped del motor (/motor/reservations) y endpoints publicos.
//   - Endpoints de test/debug, auth (login/register/reset) y webhooks internos.
export const INITIAL_TOOLS = [
  // ============================ RESERVAS (booking-app) ======================
  {
    toolId: "tool-001",
    name: "check_availability",
    displayName: "Consultar disponibilidad",
    category: "reservations_read",
    description:
      "Disponibilidad de habitaciones del motor para un rango de fechas (endpoint publico).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      checkIn: { type: "string", description: "Fecha check-in (YYYY-MM-DD)." },
      checkOut: { type: "string", description: "Fecha check-out (YYYY-MM-DD)." },
      adults: { type: "number", description: "Cantidad de adultos (default 1)." },
      children: { type: "number", description: "Cantidad de niños (default 0)." },
    }),
    execution: {
      targetService: "booking-app",
      method: "GET",
      pathTemplate: "/api/v1/availability",
      authStrategy: "none",
    },
    permissions: { requiredRoles: [], requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-013",
    name: "get_availability_calendar",
    displayName: "Calendario de disponibilidad",
    category: "reservations_read",
    description: "Calendario de disponibilidad por dia (vista operativa del staff).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde (YYYY-MM-DD)." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD)." },
    }, ["from", "to"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/availability/calendar" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-002",
    name: "get_reservations",
    displayName: "Listar reservas",
    category: "reservations_read",
    description:
      "Lista las reservas de la propiedad. Cada reserva trae un objeto `guest` con firstName, lastName y email. " +
      "Para BUSCAR una reserva por nombre, codigo, email, telefono o documento usa search_reservations (buscador del servidor); " +
      "esta tool NO filtra por nombre: si search_reservations no encuentra nada, llama esta SIN filtro y matchea vos en los resultados " +
      "(case-insensitive, tolera variantes). NUNCA digas que una reserva no existe sin haber buscado con search_reservations y revisado la lista. " +
      "Filtros validos (opcionales): status, checkIn, checkOut, guestId, channel.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      status: { type: "string", description: "Filtrar por status: pending, confirmed, checked-in, checked-out, cancelled, no-show (con guion)." },
      checkIn: { type: "string", description: "Filtrar por check-in (fecha ISO YYYY-MM-DD)." },
      checkOut: { type: "string", description: "Filtrar por check-out (fecha ISO YYYY-MM-DD)." },
      guestId: { type: "string", description: "ID del huesped (si ya lo conoces)." },
      channel: { type: "string", description: "Canal: direct, phone, ota." },
    }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reservations" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-014",
    name: "get_unassigned_reservations",
    displayName: "Reservas sin asignar",
    category: "reservations_read",
    description: "Lista las reservas que todavia no tienen unidad asignada.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reservations/unassigned" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-003",
    name: "get_reservation_detail",
    displayName: "Ver detalle de reserva",
    category: "reservations_read",
    description: "Detalle completo de una reserva por su ID.",
    inputSchema: obj({ reservationId: { type: "string", description: "ID de la reserva." } }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reservations/{reservationId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-015",
    name: "get_reservation_services",
    displayName: "Servicios de una reserva",
    category: "reservations_read",
    description: "Lista los servicios extra (spa, late check-out, etc.) de una reserva.",
    inputSchema: obj({ reservationId: { type: "string", description: "ID de la reserva." } }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reservations/{reservationId}/services" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-007",
    name: "create_reservation",
    displayName: "Crear reserva",
    category: "reservations_write",
    description:
      "Crea una reserva (carga manual / walk-in). Pedir al usuario huesped, fechas, categoria/unidad y monto si faltan.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      guestName: { type: "string" },
      guestEmail: { type: "string" },
      checkIn: { type: "string", description: "YYYY-MM-DD." },
      checkOut: { type: "string", description: "YYYY-MM-DD." },
      roomCategoryId: { type: "string" },
      unitId: { type: "string" },
      totalAmount: { type: "number" },
    }),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/reservations" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-008",
    name: "update_reservation_status",
    displayName: "Cambiar estado de reserva",
    category: "reservations_write",
    description:
      "Cambia el status de una reserva. Para hacer CHECK-IN usa status 'checked-in'; CHECK-OUT 'checked-out'; confirmar 'confirmed'; cancelar 'cancelled'. " +
      "Los valores van SIEMPRE con guion (no guion bajo). Primero obtene el reservationId (ej. listando con get_reservations y matcheando por guest).",
    inputSchema: obj({
      reservationId: { type: "string" },
      status: { type: "string", description: "Nuevo status (con guion): pending, confirmed, checked-in, checked-out, cancelled, no-show." },
    }, ["reservationId", "status"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/status" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-016",
    name: "assign_reservation_unit",
    displayName: "Asignar unidad a reserva",
    category: "reservations_write",
    description: "Asigna una unidad/habitacion especifica a una reserva.",
    inputSchema: obj({
      reservationId: { type: "string" },
      unitId: { type: "string", description: "ID de la unidad a asignar." },
    }, ["reservationId", "unitId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/assign-unit" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-017",
    name: "unassign_reservation_unit",
    displayName: "Desasignar unidad",
    category: "reservations_write",
    description: "Quita la unidad asignada de una reserva.",
    inputSchema: obj({ reservationId: { type: "string" } }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/unassign" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-018",
    name: "auto_assign_reservation",
    displayName: "Auto-asignar reserva",
    category: "reservations_write",
    description: "Re-evalua y asigna automaticamente la mejor unidad a una reserva.",
    inputSchema: obj({ reservationId: { type: "string" } }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/reservations/{reservationId}/auto-assign" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-019",
    name: "update_reservation_notes",
    displayName: "Editar notas de reserva",
    category: "reservations_write",
    description: "Actualiza las notas internas de una reserva. El campo es internalNotes.",
    inputSchema: obj({
      reservationId: { type: "string" },
      internalNotes: { type: "string", description: "Texto de las notas internas." },
    }, ["reservationId", "internalNotes"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/notes" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-020",
    name: "update_reservation_charge",
    displayName: "Ajustar monto de reserva",
    category: "reservations_write",
    description: "Ajusta el monto/cargo de una reserva. Accion sensible.",
    inputSchema: obj({
      reservationId: { type: "string" },
      amount: { type: "number", description: "Nuevo monto." },
    }, ["reservationId", "amount"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/charge" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-021",
    name: "add_reservation_service",
    displayName: "Agregar servicio a reserva",
    category: "reservations_write",
    description: "Agrega un servicio extra (spa, desayuno, late check-out) a una reserva.",
    inputSchema: obj({
      reservationId: { type: "string" },
      serviceId: { type: "string" },
      quantity: { type: "number" },
    }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/reservations/{reservationId}/services" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-022",
    name: "remove_reservation_service",
    displayName: "Quitar servicio de reserva",
    category: "reservations_write",
    description: "Elimina un servicio extra de una reserva.",
    inputSchema: obj({ reservationServiceId: { type: "string", description: "ID del servicio en la reserva." } }, ["reservationServiceId"]),
    execution: { targetService: "booking-app", method: "DELETE", pathTemplate: "/api/v1/reservations/services/{reservationServiceId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ============================ MOTOR: tarifas/promos/config ================
  {
    toolId: "tool-010",
    name: "get_rate_plans",
    displayName: "Ver tarifas",
    category: "reservations_read",
    description: "Lista los planes de tarifas del motor.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/rate-plans" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-023",
    name: "get_rate_plan_detail",
    displayName: "Detalle de tarifa",
    category: "reservations_read",
    description: "Detalle de un plan de tarifas por ID.",
    inputSchema: obj({ ratePlanId: { type: "string" } }, ["ratePlanId"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/rate-plans/{ratePlanId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-024",
    name: "create_rate_plan",
    displayName: "Crear tarifa",
    category: "reservations_write",
    description: "Crea un plan de tarifas. Requiere categoryId (de list_room_categories), nombre, vigencia y precio por noche.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      categoryId: { type: "string", description: "ID de la categoria a tarifar (obtener de list_room_categories)." },
      name: { type: "string" },
      startDate: { type: "string", description: "Inicio de vigencia (ISO YYYY-MM-DD)." },
      endDate: { type: "string", description: "Fin de vigencia (ISO, >= startDate)." },
      pricePerNight: { type: "number", description: "Precio por noche." },
      currency: { type: "string", description: "ARS, USD, EUR o BRL. Default USD." },
    }, ["categoryId", "name", "startDate", "endDate", "pricePerNight"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/rate-plans" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-025",
    name: "update_rate_plan",
    displayName: "Editar tarifa",
    category: "reservations_write",
    description: "Actualiza un plan de tarifas.",
    inputSchema: obj({ ratePlanId: { type: "string" } }, ["ratePlanId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/rate-plans/{ratePlanId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-011",
    name: "get_promos",
    displayName: "Ver promociones",
    category: "reservations_read",
    description: "Lista las promociones del motor.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/promos" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-026",
    name: "create_promo",
    displayName: "Crear promocion",
    category: "reservations_write",
    description: "Crea una promocion. Requiere name, type (auto|code), discountType (percentage|fixed_amount|price_override) y discountValue. Si type='code', tambien code.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      name: { type: "string", description: "Nombre de la promo." },
      type: { type: "string", description: "'auto' (se aplica sola) o 'code' (requiere codigo)." },
      code: { type: "string", description: "Codigo de la promo (requerido si type='code')." },
      discountType: { type: "string", description: "percentage | fixed_amount | price_override." },
      discountValue: { type: "number", description: "Valor del descuento (ej. 10 para 10%)." },
      currency: { type: "string", description: "Moneda (3 letras) si discountType=fixed_amount/price_override." },
    }, ["name", "type", "discountType", "discountValue"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/promos" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-027",
    name: "toggle_promo",
    displayName: "Activar/desactivar promocion",
    category: "reservations_write",
    description: "Activa o desactiva una promocion.",
    inputSchema: obj({ promoId: { type: "string" } }, ["promoId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/promos/{promoId}/toggle" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-012",
    name: "get_engine_settings",
    displayName: "Ver configuracion del motor",
    category: "property_read",
    description: "Configuracion del motor de reservas de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/engine-settings" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-028",
    name: "update_engine_settings",
    displayName: "Editar configuracion del motor",
    category: "property_write",
    description:
      "Actualiza la configuracion del motor de reservas. Accion sensible. " +
      "Aca vive el EMAIL DE AVISOS del hotel (hotelNotificationEmail): la casilla que recibe el aviso de cada reserva nueva " +
      "y a la que le llegan las respuestas del huesped. No hay SMTP por hotel: los mails al huesped salen siempre de " +
      "reservations@bookfer.com. Si piden 'configurar el email del hotel', es esta tool.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      hotelNotificationEmail: { type: "string", description: "Casilla del hotel que recibe los avisos de reserva nueva y las respuestas del huesped." },
      guestEmailNotificationsEnabled: { type: "boolean", description: "Si el huesped recibe email al confirmarse la reserva." },
      confirmationMode: { type: "string", description: "guest_email (confirma el huesped por email) o manual (confirma el hotel)." },
    }),
    execution: { targetService: "booking-app", method: "PUT", pathTemplate: "/api/v1/engine-settings" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-029",
    name: "get_dashboard_report",
    displayName: "Reporte / KPIs del hotel",
    category: "analytics_read",
    description: "Reporte de KPIs del panel (ocupacion, ingresos, llegadas/salidas).",
    inputSchema: obj({ ...PROPERTY_PARAM, dateFrom: { type: "string" }, dateTo: { type: "string" } }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reports/dashboard" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ============================ HABITACIONES (rooms-app) ====================
  {
    toolId: "tool-004",
    name: "get_room_states",
    displayName: "Ver estado de habitaciones",
    category: "rooms_read",
    description:
      "Estado actual de todas las habitaciones de la propiedad ACTIVA. Si devuelve vacio, NO concluyas que el hotel no tiene habitaciones: la sesion puede estar apuntando a otra propiedad. Verifica con list_properties cual propiedad tiene inventario y confirma con el usuario antes de afirmar que esta vacio.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/units/states" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-030",
    name: "list_units",
    displayName: "Listar habitaciones/unidades",
    category: "rooms_read",
    description:
      "Lista las unidades (habitaciones) de la propiedad ACTIVA. Si devuelve vacio, puede ser que la sesion apunte a una propiedad sin inventario: usa list_properties y confirma cual propiedad usar antes de decir que no hay habitaciones.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/units" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-031",
    name: "get_unit_detail",
    displayName: "Detalle de unidad",
    category: "rooms_read",
    description: "Detalle de una unidad por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, unitId: { type: "string" } }, ["unitId"]),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/units/{unitId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-032",
    name: "get_unit_history",
    displayName: "Historial de unidad",
    category: "rooms_read",
    description: "Historial de cambios de estado de una unidad.",
    inputSchema: obj({ ...PROPERTY_PARAM, unitId: { type: "string" } }, ["unitId"]),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/units/{unitId}/history" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-009",
    name: "change_room_status",
    displayName: "Cambiar estado de habitacion",
    category: "rooms_write",
    description: "Cambia el status operativo de una habitacion. El valor de status DEBE ser uno de estos (en ingles, exactos): available (disponible), occupied (ocupada), cleaning (limpieza), maintenance (mantenimiento), blocked (bloqueada), checkout-pending. Transiciones validas desde available: occupied/cleaning/maintenance/blocked.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      unitId: { type: "string" },
      status: { type: "string", description: "Status exacto en ingles: available | occupied | cleaning | maintenance | blocked | checkout-pending." },
    }, ["unitId", "status"]),
    execution: { targetService: "rooms-app", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/units/{unitId}/status" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-033",
    name: "create_unit",
    displayName: "Crear unidad",
    category: "rooms_write",
    description: "Crea una unidad/habitacion en el inventario. Pedir categoria y datos.",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" }, name: { type: "string" } }),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/units" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-034",
    name: "update_unit",
    displayName: "Editar unidad",
    category: "rooms_write",
    description: "Actualiza datos de una unidad.",
    inputSchema: obj({ ...PROPERTY_PARAM, unitId: { type: "string" } }, ["unitId"]),
    execution: { targetService: "rooms-app", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/units/{unitId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-035",
    name: "delete_unit",
    displayName: "Eliminar unidad",
    category: "rooms_write",
    description: "Elimina una unidad del inventario. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, unitId: { type: "string" } }, ["unitId"]),
    execution: { targetService: "rooms-app", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/units/{unitId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-036",
    name: "list_room_categories",
    displayName: "Listar categorias de habitacion",
    category: "rooms_read",
    description: "Lista las categorias de habitacion (tipos) de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/categories" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-037",
    name: "get_room_category_detail",
    displayName: "Detalle de categoria",
    category: "rooms_read",
    description: "Detalle de una categoria de habitacion por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" } }, ["categoryId"]),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/categories/{categoryId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-038",
    name: "create_room_category",
    displayName: "Crear categoria de habitacion",
    category: "rooms_write",
    description: "Crea una categoria/tipo de habitacion. Requiere name, capacity {adults, children} y basePrice {amount, currency}. modoVenta DEBE coincidir con el modelo de la propiedad: si create falla con 409 'modo unidad', reintenta con modoVenta='unidad' (podes ver el modo con get_category_model_audit -> propertyMode).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      name: { type: "string" },
      capacity: { type: "object", description: "Objeto { adults: number (>=1), children: number }. Ej: {\"adults\":2,\"children\":1}." },
      basePrice: { type: "object", description: "Objeto { amount: number, currency: string(3) }. Ej: {\"amount\":100,\"currency\":\"USD\"}." },
      description: { type: "string" },
      modoVenta: { type: "string", description: "'categoria' o 'unidad'. Debe coincidir con el modelo de la propiedad." },
    }, ["name", "capacity", "basePrice"]),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/categories" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-039",
    name: "update_room_category",
    displayName: "Editar categoria de habitacion",
    category: "rooms_write",
    description: "Actualiza una categoria de habitacion.",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" } }, ["categoryId"]),
    execution: { targetService: "rooms-app", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/categories/{categoryId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },

  // ============================ PROPIEDAD (pms-core) ========================
  {
    toolId: "tool-040",
    name: "list_properties",
    displayName: "Listar propiedades",
    category: "property_read",
    description: "Lista las propiedades de la company. Util para saber que propiedades tiene el hotel.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-041",
    name: "get_property_detail",
    displayName: "Detalle de propiedad",
    category: "property_read",
    description: "Datos completos de una propiedad (nombre, direccion, config general).",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-042",
    name: "list_property_services",
    displayName: "Servicios de la propiedad",
    category: "property_read",
    description: "Lista los servicios (spa, desayuno, etc.) configurados en la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/services" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-043",
    name: "list_property_amenities",
    displayName: "Amenities de la propiedad",
    category: "property_read",
    description: "Lista las amenities de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/amenities" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-044",
    name: "list_property_reviews",
    displayName: "Reseñas de la propiedad",
    category: "property_read",
    description: "Lista las reseñas/opiniones de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/reviews" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-045",
    name: "list_property_galleries",
    displayName: "Galerias de la propiedad",
    category: "property_read",
    description: "Lista las galerias de imagenes de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/galleries" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-046",
    name: "update_property",
    displayName: "Editar propiedad",
    category: "property_write",
    description: "Actualiza datos de la propiedad (nombre, direccion, etc.). Accion sensible.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-062",
    name: "create_property",
    displayName: "Crear propiedad",
    category: "property_write",
    description: "Crea una nueva propiedad en la company. Pedir nombre y datos basicos al usuario.",
    inputSchema: obj({ name: { type: "string" }, address: { type: "string" } }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-063",
    name: "update_property_status",
    displayName: "Cambiar estado de propiedad",
    category: "property_write",
    description: "Activa, pausa o archiva una propiedad (status general).",
    inputSchema: obj({ ...PROPERTY_PARAM, status: { type: "string", description: "Nuevo status: active, paused, archived." } }, ["status"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/status" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-064",
    name: "update_reservation_defaults",
    displayName: "Editar defaults de reservas",
    category: "property_write",
    description: "Actualiza los valores por defecto de reservas de la propiedad (check-in/out, politicas).",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/reservation-defaults" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-065",
    name: "apply_property_template",
    displayName: "Aplicar plantilla a propiedad",
    category: "property_write",
    description: "Aplica una plantilla de propiedad (preset de config). Sobrescribe ajustes. Pedir templateId.",
    inputSchema: obj({ ...PROPERTY_PARAM, templateId: { type: "string" } }, ["templateId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/apply-template" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-066",
    name: "delete_property",
    displayName: "Eliminar propiedad",
    category: "property_write",
    description: "Elimina una propiedad de la company. Accion irreversible y solo dueño.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}" },
    permissions: { requiredRoles: OWNER_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-067",
    name: "list_property_templates",
    displayName: "Listar plantillas de propiedad",
    category: "property_read",
    description: "Lista las plantillas de propiedad disponibles para aplicar.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/property-templates" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-068",
    name: "get_property_template",
    displayName: "Detalle de plantilla de propiedad",
    category: "property_read",
    description: "Detalle de una plantilla de propiedad por ID.",
    inputSchema: obj({ templateId: { type: "string" } }, ["templateId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/property-templates/{templateId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== ESPACIOS OPERATIVOS (pms-core) =====================
  {
    toolId: "tool-069",
    name: "list_operative_spaces",
    displayName: "Listar espacios operativos",
    category: "settings_read",
    description: "Lista los espacios operativos de la propiedad (recepcion, housekeeping, etc.).",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-070",
    name: "get_operative_space",
    displayName: "Detalle de espacio operativo",
    category: "settings_read",
    description: "Detalle de un espacio operativo por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-071",
    name: "create_operative_space",
    displayName: "Crear espacio operativo",
    category: "settings_write",
    description: "Crea un espacio operativo. Pedir nombre y tipo al usuario.",
    inputSchema: obj({ ...PROPERTY_PARAM, name: { type: "string" } }, ["name"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/spaces" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-072",
    name: "update_operative_space",
    displayName: "Editar espacio operativo",
    category: "settings_write",
    description: "Actualiza un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-073",
    name: "delete_operative_space",
    displayName: "Eliminar espacio operativo",
    category: "settings_write",
    description: "Elimina un espacio operativo. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-074",
    name: "update_space_integrations",
    displayName: "Editar integraciones de espacio",
    category: "settings_write",
    description: "Actualiza las integraciones de un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/integrations" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-075",
    name: "update_space_roles",
    displayName: "Editar roles de espacio",
    category: "settings_write",
    description: "Actualiza el mapeo de roles/permisos de un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/roles" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-076",
    name: "get_my_space_permissions",
    displayName: "Mis permisos en el espacio",
    category: "settings_read",
    description: "Devuelve los permisos del usuario actual en un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/permissions/me" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-077",
    name: "list_space_users",
    displayName: "Listar usuarios del espacio",
    category: "settings_read",
    description: "Lista los usuarios asignados a un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/users" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-078",
    name: "add_space_user",
    displayName: "Agregar usuario a espacio",
    category: "settings_write",
    description: "Asigna un usuario a un espacio operativo. Pedir userId y rol.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, userId: { type: "string" } }, ["spaceId", "userId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/users" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-079",
    name: "update_space_user",
    displayName: "Editar usuario de espacio",
    category: "settings_write",
    description: "Actualiza el rol/permiso de un usuario en un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, userId: { type: "string" } }, ["spaceId", "userId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/users/{userId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-080",
    name: "remove_space_user",
    displayName: "Quitar usuario de espacio",
    category: "settings_write",
    description: "Quita a un usuario de un espacio operativo.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, userId: { type: "string" } }, ["spaceId", "userId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/users/{userId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== INICIO / DASHBOARDS (pms-core) =====================
  {
    toolId: "tool-081",
    name: "list_dashboards",
    displayName: "Listar dashboards (Inicio)",
    category: "settings_read",
    description: "Lista los dashboards configurados de un espacio operativo (vista Inicio).",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-082",
    name: "get_active_dashboard",
    displayName: "Dashboard activo (Inicio)",
    category: "settings_read",
    description: "Devuelve el dashboard activo del espacio operativo (pantalla de Inicio).",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/active" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-083",
    name: "get_dashboard",
    displayName: "Detalle de dashboard",
    category: "settings_read",
    description: "Detalle de un dashboard por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, dashboardId: { type: "string" } }, ["spaceId", "dashboardId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/{dashboardId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-084",
    name: "create_dashboard",
    displayName: "Crear dashboard",
    category: "settings_write",
    description: "Crea un dashboard en el espacio operativo. Pedir nombre.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, name: { type: "string" } }, ["spaceId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-085",
    name: "update_dashboard",
    displayName: "Editar dashboard",
    category: "settings_write",
    description:
      "Actualiza un dashboard. Aca se PERSISTE el TEMA del dashboard: enviar { theme: { mode: 'dark'|'light'|'system', accentColor } }. Para cambiar a modo oscuro y que quede guardado: get_active_dashboard (para el dashboardId/spaceId) + esta tool con theme.mode='dark'. Para aplicarlo al instante en pantalla usa ademas set_dashboard_theme.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, dashboardId: { type: "string" } }, ["spaceId", "dashboardId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/{dashboardId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-086",
    name: "set_active_dashboard",
    displayName: "Activar dashboard",
    category: "settings_write",
    description: "Marca un dashboard como activo (Inicio).",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, dashboardId: { type: "string" } }, ["spaceId", "dashboardId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/active" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-087",
    name: "update_dashboard_widgets",
    displayName: "Editar widgets de dashboard",
    category: "settings_write",
    description: "Actualiza los widgets de un dashboard (layout de Inicio).",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, dashboardId: { type: "string" } }, ["spaceId", "dashboardId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/{dashboardId}/widgets" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-088",
    name: "delete_dashboard",
    displayName: "Eliminar dashboard",
    category: "settings_write",
    description: "Elimina un dashboard. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, spaceId: { type: "string" }, dashboardId: { type: "string" } }, ["spaceId", "dashboardId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/spaces/{spaceId}/dashboards/{dashboardId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== SERVICIOS / AMENITIES / CATEGORIAS (pms-core) ======
  {
    toolId: "tool-089",
    name: "create_service",
    displayName: "Crear servicio",
    category: "property_write",
    description: "Crea un servicio de la propiedad (spa, desayuno, etc.). El nombre es 'title'. Requiere categoryId (de list_service_categories), title, currency y chargeType.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      title: { type: "string", description: "Nombre/titulo del servicio. Requerido." },
      categoryId: { type: "string", description: "ID de categoria de servicio (de list_service_categories). Requerido." },
      chargeType: { type: "string", description: "Como se cobra: per_night | per_person | per_reservation | per_use. Requerido." },
      currency: { type: "string", description: "Moneda 3 letras (ej. USD). Requerido." },
      price: { type: "number", description: "Precio del servicio." },
      description: { type: "string" },
    }, ["title", "categoryId", "chargeType", "currency"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/services" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-090",
    name: "get_service",
    displayName: "Detalle de servicio",
    category: "property_read",
    description: "Detalle de un servicio de la propiedad por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, serviceId: { type: "string" } }, ["serviceId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/services/{serviceId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-091",
    name: "update_service",
    displayName: "Editar servicio",
    category: "property_write",
    description: "Actualiza un servicio de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM, serviceId: { type: "string" } }, ["serviceId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/services/{serviceId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-092",
    name: "delete_service",
    displayName: "Eliminar servicio",
    category: "property_write",
    description: "Elimina un servicio de la propiedad. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, serviceId: { type: "string" } }, ["serviceId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/services/{serviceId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-093",
    name: "link_service_room_category",
    displayName: "Vincular servicio a categoria",
    category: "property_write",
    description: "Vincula un servicio a una categoria de habitacion.",
    inputSchema: obj({ ...PROPERTY_PARAM, serviceId: { type: "string" }, categoryId: { type: "string" } }, ["serviceId", "categoryId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/api/v1/properties/{propertyId}/services/{serviceId}/category-links/{categoryId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-094",
    name: "list_service_categories",
    displayName: "Listar categorias de servicio",
    category: "property_read",
    description: "Lista las categorias de servicio de la company.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/service-categories" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-095",
    name: "create_service_category",
    displayName: "Crear categoria de servicio",
    category: "property_write",
    description: "Crea una categoria de servicio. Pedir nombre.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/service-categories" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-096",
    name: "update_service_category",
    displayName: "Editar categoria de servicio",
    category: "property_write",
    description: "Actualiza una categoria de servicio.",
    inputSchema: obj({ categoryId: { type: "string" } }, ["categoryId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/service-categories/{categoryId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-097",
    name: "delete_service_category",
    displayName: "Eliminar categoria de servicio",
    category: "property_write",
    description: "Elimina una categoria de servicio. Accion irreversible.",
    inputSchema: obj({ categoryId: { type: "string" } }, ["categoryId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/service-categories/{categoryId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-098",
    name: "create_amenity",
    displayName: "Crear amenity",
    category: "property_write",
    description: "Crea una amenity de la propiedad. El campo es title (no name) y type es requerido ('property' o 'room').",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      title: { type: "string", description: "Nombre/titulo de la amenity. Requerido." },
      type: { type: "string", description: "'property' (servicio del hotel) o 'room' (de habitacion). Requerido." },
      icon: { type: "string", description: "Icono (opcional)." },
    }, ["title", "type"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/amenities" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-099",
    name: "update_amenity",
    displayName: "Editar amenity",
    category: "property_write",
    description: "Actualiza una amenity de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM, amenityId: { type: "string" } }, ["amenityId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/amenities/{amenityId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-100",
    name: "delete_amenity",
    displayName: "Eliminar amenity",
    category: "property_write",
    description: "Elimina una amenity de la propiedad. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, amenityId: { type: "string" } }, ["amenityId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/amenities/{amenityId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== MARKETING: GALERIAS (pms-core) =====================
  {
    toolId: "tool-101",
    name: "get_gallery",
    displayName: "Detalle de galeria",
    category: "marketing_read",
    description: "Detalle de una galeria por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-102",
    name: "create_gallery",
    displayName: "Crear galeria",
    category: "marketing_write",
    description: "Crea una galeria de imagenes. El campo es title (no name).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      title: { type: "string", description: "Titulo de la galeria. Requerido." },
      description: { type: "string" },
    }, ["title"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/galleries" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-103",
    name: "update_gallery",
    displayName: "Editar galeria",
    category: "marketing_write",
    description: "Actualiza una galeria.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-104",
    name: "delete_gallery",
    displayName: "Eliminar galeria",
    category: "marketing_write",
    description: "Elimina una galeria. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-105",
    name: "reorder_galleries",
    displayName: "Reordenar galerias",
    category: "marketing_write",
    description: "Cambia el orden de las galerias.",
    inputSchema: obj({ ...PROPERTY_PARAM, order: { type: "array", description: "Lista de galleryId en el nuevo orden." } }),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/galleries/reorder" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-106",
    name: "list_gallery_media",
    displayName: "Listar media de galeria",
    category: "marketing_read",
    description: "Lista las imagenes/media de una galeria.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-107",
    name: "add_gallery_media",
    displayName: "Agregar media a galeria",
    category: "marketing_write",
    description: "Agrega una imagen/media a una galeria. Pedir URL de la imagen.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" }, url: { type: "string" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-108",
    name: "reorder_gallery_media",
    displayName: "Reordenar media de galeria",
    category: "marketing_write",
    description: "Cambia el orden de las imagenes de una galeria.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" }, order: { type: "array" } }, ["galleryId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media/reorder" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-109",
    name: "set_gallery_cover",
    displayName: "Definir portada de galeria",
    category: "marketing_write",
    description: "Marca una imagen como portada de la galeria.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" }, mediaId: { type: "string" } }, ["galleryId", "mediaId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media/{mediaId}/cover" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-110",
    name: "update_gallery_media",
    displayName: "Editar media de galeria",
    category: "marketing_write",
    description: "Actualiza datos de una imagen de galeria (alt, caption).",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" }, mediaId: { type: "string" } }, ["galleryId", "mediaId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media/{mediaId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-111",
    name: "delete_gallery_media",
    displayName: "Eliminar media de galeria",
    category: "marketing_write",
    description: "Elimina una imagen de una galeria. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, galleryId: { type: "string" }, mediaId: { type: "string" } }, ["galleryId", "mediaId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/galleries/{galleryId}/media/{mediaId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== MARKETING: RESEÑAS (pms-core) ======================
  {
    toolId: "tool-112",
    name: "get_review_stats",
    displayName: "Estadisticas de reseñas",
    category: "marketing_read",
    description: "Estadisticas agregadas de reseñas (rating promedio, distribucion).",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/reviews/stats" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-113",
    name: "get_review",
    displayName: "Detalle de reseña",
    category: "marketing_read",
    description: "Detalle de una reseña por ID.",
    inputSchema: obj({ ...PROPERTY_PARAM, reviewId: { type: "string" } }, ["reviewId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/reviews/{reviewId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-114",
    name: "create_review",
    displayName: "Crear reseña",
    category: "marketing_write",
    description: "Crea una reseña manual. Requiere authorName, rating y source (manual='own'). El texto de la reseña va en el campo 'text'.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      authorName: { type: "string", description: "Nombre del autor. Requerido." },
      rating: { type: "number", description: "Puntuacion 1-5. Requerido." },
      source: { type: "string", description: "Origen: own | google | booking | tripadvisor | airbnb | despegar | hotels | other. Manual usa 'own'. Requerido." },
      text: { type: "string", description: "Texto/comentario de la reseña." },
    }, ["authorName", "rating", "source"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/reviews" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-115",
    name: "update_review",
    displayName: "Editar reseña",
    category: "marketing_write",
    description: "Actualiza una reseña.",
    inputSchema: obj({ ...PROPERTY_PARAM, reviewId: { type: "string" } }, ["reviewId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/reviews/{reviewId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-116",
    name: "respond_review",
    displayName: "Responder reseña",
    category: "marketing_write",
    description: "Publica la respuesta del hotel a una reseña. Pedir el texto de la respuesta.",
    inputSchema: obj({ ...PROPERTY_PARAM, reviewId: { type: "string" }, response: { type: "string" } }, ["reviewId", "response"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/api/v1/properties/{propertyId}/reviews/{reviewId}/response" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-117",
    name: "delete_review",
    displayName: "Eliminar reseña",
    category: "marketing_write",
    description: "Elimina una reseña. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, reviewId: { type: "string" } }, ["reviewId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/reviews/{reviewId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-118",
    name: "import_reviews",
    displayName: "Importar reseñas",
    category: "marketing_write",
    description: "Importa reseñas desde una fuente externa (OTA, CSV).",
    inputSchema: obj({ ...PROPERTY_PARAM, source: { type: "string" } }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/reviews/import" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-119",
    name: "bulk_delete_reviews",
    displayName: "Eliminar reseñas en lote",
    category: "marketing_write",
    description: "Elimina varias reseñas a la vez. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, reviewIds: { type: "array", description: "Lista de reviewId a eliminar." } }, ["reviewIds"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/reviews/bulk-delete" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== MARKETING: LIBRERIA DE ARCHIVOS (pms-core) =========
  {
    toolId: "tool-120",
    name: "get_asset_library",
    displayName: "Ver libreria de archivos",
    category: "marketing_read",
    description: "Devuelve la libreria de archivos (root) de la company.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/asset-library" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-121",
    name: "list_asset_folders",
    displayName: "Listar carpetas de archivos",
    category: "marketing_read",
    description: "Lista las carpetas de la libreria de archivos.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/asset-library/folders" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-122",
    name: "create_asset_folder",
    displayName: "Crear carpeta de archivos",
    category: "marketing_write",
    description: "Crea una carpeta en la libreria de archivos. Pedir nombre.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/asset-library/folders" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-123",
    name: "get_asset_folder",
    displayName: "Detalle de carpeta",
    category: "marketing_read",
    description: "Detalle de una carpeta de la libreria por ID.",
    inputSchema: obj({ folderId: { type: "string" } }, ["folderId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/asset-library/folders/{folderId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-124",
    name: "update_asset_folder",
    displayName: "Editar carpeta de archivos",
    category: "marketing_write",
    description: "Renombra o actualiza una carpeta de la libreria.",
    inputSchema: obj({ folderId: { type: "string" }, name: { type: "string" } }, ["folderId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/asset-library/folders/{folderId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-125",
    name: "delete_asset_folder",
    displayName: "Eliminar carpeta de archivos",
    category: "marketing_write",
    description: "Elimina una carpeta de la libreria. Accion irreversible.",
    inputSchema: obj({ folderId: { type: "string" } }, ["folderId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/asset-library/folders/{folderId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-126",
    name: "list_asset_files",
    displayName: "Listar archivos",
    category: "marketing_read",
    description: "Lista los archivos de la libreria (opcionalmente por carpeta).",
    inputSchema: obj({ folderId: { type: "string", description: "Filtrar por carpeta." } }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/asset-library/files" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-127",
    name: "get_asset_file",
    displayName: "Detalle de archivo",
    category: "marketing_read",
    description: "Detalle de un archivo de la libreria por ID.",
    inputSchema: obj({ fileId: { type: "string" } }, ["fileId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/asset-library/files/{fileId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-128",
    name: "create_asset_file",
    displayName: "Registrar archivo",
    category: "marketing_write",
    description: "Registra un archivo en la libreria (metadata + URL). Pedir nombre y URL.",
    inputSchema: obj({ name: { type: "string" }, url: { type: "string" }, folderId: { type: "string" } }, ["url"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/asset-library/files" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-129",
    name: "update_asset_file",
    displayName: "Editar archivo",
    category: "marketing_write",
    description: "Actualiza metadata de un archivo (nombre, carpeta).",
    inputSchema: obj({ fileId: { type: "string" } }, ["fileId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/asset-library/files/{fileId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-130",
    name: "delete_asset_file",
    displayName: "Eliminar archivo",
    category: "marketing_write",
    description: "Elimina un archivo de la libreria. Accion irreversible.",
    inputSchema: obj({ fileId: { type: "string" } }, ["fileId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/asset-library/files/{fileId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== MARKETING: WEB BUILDER (pms-core) ==================
  // MODELO CONCEPTUAL (importante): la jerarquia del builder es
  //   PROYECTO (doc Site)  >  SITIO (subSite / variante)  >  PAGINA (page)
  // En el codigo/DB del PMS el doc top-level se llama "site" (= Proyecto) y cada
  // variante se llama "subSite" (= Sitio). Las tools y el chat usan SIEMPRE los
  // terminos de negocio: Proyecto / Sitio / Pagina. Un PROYECTO agrupa uno o mas
  // SITIOS; cada SITIO tiene su dominio, idioma, estado y sus PAGINAS.
  {
    toolId: "tool-131",
    name: "list_site_projects",
    displayName: "Listar sitios web",
    category: "marketing_read",
    description:
      "Lista los SITIOS web de la company (aplanados): cada uno con su portada (cover), titulo, dominio, idioma, estado, cantidad de paginas, subSiteId y el siteId del proyecto que lo contiene. Es la misma data de la vista /projects del PMS. El chat renderiza estas cards con imagen y link a /projects/<subSiteId>: NO pegues URLs ni listas manuales, referite a las cards.",
    inputSchema: obj({ ...COMPANY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/company/{companyId}/subsites" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-132",
    name: "get_site_project",
    displayName: "Ver proyecto web",
    category: "marketing_read",
    description:
      "Detalle de un PROYECTO web por su siteId: incluye sus SITIOS (subsitios) con dominio/idioma/estado y sus PAGINAS.",
    inputSchema: obj({ siteId: { type: "string", description: "ID del proyecto (siteId)." } }, ["siteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/{siteId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-133",
    name: "get_site",
    displayName: "Ver sitio (subsitio)",
    category: "marketing_read",
    description:
      "Detalle de un SITIO (subsitio) dentro de un proyecto: dominio, idioma, estado, portada/favicon, SEO (title/description/socialPreview), GEO (aiDiscovery) y sus PAGINAS. Requiere subSiteId y el siteId del proyecto. El chat renderiza este detalle como card (imagen, SEO, GEO) con link a /projects/<subSiteId>: no pegues URLs manuales.",
    inputSchema: obj({
      subSiteId: { type: "string", description: "ID del sitio (subSiteId)." },
      siteId: { type: "string", description: "ID del proyecto (siteId) que lo contiene." },
    }, ["subSiteId", "siteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-203",
    name: "list_site_pages",
    displayName: "Listar paginas de un sitio",
    category: "marketing_read",
    description:
      "Lista las PAGINAS de un SITIO (subsitio) con su data reducida (nombre, estado, ruta). Requiere subSiteId y siteId.",
    inputSchema: obj({
      subSiteId: { type: "string", description: "ID del sitio (subSiteId)." },
      siteId: { type: "string", description: "ID del proyecto (siteId)." },
    }, ["subSiteId", "siteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/all-site-reduced-data/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-204",
    name: "list_site_domains",
    displayName: "Listar dominios de un sitio",
    category: "marketing_read",
    description:
      "Lista los DOMINIOS (custom hostnames / CNAME) de un SITIO (subsitio), con su estado de verificacion DNS. Requiere subSiteId y siteId.",
    inputSchema: obj({
      subSiteId: { type: "string", description: "ID del sitio (subSiteId)." },
      siteId: { type: "string", description: "ID del proyecto (siteId)." },
    }, ["subSiteId", "siteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/custom-hostnames/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-205",
    name: "list_all_domains",
    displayName: "Listar todos los dominios",
    category: "marketing_read",
    description:
      "Registro global de DOMINIOS (custom hostnames) de la company, con su estado. Util para ver todos los dominios configurados de un vistazo.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/custom-hostnames/registry/all" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-134",
    name: "create_site_project",
    displayName: "Crear proyecto web",
    category: "marketing_write",
    description: "Crea un nuevo PROYECTO web (con su primer sitio). Pedir nombre y plantilla si aplica.",
    inputSchema: obj({ ...COMPANY_PARAM, name: { type: "string" } }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/site-data/create-site" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-135",
    name: "update_site_metadata",
    displayName: "Editar metadata del proyecto",
    category: "marketing_write",
    description: "Actualiza la metadata del PROYECTO (titulo, descripcion, SEO).",
    inputSchema: obj({ siteId: { type: "string", description: "ID del proyecto (siteId)." } }, ["siteId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/update-meta/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-136",
    name: "list_site_languages",
    displayName: "Listar idiomas del proyecto",
    category: "marketing_read",
    description: "Lista las variantes de idioma (sitios) de un PROYECTO web.",
    inputSchema: obj({ siteId: { type: "string", description: "ID del proyecto (siteId)." } }, ["siteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/{siteId}/languages" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-137",
    name: "delete_site_project",
    displayName: "Eliminar proyecto web",
    category: "marketing_write",
    description: "Elimina un PROYECTO web completo (incluye sus sitios y dominios). Accion irreversible.",
    inputSchema: obj({ siteId: { type: "string", description: "ID del proyecto (siteId)." } }, ["siteId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/site-data/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-138",
    name: "list_site_templates",
    displayName: "Listar plantillas de sitio",
    category: "marketing_read",
    description: "Lista las plantillas de sitio web disponibles.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/site-templates" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-139",
    name: "get_site_template",
    displayName: "Detalle de plantilla de sitio",
    category: "marketing_read",
    description: "Detalle de una plantilla de sitio por ID.",
    inputSchema: obj({ templateId: { type: "string" } }, ["templateId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/site-templates/{templateId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== AJUSTES: EMPRESA / EQUIPO (pms-core) ===============
  {
    toolId: "tool-140",
    name: "get_company_profile",
    displayName: "Ver perfil de empresa",
    category: "settings_read",
    description: "Datos de la company activa (perfil, configuracion general).",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/company/profile" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-141",
    name: "list_my_companies",
    displayName: "Listar mis empresas",
    category: "settings_read",
    description: "Lista las companies a las que pertenece el usuario.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/company/my-companies" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-142",
    name: "update_company",
    displayName: "Editar empresa",
    category: "settings_write",
    description: "Actualiza datos de la company (nombre, datos fiscales). Accion sensible.",
    inputSchema: obj({ ...COMPANY_PARAM }),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/company/{companyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-143",
    name: "list_company_users",
    displayName: "Listar equipo / usuarios",
    category: "settings_read",
    description: "Lista los usuarios (equipo) de la company.",
    inputSchema: obj({ ...COMPANY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/company/{companyId}/users" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-144",
    name: "invite_company_user",
    displayName: "Invitar usuario",
    category: "settings_write",
    description: "Invita a un usuario a la company. Pedir email y rol.",
    inputSchema: obj({ ...COMPANY_PARAM, email: { type: "string" }, role: { type: "string" } }, ["email"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/company/{companyId}/invite" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-145",
    name: "update_company_user_role",
    displayName: "Cambiar rol de usuario",
    category: "settings_write",
    description: "Cambia el rol de un usuario en la company. Accion sensible.",
    inputSchema: obj({ ...COMPANY_PARAM, userId: { type: "string" }, role: { type: "string" } }, ["userId", "role"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/company/{companyId}/users/{userId}/role" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-146",
    name: "update_company_user_status",
    displayName: "Cambiar estado de usuario",
    category: "settings_write",
    description: "Activa o desactiva un usuario de la company.",
    inputSchema: obj({ ...COMPANY_PARAM, userId: { type: "string" }, status: { type: "string" } }, ["userId", "status"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/company/{companyId}/users/{userId}/status" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-147",
    name: "remove_company_user",
    displayName: "Quitar usuario de empresa",
    category: "settings_write",
    description: "Quita a un usuario de la company. Accion irreversible.",
    inputSchema: obj({ ...COMPANY_PARAM, userId: { type: "string" } }, ["userId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/company/{companyId}/users/{userId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-148",
    name: "get_user_profile",
    displayName: "Ver mi perfil",
    category: "settings_read",
    description: "Datos del perfil del usuario actual.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/user/profile" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== AJUSTES: CATALOGO CUSTOM (pms-core) ================
  {
    toolId: "tool-149",
    name: "get_custom_catalog",
    displayName: "Ver catalogo custom",
    category: "settings_read",
    description: "Devuelve el catalogo custom de la company.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/custom-catalog" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-150",
    name: "list_catalog_items",
    displayName: "Listar items del catalogo",
    category: "settings_read",
    description: "Lista los items del catalogo custom.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/custom-catalog/items" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-151",
    name: "create_catalog_item",
    displayName: "Crear item de catalogo",
    category: "settings_write",
    description: "Crea un item en el catalogo custom. Pedir datos.",
    inputSchema: obj({ name: { type: "string" } }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/custom-catalog/items" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-152",
    name: "update_catalog_item",
    displayName: "Editar item de catalogo",
    category: "settings_write",
    description: "Actualiza un item del catalogo custom.",
    inputSchema: obj({ itemId: { type: "string" } }, ["itemId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/custom-catalog/items/{itemId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-153",
    name: "delete_catalog_item",
    displayName: "Eliminar item de catalogo",
    category: "settings_write",
    description: "Elimina un item del catalogo custom. Accion irreversible.",
    inputSchema: obj({ itemId: { type: "string" } }, ["itemId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/custom-catalog/items/{itemId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== NOTIFICACIONES (pms-core) =========================
  {
    toolId: "tool-154",
    name: "list_notifications",
    displayName: "Listar notificaciones",
    category: "settings_read",
    description: "Lista las notificaciones del usuario/company.",
    inputSchema: obj({}),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/notifications" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-155",
    name: "mark_notifications_read",
    displayName: "Marcar notificaciones leidas",
    category: "settings_write",
    description: "Marca notificaciones como leidas.",
    inputSchema: obj({ ids: { type: "array", description: "Lista de notificationId. Vacio = todas." } }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/notifications/mark-read" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== RESERVAS / MOTOR: extras (booking-app) =============
  {
    toolId: "tool-156",
    name: "delete_rate_plan",
    displayName: "Eliminar tarifa",
    category: "reservations_write",
    description: "Elimina un plan de tarifas. Accion irreversible.",
    inputSchema: obj({ ratePlanId: { type: "string" } }, ["ratePlanId"]),
    execution: { targetService: "booking-app", method: "DELETE", pathTemplate: "/api/v1/rate-plans/{ratePlanId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-157",
    name: "get_promo_detail",
    displayName: "Detalle de promocion",
    category: "reservations_read",
    description: "Detalle de una promocion por ID.",
    inputSchema: obj({ promoId: { type: "string" } }, ["promoId"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/promos/{promoId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-158",
    name: "update_promo",
    displayName: "Editar promocion",
    category: "reservations_write",
    description: "Actualiza una promocion.",
    inputSchema: obj({ promoId: { type: "string" } }, ["promoId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/promos/{promoId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-159",
    name: "delete_promo",
    displayName: "Eliminar promocion",
    category: "reservations_write",
    description: "Elimina una promocion. Accion irreversible.",
    inputSchema: obj({ promoId: { type: "string" } }, ["promoId"]),
    execution: { targetService: "booking-app", method: "DELETE", pathTemplate: "/api/v1/promos/{promoId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-160",
    name: "initialize_availability",
    displayName: "Inicializar disponibilidad",
    category: "reservations_write",
    description: "Crea los documentos de disponibilidad del motor (carga masiva). Config.",
    inputSchema: obj({ ...PROPERTY_PARAM, from: { type: "string" }, to: { type: "string" } }),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/availability/initialize" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-161",
    name: "sync_availability",
    displayName: "Resincronizar disponibilidad",
    category: "reservations_write",
    description: "Resincroniza la disponibilidad del motor desde rooms-app.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/availability/sync/{propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-162",
    name: "get_exchange_rate_preview",
    displayName: "Preview de tipo de cambio",
    category: "reservations_read",
    description:
      "Preview de tipos de cambio para tarifas/migracion. Requiere la moneda base (ej. USD) y la lista de monedas destino.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      base: { type: "string", description: "Moneda base, codigo ISO (ej. USD, ARS). Requerido." },
      currencies: { type: "string", description: "Monedas destino separadas por coma (ej. ARS,BRL)." },
      rateType: { type: "string", description: "Tipo de cambio: blue, oficial, etc. Default blue." },
    }, ["base"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/exchange-rates/preview" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== HABITACIONES: extras (rooms-app) ===================
  {
    toolId: "tool-163",
    name: "delete_room_category",
    displayName: "Eliminar categoria de habitacion",
    category: "rooms_write",
    description: "Elimina una categoria de habitacion. Accion irreversible.",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" } }, ["categoryId"]),
    execution: { targetService: "rooms-app", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/categories/{categoryId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-164",
    name: "preview_bulk_units",
    displayName: "Preview de alta masiva de unidades",
    category: "rooms_read",
    description: "Previsualiza la creacion masiva de unidades en una categoria (sin aplicar).",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" }, count: { type: "number" } }, ["categoryId"]),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/categories/{categoryId}/units/bulk/preview" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-165",
    name: "bulk_create_units",
    displayName: "Alta masiva de unidades",
    category: "rooms_write",
    description: "Crea varias unidades de golpe en una categoria. Pedir cantidad.",
    inputSchema: obj({ ...PROPERTY_PARAM, categoryId: { type: "string" }, count: { type: "number" } }, ["categoryId", "count"]),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/categories/{categoryId}/units/bulk" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-166",
    name: "migrate_category_base_prices",
    displayName: "Migrar precios base de categorias",
    category: "rooms_write",
    description: "Aplica una migracion masiva de precios base a las categorias. Accion sensible.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/categories/migrate-prices" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-167",
    name: "get_category_model_audit",
    displayName: "Auditar modelo de categorias",
    category: "rooms_read",
    description: "Audita la consistencia del modelo de categorias/unidades de la propiedad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/model-audit" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-168",
    name: "auto_correct_category_model",
    displayName: "Auto-corregir modelo de categorias",
    category: "rooms_write",
    description: "Aplica correcciones automaticas al modelo de categorias/unidades. Accion sensible.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/model-audit/auto-correct" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ========================= REVENUE / RMS (rms-app) ========================
  // Hub Revenue: mide la demanda real del motor, arma el dataset diario,
  // compara contra el comp-set, evalua reglas y empuja tarifas al motor.
  //
  // CONVENCION DE PATHS: todas las rutas del RMS resuelven la property con
  // `?propertyId=` (o el OS activo del JWT). Por eso el propertyId viaja SIEMPRE
  // en el pathTemplate como `?propertyId={propertyId}` y nunca en el body: los
  // schemas Joi de escritura son `.unknown(false)` y un propertyId inyectado en
  // el cuerpo los rompe con 400. buildPath consume el arg, asi que declararlo en
  // el inputSchema es seguro y permite apuntar a otra property.
  //
  // Casi todas estas tools rinden tarjetas/graficos en el chat (KPIs, curvas de
  // pace, grilla de comp-set, bandeja de recomendaciones): tras llamarlas no hace
  // falta repetir los numeros en texto — resumi y referencia la tarjeta.
  {
    toolId: "tool-300",
    name: "get_revenue_dashboard",
    displayName: "Dashboard de revenue",
    category: "revenue_read",
    description:
      "Foto completa del periodo en UNA llamada: summary (ocupacion, ADR, RevPAR, share directo/OTA, conversion), serie diaria, " +
      "distribucion de booking window y las ultimas filas del dataset. Es la tool por defecto para 'como venimos', 'como estuvo el mes', " +
      "'dame los numeros'. Rinde KPIs + grafico en el chat.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio del periodo (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin del periodo (YYYY-MM-DD)." },
      table_limit: { type: "number", description: "Filas del dataset a incluir (default 25)." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/dashboard?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-301",
    name: "get_revenue_summary",
    displayName: "Resumen de revenue del periodo",
    category: "revenue_read",
    description:
      "Solo los agregados del periodo (revenue total/directo/OTA, noches vendidas, ocupacion, ADR, RevPAR, LOS medio, " +
      "tasa de cancelacion, conversion, ventana de reserva promedio). Usar cuando alcanza con los totales.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin (YYYY-MM-DD)." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/summary?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-302",
    name: "get_revenue_daily",
    displayName: "Serie diaria de revenue",
    category: "revenue_read",
    description:
      "Una fila por dia con ocupacion, ADR, RevPAR, revenue, reservas, cancelaciones, busquedas y pickup 7/30. " +
      "Es la fuente para hablar de TENDENCIA (que dias caen, donde esta el pico). Rinde un grafico de lineas en el chat.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin (YYYY-MM-DD)." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/daily?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-303",
    name: "get_revenue_booking_window",
    displayName: "Ventana de reserva (anticipacion)",
    category: "revenue_read",
    description:
      "Distribucion de las reservas por anticipacion (buckets de dias entre la reserva y el check-in), con cantidad de reservas y noches. " +
      "Responde 'con cuanta anticipacion reservan'. Rinde un grafico de barras.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin (YYYY-MM-DD)." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/booking-window?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-304",
    name: "get_revenue_dataset",
    displayName: "Dataset analitico crudo",
    category: "revenue_read",
    description:
      "Filas crudas del dataset diario con busqueda, filtros por columna, orden y paginado. Usar SOLO cuando hagan falta los datos fila por fila " +
      "(el resto de las veces alcanza get_revenue_dashboard). Mantene limit <= 50: son filas anchas y saturan el contexto.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin (YYYY-MM-DD)." },
      search: { type: "string", description: "Busqueda libre." },
      order_by: { type: "string", description: "Columna de orden (ej. snapshot_date, adr_usd)." },
      order_dir: { type: "string", description: "asc o desc." },
      limit: { type: "number", description: "Filas a devolver (recomendado <= 50)." },
      offset: { type: "number", description: "Desplazamiento para paginar." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/dataset?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-305",
    name: "get_revenue_config",
    displayName: "Configuracion del RMS",
    category: "revenue_read",
    description:
      "Config de revenue de la property: guardrails de tarifa (minRateUsd/maxRateUsd), autoApply, horizonte en dias, umbral de recomendacion, " +
      "comp-set configurado, ubicacion, perfil del hotel, config de eventos y de pace. Leerla ANTES de proponer cambios de configuracion.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/config?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-306",
    name: "get_pace_overview",
    displayName: "Pace y pickup de hoy",
    category: "revenue_read",
    description:
      "Foto on-the-books por fecha de estadia: habitaciones vendidas, ocupacion, pickup de 7 y 30 dias, y el pace_index contra el benchmark propio " +
      "(status fast / slow / normal / no_benchmark). Es la tool para 'como venimos vendiendo', 'vamos atrasados?'. Rinde lista con semaforo.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde (YYYY-MM-DD). Opcional." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD). Opcional." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/snapshot-today?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-307",
    name: "get_pace_pickup",
    displayName: "Pickup de una fecha",
    category: "revenue_read",
    description:
      "Cuanto se vendio en los ultimos N dias para una fecha de estadia concreta: noches, revenue y reservas ganadas en la ventana. " +
      "Responde 'cuanto entro esta semana para el finde largo'.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      stayDate: { type: "string", description: "Fecha de estadia (YYYY-MM-DD)." },
      days: { type: "number", description: "Ventana en dias (default 7)." },
    }, ["stayDate"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/pickup?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-308",
    name: "get_pace_curve",
    displayName: "Curva de venta de una fecha",
    category: "revenue_read",
    description:
      "Curva completa de como se fue llenando una fecha de estadia (un punto por snapshot, con dias a la llegada y pickup diario) " +
      "MAS el benchmark por bucket de anticipacion. Rinde un grafico de lineas real vs. benchmark: usalo cuando el usuario pregunte POR QUE una fecha va lenta.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      stayDate: { type: "string", description: "Fecha de estadia (YYYY-MM-DD)." },
    }, ["stayDate"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/curve?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-309",
    name: "get_pace_alerts",
    displayName: "Alertas de pace",
    category: "revenue_read",
    description:
      "Fechas del horizonte que se despegaron del benchmark (venta lenta o acelerada) y merecen accion de pricing. " +
      "Buen punto de partida de cualquier revision de revenue. Rinde lista de alertas priorizadas.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde (YYYY-MM-DD). Opcional." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD). Opcional." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/alerts?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-310",
    name: "get_pace_benchmark",
    displayName: "Benchmark de pace",
    category: "revenue_read",
    description:
      "Curva de referencia propia (ocupacion media ya vendida a cada bucket de anticipacion), filtrable por dia de semana, mes y bucket. " +
      "`generic: true` significa que todavia no hay muestra propia y se esta usando la curva generica de la industria: decilo explicitamente.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      dayOfWeek: { type: "number", description: "0=domingo .. 6=sabado. Opcional." },
      month: { type: "number", description: "1-12. Opcional." },
      dtaBucket: { type: "string", description: "Bucket de anticipacion: 0-3, 4-7, 8-14, 15-30, 31-60, 61-90 o 90+." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/benchmark?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-311",
    name: "get_demand_signals_summary",
    displayName: "Resumen de señales de demanda",
    category: "revenue_read",
    description:
      "Señales externas resumidas: tipo de cambio de los mercados emisores (con variacion a 30 dias) e interes en Wikipedia del destino " +
      "(media 7d vs. 7d previos + serie). Contexto de por que sube o baja la demanda. Rinde chips + sparkline.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/signals/summary?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-312",
    name: "list_demand_signals",
    displayName: "Señales de demanda crudas",
    category: "revenue_read",
    description:
      "Señales externas fila por fila. type: fx_rate, wikipedia_pageviews, gdelt_mention, earthquake o weather_alert. " +
      "Usar solo si hace falta el detalle; para hablar del contexto alcanza get_demand_signals_summary.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      type: { type: "string", description: "fx_rate | wikipedia_pageviews | gdelt_mention | earthquake | weather_alert." },
      from: { type: "string", description: "Desde (YYYY-MM-DD)." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD)." },
      limit: { type: "number", description: "Maximo de filas (default 500)." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/pace/signals?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-313",
    name: "list_pricing_rules",
    displayName: "Listar reglas de pricing",
    category: "revenue_read",
    description:
      "Reglas de pricing configuradas, en orden de evaluacion. Cada una es 'si <variable> <operador> <referencia> entonces <accion>' " +
      "acotada por ventana de anticipacion (minBW/maxBW). Leerlas SIEMPRE antes de crear una nueva: el orden importa y la primera que matchea define la accion.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/rules?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-314",
    name: "list_pricing_decisions",
    displayName: "Decisiones del motor de reglas",
    category: "revenue_read",
    description:
      "Que decidio el motor para cada fecha del rango: inputs evaluados (ocupacion, demanda, disponibilidad, tarifas de competencia, pickup, " +
      "impacto de eventos), tarifa base, tarifa sugerida, indice K, reglas que matchearon, clamp aplicado y el log paso a paso. " +
      "Es la tool para explicar POR QUE el sistema sugirio una tarifa.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      start_date: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      end_date: { type: "string", description: "Fin (YYYY-MM-DD)." },
    }, ["start_date", "end_date"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/decisions?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-315",
    name: "list_rate_recommendations",
    displayName: "Bandeja de recomendaciones de tarifa",
    category: "revenue_read",
    description:
      "Recomendaciones de cambio de tarifa con fecha, tarifa actual, sugerida, delta % y motivo. status: suggested (pendientes), accepted, " +
      "rejected, applied, expired, superseded. Sin status trae todas. Rinde tarjetas con botones Aceptar / Rechazar en el chat.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      status: { type: "string", description: "suggested | accepted | rejected | applied | expired | superseded." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/recommendations?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-316",
    name: "list_market_events",
    displayName: "Eventos de mercado",
    category: "revenue_read",
    description:
      "Eventos que mueven la demanda cerca del hotel (recitales, deportes, ferias, feriados, vacaciones escolares) con fecha, venue, distancia, " +
      "impacto esperado 0-100, relevancia 0-1 y estado (suggested / approved / dismissed). Solo los approved pesan en el motor de reglas. Rinde lista con badges.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      status: { type: "string", description: "suggested | approved | dismissed." },
      category: { type: "string", description: "music | sports | arts_theater | festival | conference | holiday | school_break | other." },
      from: { type: "string", description: "Desde (YYYY-MM-DD)." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD)." },
      highlightedOnly: { type: "string", description: "'true' para solo los destacados (relevancia sobre el umbral)." },
      includeInactive: { type: "string", description: "'true' para incluir pasados/ocultos." },
      sort: { type: "string", description: "relevance o date." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/events?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-317",
    name: "list_competitors",
    displayName: "Competidores del comp-set",
    category: "revenue_read",
    description:
      "Competidores externos cargados para la property: nombre, tarifa manual, distancia en km, score de similitud, estrellas, gama, " +
      "cantidad de habitaciones y si vino por descubrimiento automatico o carga manual. Rinde tarjetas en el chat.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      includeInactive: { type: "string", description: "'true' para incluir los desactivados." },
    }),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/external-competitors?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-318",
    name: "get_competitor_rates_grid",
    displayName: "Grilla de tarifas de la competencia",
    category: "revenue_read",
    description:
      "Tarifas de cada competidor por fecha en el rango, con promedio, minimo y maximo por competidor. Es la tool para 'como estamos contra la competencia'. " +
      "Rinde un grafico comparativo. Maximo de dias acotado por el backend: pedi rangos de hasta ~60 dias.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde (YYYY-MM-DD)." },
      to: { type: "string", description: "Hasta (YYYY-MM-DD)." },
      includeInactive: { type: "string", description: "'true' para incluir competidores desactivados." },
    }, ["from", "to"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/external-competitors/rates?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-319",
    name: "get_compset_rates",
    displayName: "Tarifas de properties del comp-set (bookfer)",
    category: "revenue_read",
    description:
      "BAR por fecha de properties de LA PLATAFORMA usadas como comp-set (no de competidores externos). property_ids es una lista separada por comas. " +
      "Para competidores externos usa get_competitor_rates_grid.",
    inputSchema: obj({
      property_ids: { type: "string", description: "IDs de property separados por coma (ej. 'abc,def')." },
      start: { type: "string", description: "Desde (YYYY-MM-DD)." },
      end: { type: "string", description: "Hasta (YYYY-MM-DD)." },
      currency: { type: "string", description: "Moneda ISO de 3 letras. Opcional." },
    }, ["property_ids", "start", "end"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "/api/v1/rms/compset-rates" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-320",
    name: "dry_run_pricing_rule",
    displayName: "Simular una regla de pricing",
    category: "revenue_read",
    description:
      "Simula una regla SIN guardarla: devuelve en que fechas del horizonte hubiera matcheado y con que valor. No modifica nada. " +
      "USALA SIEMPRE antes de create_pricing_rule y mostra el resultado al usuario: es la diferencia entre proponer una regla y adivinarla.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      variable: { type: "string", description: "occupancy | demand | availability | competitor_1..competitor_5 | pickup_7d | pickup_30d | event_impact_score | days_to_event | pace_index." },
      operator: { type: "string", description: "gt | gte | eq | lte | lt." },
      reference: { type: "number", description: "Valor de referencia contra el que se compara." },
      action: { type: "object", description: "{ type: 'adjust_pct', value: <numero> } o { type: 'set_rate_plan', ratePlanId: '<id>' }." },
      minBW: { type: "number", description: "Anticipacion minima en dias (0-540). Opcional." },
      maxBW: { type: "number", description: "Anticipacion maxima en dias (0-540). Opcional." },
    }, ["variable", "operator", "reference", "action"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/rules/dry-run?propertyId={propertyId}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ── Revenue: escritura ────────────────────────────────────────────────────
  // Todo lo que mueve tarifas reales del motor pide confirmacion. isDestructive
  // queda para lo irreversible (borrar reglas, eventos, competidores, tarifas).
  {
    toolId: "tool-330",
    name: "accept_rate_recommendation",
    displayName: "Aceptar recomendacion de tarifa",
    category: "revenue_write",
    description:
      "Acepta una recomendacion pendiente: la tarifa sugerida pasa a aplicarse al motor de reservas como override. AFECTA PRECIOS REALES: " +
      "confirma con el usuario la fecha y el delta antes de ejecutar.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      recommendationId: { type: "string", description: "ID de la recomendacion (campo recommendationId)." },
    }, ["recommendationId"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/recommendations/{recommendationId}/accept?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-331",
    name: "reject_rate_recommendation",
    displayName: "Rechazar recomendacion de tarifa",
    category: "revenue_write",
    description: "Rechaza una recomendacion pendiente: no se aplica y queda resuelta con status rejected.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      recommendationId: { type: "string", description: "ID de la recomendacion." },
    }, ["recommendationId"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/recommendations/{recommendationId}/reject?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-332",
    name: "create_pricing_rule",
    displayName: "Crear regla de pricing",
    category: "revenue_write",
    description:
      "Crea una regla del motor. Simula antes con dry_run_pricing_rule y mostra el impacto. Las reglas se evaluan EN ORDEN: " +
      "si no pasas `order`, la nueva queda al final. AFECTA PRECIOS REALES.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      variable: { type: "string", description: "occupancy | demand | availability | competitor_1..competitor_5 | pickup_7d | pickup_30d | event_impact_score | days_to_event | pace_index." },
      operator: { type: "string", description: "gt | gte | eq | lte | lt." },
      reference: { type: "number", description: "Valor de referencia." },
      action: { type: "object", description: "{ type: 'adjust_pct', value: <numero> } o { type: 'set_rate_plan', ratePlanId: '<id>' }." },
      minBW: { type: "number", description: "Anticipacion minima en dias. Opcional." },
      maxBW: { type: "number", description: "Anticipacion maxima en dias. Opcional." },
      order: { type: "number", description: "Posicion en el orden de evaluacion. Opcional." },
      isActive: { type: "boolean", description: "Si nace activa (default true)." },
    }, ["variable", "operator", "reference", "action"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/rules?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-333",
    name: "update_pricing_rule",
    displayName: "Editar regla de pricing",
    category: "revenue_write",
    description:
      "Modifica una regla existente. Mandar SOLO los campos que cambian. Para desactivarla sin perderla: isActive false. AFECTA PRECIOS REALES.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      ruleId: { type: "string", description: "ID de la regla." },
      variable: { type: "string", description: "Nueva variable. Opcional." },
      operator: { type: "string", description: "Nuevo operador. Opcional." },
      reference: { type: "number", description: "Nueva referencia. Opcional." },
      action: { type: "object", description: "Nueva accion. Opcional." },
      minBW: { type: "number", description: "Nueva anticipacion minima. Opcional." },
      maxBW: { type: "number", description: "Nueva anticipacion maxima. Opcional." },
      order: { type: "number", description: "Nueva posicion. Opcional." },
      isActive: { type: "boolean", description: "Activar/desactivar. Opcional." },
    }, ["ruleId"]),
    execution: { targetService: "rms-app", method: "PATCH", pathTemplate: "/api/v1/rms/rules/{ruleId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-334",
    name: "delete_pricing_rule",
    displayName: "Eliminar regla de pricing",
    category: "revenue_write",
    description:
      "Borra una regla del motor. Irreversible. Si la idea es apagarla temporalmente, preferi update_pricing_rule con isActive false y ofrecelo primero.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      ruleId: { type: "string", description: "ID de la regla." },
    }, ["ruleId"]),
    execution: { targetService: "rms-app", method: "DELETE", pathTemplate: "/api/v1/rms/rules/{ruleId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-335",
    name: "reorder_pricing_rules",
    displayName: "Reordenar reglas de pricing",
    category: "revenue_write",
    description:
      "Cambia el orden de evaluacion. orderedIds es la lista COMPLETA de ruleId en el orden deseado. Cambia que regla gana ante un empate: AFECTA PRECIOS REALES.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      orderedIds: { type: "array", description: "Lista completa de ruleId en el orden deseado." },
    }, ["orderedIds"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/rules/reorder?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-336",
    name: "update_revenue_config",
    displayName: "Configurar guardrails del RMS",
    category: "revenue_write",
    description:
      "Cambia los limites del motor: minRateUsd/maxRateUsd (piso y techo de tarifa), autoApply (si aplica solo o deja recomendacion), " +
      "horizonDays, recommendationThresholdPct e isActive. autoApply true = el motor mueve tarifas sin intervencion humana: confirmalo explicitamente.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      minRateUsd: { type: "number", description: "Piso de tarifa en USD (null para quitarlo)." },
      maxRateUsd: { type: "number", description: "Techo de tarifa en USD (null para quitarlo)." },
      autoApply: { type: "boolean", description: "Aplicar automaticamente sin pasar por la bandeja." },
      horizonDays: { type: "number", description: "Horizonte de evaluacion en dias (1-540)." },
      recommendationThresholdPct: { type: "number", description: "Delta minimo (%) para generar recomendacion." },
      isActive: { type: "boolean", description: "Motor activo o pausado." },
    }),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/config?propertyId={propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-337",
    name: "update_pace_config",
    displayName: "Configurar umbrales de pace",
    category: "revenue_write",
    description:
      "Bandas del pace_index: fastThreshold (1-3), slowThreshold (0.1-1, debe ser menor que fast), minSampleSize y el articulo de Wikipedia " +
      "del destino para la señal de interes.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      fastThreshold: { type: "number", description: "Sobre este indice, la fecha va 'rapida' (1-3)." },
      slowThreshold: { type: "number", description: "Bajo este indice, va 'lenta' (0.1-1)." },
      minSampleSize: { type: "number", description: "Minimo de fechas comparables para confiar en el benchmark." },
      wikipediaArticle: { type: "string", description: "Titulo del articulo de Wikipedia del destino." },
    }),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/config/pace?propertyId={propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-338",
    name: "recalc_pace_benchmark",
    displayName: "Recalcular benchmark de pace",
    category: "revenue_write",
    description:
      "Fuerza el recalculo del benchmark propio con los snapshots acumulados (ademas del job semanal). Util despues de cargar historico.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/pace/benchmark/recalc?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-339",
    name: "refresh_demand_signals",
    displayName: "Refrescar señales de demanda",
    category: "revenue_write",
    description: "Vuelve a traer las señales externas (FX, Wikipedia) de la property ahora mismo, sin esperar al cron.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/pace/signals/refresh?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-340",
    name: "sync_market_events",
    displayName: "Sincronizar eventos de mercado",
    category: "revenue_write",
    description:
      "Dispara el sync manual de eventos de la property (ademas del cron diario). Devuelve cuantos se trajeron, upsertearon y desactivaron. " +
      "Responde 429 si ya corrio hace menos de un minuto: en ese caso decilo y no reintentes en loop.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/events/sync?propertyId={propertyId}", timeout: 30000 },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-341",
    name: "create_market_event",
    displayName: "Cargar evento de mercado",
    category: "revenue_write",
    description:
      "Carga a mano un evento que el hotelero conoce y las fuentes no traen (una boda grande, un congreso local). Nace aprobado, " +
      "asi que pesa en el motor de reglas desde el momento en que se crea. Sin endDate se toma como evento de un dia.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      title: { type: "string", description: "Nombre del evento." },
      category: { type: "string", description: "music | sports | arts_theater | festival | conference | holiday | school_break | other." },
      startDate: { type: "string", description: "Inicio (YYYY-MM-DD)." },
      endDate: { type: "string", description: "Fin (YYYY-MM-DD). Opcional." },
      venue: { type: "string", description: "Lugar. Opcional." },
      externalUrl: { type: "string", description: "URL de referencia. Opcional." },
      expectedImpactScore: { type: "number", description: "Impacto esperado 0-100 (default 50)." },
    }, ["title", "category", "startDate"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/events?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-342",
    name: "update_market_event",
    displayName: "Editar evento de mercado",
    category: "revenue_write",
    description:
      "Modifica un evento (tipicamente para corregir el impacto esperado o las fechas). Mandar solo los campos que cambian. " +
      "Cambiar expectedImpactScore mueve la evaluacion de las reglas que usan event_impact_score.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      eventId: { type: "string", description: "ID del evento." },
      title: { type: "string", description: "Nuevo titulo. Opcional." },
      category: { type: "string", description: "Nueva categoria. Opcional." },
      startDate: { type: "string", description: "Nuevo inicio (YYYY-MM-DD). Opcional." },
      endDate: { type: "string", description: "Nuevo fin (YYYY-MM-DD). Opcional." },
      venue: { type: "string", description: "Nuevo lugar. Opcional." },
      externalUrl: { type: "string", description: "Nueva URL. Opcional." },
      expectedImpactScore: { type: "number", description: "Nuevo impacto 0-100. Opcional." },
      active: { type: "boolean", description: "Mostrar u ocultar. Opcional." },
    }, ["eventId"]),
    execution: { targetService: "rms-app", method: "PATCH", pathTemplate: "/api/v1/rms/events/{eventId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-343",
    name: "approve_market_event",
    displayName: "Aprobar evento de mercado",
    category: "revenue_write",
    description:
      "Pasa un evento sugerido a aprobado. Solo los aprobados alimentan las variables event_impact_score y days_to_event del motor: " +
      "aprobar un evento cambia las tarifas que el motor sugiere para esas fechas.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      eventId: { type: "string", description: "ID del evento." },
    }, ["eventId"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/events/{eventId}/approve?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-344",
    name: "dismiss_market_event",
    displayName: "Descartar evento de mercado",
    category: "revenue_write",
    description: "Descarta un evento sugerido: deja de aparecer y no pesa en el motor. Reversible con approve_market_event.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      eventId: { type: "string", description: "ID del evento." },
    }, ["eventId"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/events/{eventId}/dismiss?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-345",
    name: "delete_market_event",
    displayName: "Eliminar evento de mercado",
    category: "revenue_write",
    description:
      "Borra un evento. Los manuales se borran fisicamente (irreversible); los que vinieron de una fuente quedan descartados e inactivos " +
      "para que el proximo sync no los reviva. Si solo hay que sacarlo de la vista, ofrece dismiss_market_event.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      eventId: { type: "string", description: "ID del evento." },
    }, ["eventId"]),
    execution: { targetService: "rms-app", method: "DELETE", pathTemplate: "/api/v1/rms/events/{eventId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-346",
    name: "update_events_config",
    displayName: "Configurar modulo de eventos",
    category: "revenue_write",
    description:
      "Radio de busqueda en km, categorias habilitadas, dias de lookahead, umbral de relevancia, pesos por categoria, feeds iCal y " +
      "ubicacion manual de la property. Cambiar radio/pesos/umbral RE-PUNTUA todos los eventos vigentes.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      radiusKm: { type: "number", description: "Radio de busqueda (1-200)." },
      enabledCategories: { type: "array", description: "Categorias habilitadas." },
      lookaheadDays: { type: "number", description: "Dias hacia adelante (7-540)." },
      relevanceThreshold: { type: "number", description: "Umbral de relevancia 0-1 para destacar." },
      categoryWeights: { type: "object", description: "Peso 0-1 por categoria." },
      icsFeeds: { type: "array", description: "Feeds iCal: [{ url, label, category }]." },
      lat: { type: "number", description: "Latitud manual de la property." },
      lng: { type: "number", description: "Longitud manual." },
      countryCode: { type: "string", description: "Codigo de pais ISO de 2 letras." },
    }),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/config/events?propertyId={propertyId}", timeout: 20000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-347",
    name: "discover_competitors",
    displayName: "Descubrir competidores cercanos",
    category: "revenue_write",
    description:
      "Busca hoteles cercanos (OpenStreetMap) y los puntua por proximidad, gama y tamaño. NO guarda nada: devuelve candidatos para revisar. " +
      "Mostralos y pedi cuales confirmar; despues llama confirm_discovered_competitors con los elegidos.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      initialRadiusKm: { type: "number", description: "Radio inicial en km (0.5-50). Se expande solo si encuentra poco." },
    }),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/external-competitors/discover?propertyId={propertyId}", timeout: 45000 },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-348",
    name: "confirm_discovered_competitors",
    displayName: "Confirmar competidores descubiertos",
    category: "revenue_write",
    description:
      "Guarda los candidatos elegidos de discover_competitors. `candidates` son los objetos TAL CUAL vinieron del descubrimiento. " +
      "slotIntoCompset true los mete ademas en los 5 slots del comp-set activo.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      candidates: { type: "array", description: "Candidatos elegidos, tal cual los devolvio discover_competitors (max 20)." },
      searchRadiusKm: { type: "number", description: "Radio con el que se busco. Opcional." },
      slotIntoCompset: { type: "boolean", description: "Ademas ocupar slots del comp-set (default false)." },
    }, ["candidates"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/external-competitors/confirm?propertyId={propertyId}", timeout: 20000 },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-349",
    name: "create_competitor",
    displayName: "Agregar competidor",
    category: "revenue_write",
    description:
      "Alta manual de un competidor del comp-set. Solo `label` es obligatorio; el resto (tarifa manual, direccion, coordenadas, estrellas, " +
      "gama, habitaciones, links de OTA) mejora el scoring de similitud.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      label: { type: "string", description: "Nombre del competidor." },
      manualBarUsd: { type: "number", description: "Tarifa de referencia en USD. Opcional." },
      otaListingUrls: { type: "array", description: "[{ ota: 'booking'|'expedia'|'airbnb'|'other', url }]. Opcional." },
      address: { type: "string", description: "Direccion. Opcional." },
      city: { type: "string", description: "Ciudad. Opcional." },
      lat: { type: "number", description: "Latitud. Opcional." },
      lng: { type: "number", description: "Longitud. Opcional." },
      propertyType: { type: "string", description: "Tipo de alojamiento. Opcional." },
      starRating: { type: "number", description: "Estrellas 1-5. Opcional." },
      priceTier: { type: "string", description: "economy | mid | upscale | luxury. Opcional." },
      roomCount: { type: "number", description: "Cantidad de habitaciones. Opcional." },
      website: { type: "string", description: "Sitio web. Opcional." },
    }, ["label"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/external-competitors?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-350",
    name: "update_competitor",
    displayName: "Editar competidor",
    category: "revenue_write",
    description: "Modifica un competidor del comp-set. Mandar solo los campos que cambian. isActive false lo saca del comparativo sin borrarlo.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      externalCompetitorId: { type: "string", description: "ID del competidor." },
      label: { type: "string", description: "Nuevo nombre. Opcional." },
      manualBarUsd: { type: "number", description: "Nueva tarifa de referencia. Opcional." },
      starRating: { type: "number", description: "Estrellas 1-5. Opcional." },
      priceTier: { type: "string", description: "economy | mid | upscale | luxury. Opcional." },
      roomCount: { type: "number", description: "Habitaciones. Opcional." },
      website: { type: "string", description: "Sitio web. Opcional." },
      isActive: { type: "boolean", description: "Activo en el comparativo. Opcional." },
    }, ["externalCompetitorId"]),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/external-competitors/{externalCompetitorId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-351",
    name: "delete_competitor",
    displayName: "Eliminar competidor",
    category: "revenue_write",
    description:
      "Borra un competidor. Si tenia tarifas cargadas queda DESACTIVADO en vez de borrado (para no perder el historico); " +
      "la respuesta dice cual de las dos cosas paso.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      externalCompetitorId: { type: "string", description: "ID del competidor." },
    }, ["externalCompetitorId"]),
    execution: { targetService: "rms-app", method: "DELETE", pathTemplate: "/api/v1/rms/external-competitors/{externalCompetitorId}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-352",
    name: "upsert_competitor_rates",
    displayName: "Cargar tarifas de un competidor",
    category: "revenue_write",
    description:
      "Carga o pisa tarifas por fecha de un competidor (hasta 400 en una llamada). La respuesta trae `warnings` con las fechas cuya tarifa " +
      "se desvia mucho del historico: mostralas, suelen ser errores de tipeo.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      externalCompetitorId: { type: "string", description: "ID del competidor." },
      rates: { type: "array", description: "[{ date: 'YYYY-MM-DD', rate: <numero>, currency?: 'USD', roomType?: '...' }]." },
    }, ["externalCompetitorId", "rates"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "/api/v1/rms/external-competitors/{externalCompetitorId}/rates?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-353",
    name: "delete_competitor_rate",
    displayName: "Borrar tarifa de un competidor",
    category: "revenue_write",
    description: "Borra la tarifa de UNA fecha de un competidor. Irreversible.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      externalCompetitorId: { type: "string", description: "ID del competidor." },
      date: { type: "string", description: "Fecha de la tarifa (YYYY-MM-DD)." },
    }, ["externalCompetitorId", "date"]),
    execution: { targetService: "rms-app", method: "DELETE", pathTemplate: "/api/v1/rms/external-competitors/{externalCompetitorId}/rates/{date}?propertyId={propertyId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-354",
    name: "update_compset",
    displayName: "Definir el comp-set",
    category: "revenue_write",
    description:
      "Reemplaza los slots del comp-set (maximo 5). Cada slot es { type: 'bookfer', propertyId } o { type: 'external', externalCompetitorId }, " +
      "con `label` opcional. REEMPLAZA la lista entera: incluí tambien los que ya estaban y se quedan. El orden define competitor_1..competitor_5 " +
      "en las reglas, asi que reordenar cambia que compara cada regla.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      competitors: { type: "array", description: "Lista completa de slots (max 5), en orden." },
    }, ["competitors"]),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/config/compset?propertyId={propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-355",
    name: "update_hotel_profile",
    displayName: "Editar perfil del hotel (comp-set)",
    category: "revenue_write",
    description:
      "Perfil del hotel propio usado para puntuar la similitud con los competidores: tipo, estrellas, gama, habitaciones, ciudad, zona y amenities. " +
      "Editarlo marca manualOverride y corta el sync automatico desde pms-core.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      name: { type: "string", description: "Nombre. Opcional." },
      propertyType: { type: "string", description: "Tipo de alojamiento. Opcional." },
      starRating: { type: "number", description: "Estrellas 1-5. Opcional." },
      priceTier: { type: "string", description: "economy | mid | upscale | luxury. Opcional." },
      roomCount: { type: "number", description: "Cantidad de habitaciones. Opcional." },
      city: { type: "string", description: "Ciudad. Opcional." },
      zone: { type: "string", description: "Zona/barrio. Opcional." },
      amenities: { type: "array", description: "Lista de amenities. Opcional." },
    }),
    execution: { targetService: "rms-app", method: "PUT", pathTemplate: "/api/v1/rms/config/profile?propertyId={propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: RESERVAS extras (booking-app) ====
  // Cubren lo que faltaba del hub Reservas: buscador libre (por codigo, nombre,
  // email, telefono o documento), mover/redimensionar reservas, editar servicios,
  // huespedes frecuentes, BLOQUEOS de habitacion y RESTRICCIONES por dia.
  {
    toolId: "tool-400",
    name: "search_reservations",
    displayName: "Buscar reservas (texto libre)",
    category: "reservations_read",
    description:
      "BUSCADOR de reservas de la propiedad por texto libre `q`: codigo de reserva (RES-2026-XXXX o un fragmento), reservationId, nombre o apellido del huesped, " +
      "email, telefono o documento. Multi-token con AND ('juan perez' matchea ambos), acento-insensible. Es la forma correcta de encontrar 'la reserva de <nombre>' " +
      "o 'la RES-2026-AB12': devuelve reservationId, reservationCode, status, fechas, categoria, unidad, monto y huesped. Usa este resultado para obtener el reservationId " +
      "que necesitan get_reservation_detail / update_reservation_status / move_reservation. Si no encuentra nada, recien ahi cae a get_reservations sin filtro.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      q: { type: "string", description: "Texto a buscar (1-80 caracteres): codigo, nombre, email, telefono o documento." },
      limit: { type: "number", description: "Maximo de resultados (1-25, default 8)." },
    }, ["q"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/reservations/search" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-401",
    name: "preview_reservation_move",
    displayName: "Simular mover/redimensionar reserva",
    category: "reservations_read",
    description:
      "SIMULA mover una reserva a otra unidad y/o cambiar sus fechas (check-in/check-out) SIN aplicar nada: devuelve si es posible, conflictos de disponibilidad y el precio resultante. " +
      "Llamala siempre antes de move_reservation y mostrale al usuario el resultado. Al menos uno de newUnitId / newCheckIn / newCheckOut.",
    inputSchema: obj({
      reservationId: { type: "string", description: "ID interno de la reserva (res-...), no el codigo." },
      newUnitId: { type: "string", description: "Nueva unidad (o null para desasignar)." },
      newCheckIn: { type: "string", description: "Nuevo check-in YYYY-MM-DD." },
      newCheckOut: { type: "string", description: "Nuevo check-out YYYY-MM-DD." },
    }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/reservations/{reservationId}/move-preview" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-402",
    name: "move_reservation",
    displayName: "Mover / redimensionar reserva",
    category: "reservations_write",
    description:
      "MUEVE una reserva a otra unidad y/o cambia sus fechas (es lo que hace el drag & drop del calendario). priceMode 'keep' mantiene el precio; 'reprice' recalcula con las tarifas vigentes. " +
      "Simula antes con preview_reservation_move y confirma con el usuario (unidad/fechas/precio nuevos) antes de ejecutar.",
    inputSchema: obj({
      reservationId: { type: "string", description: "ID interno de la reserva (res-...)." },
      newUnitId: { type: "string", description: "Nueva unidad (o null para desasignar)." },
      newCheckIn: { type: "string", description: "Nuevo check-in YYYY-MM-DD." },
      newCheckOut: { type: "string", description: "Nuevo check-out YYYY-MM-DD." },
      priceMode: { type: "string", description: "'keep' (default) o 'reprice'." },
    }, ["reservationId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/{reservationId}/move" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-403",
    name: "update_reservation_service",
    displayName: "Editar servicio de una reserva",
    category: "reservations_write",
    description: "Edita un servicio extra ya cargado en una reserva (cantidad, precio, notas). El id es el reservationServiceId que devuelve get_reservation_services.",
    inputSchema: obj({
      reservationServiceId: { type: "string", description: "ID del servicio de la reserva." },
      quantity: { type: "number", description: "Nueva cantidad." },
      unitPrice: { type: "number", description: "Nuevo precio unitario." },
      notes: { type: "string", description: "Notas." },
    }, ["reservationServiceId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/reservations/services/{reservationServiceId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-404",
    name: "search_guest_by_email",
    displayName: "Buscar huesped por email",
    category: "guests_read",
    description: "Busca un huesped registrado por su email exacto (base compartida con staypass). Sirve para reutilizar guestId al crear una reserva manual en vez de crear un huesped duplicado.",
    inputSchema: obj({
      email: { type: "string", description: "Email exacto del huesped." },
    }, ["email"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/guests/search" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-405",
    name: "list_frequent_guests",
    displayName: "Huespedes frecuentes",
    category: "guests_read",
    description: "Lista los huespedes frecuentes de la propiedad (los que mas reservaron), con filtro de texto opcional por nombre/email.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      q: { type: "string", description: "Filtro de texto opcional (nombre/email)." },
      limit: { type: "number", description: "Maximo (1-100)." },
    }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/guests/frequent" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-406",
    name: "list_unit_blocks",
    displayName: "Listar bloqueos de habitacion",
    category: "reservations_read",
    description:
      "Lista los BLOQUEOS de habitacion de la propiedad (mantenimiento, uso interno u otro): periodos en los que una unidad no se puede vender. Filtros opcionales por rango de fechas y unitId. " +
      "Un bloqueo NO es un cambio de estado (eso es change_room_status): bloquea la disponibilidad del motor para esas fechas.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde YYYY-MM-DD." },
      to: { type: "string", description: "Hasta YYYY-MM-DD." },
      unitId: { type: "string", description: "Filtrar por unidad." },
    }),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/unit-blocks" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-407",
    name: "create_unit_block",
    displayName: "Bloquear habitacion (fechas)",
    category: "reservations_write",
    description:
      "Crea un BLOQUEO de una unidad entre dos fechas (dias civiles) para que no se venda: type 'maintenance' (default), 'internal-use' u 'other'. label es obligatorio (ej. 'Pintura', 'Uso del dueño'). " +
      "Resolve el unitId con list_units. Confirma unidad, fechas y motivo antes de ejecutar.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      unitId: { type: "string", description: "Unidad a bloquear." },
      startDate: { type: "string", description: "Inicio YYYY-MM-DD." },
      endDate: { type: "string", description: "Fin YYYY-MM-DD." },
      type: { type: "string", description: "maintenance | internal-use | other." },
      label: { type: "string", description: "Motivo corto (obligatorio)." },
      notes: { type: "string", description: "Notas opcionales." },
    }, ["unitId", "startDate", "endDate", "label"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "/api/v1/unit-blocks" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-408",
    name: "update_unit_block",
    displayName: "Editar bloqueo de habitacion",
    category: "reservations_write",
    description: "Edita un bloqueo existente (fechas, unidad, tipo, motivo, notas). El blockId sale de list_unit_blocks.",
    inputSchema: obj({
      blockId: { type: "string", description: "ID del bloqueo." },
      unitId: { type: "string" },
      startDate: { type: "string", description: "YYYY-MM-DD." },
      endDate: { type: "string", description: "YYYY-MM-DD." },
      type: { type: "string", description: "maintenance | internal-use | other." },
      label: { type: "string" },
      notes: { type: "string" },
    }, ["blockId"]),
    execution: { targetService: "booking-app", method: "PATCH", pathTemplate: "/api/v1/unit-blocks/{blockId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-409",
    name: "delete_unit_block",
    displayName: "Quitar bloqueo de habitacion",
    category: "reservations_write",
    description: "Elimina un bloqueo de habitacion: la unidad vuelve a estar disponible para la venta en esas fechas.",
    inputSchema: obj({ blockId: { type: "string", description: "ID del bloqueo." } }, ["blockId"]),
    execution: { targetService: "booking-app", method: "DELETE", pathTemplate: "/api/v1/unit-blocks/{blockId}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-410",
    name: "list_day_restrictions",
    displayName: "Restricciones por dia (cierres / estadia minima)",
    category: "reservations_read",
    description:
      "Lista las RESTRICCIONES por dia de la propiedad en un rango: closed (cerrado a la venta), closedToArrival (no se puede llegar ese dia), closedToDeparture (no se puede salir), minStay / maxStay. " +
      "categoryId null = aplica a toda la propiedad. Es la vista 'Tarifas y disponibilidad > restricciones' del PMS.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      from: { type: "string", description: "Desde YYYY-MM-DD (obligatorio)." },
      to: { type: "string", description: "Hasta YYYY-MM-DD (obligatorio)." },
    }, ["from", "to"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "/api/v1/day-restrictions" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-411",
    name: "set_day_restrictions",
    displayName: "Cerrar fechas / fijar estadia minima",
    category: "reservations_write",
    description:
      "Aplica RESTRICCIONES por dia en lote (upsert): cerrar fechas a la venta (closed), cerrar llegadas o salidas (closedToArrival / closedToDeparture) o fijar estadia minima/maxima (minStay / maxStay), " +
      "por propiedad (categoryId null) o por categoria. items: lista de { date: YYYY-MM-DD, categoryId?, closed?, closedToArrival?, closedToDeparture?, minStay?, maxStay? } (max 370). " +
      "Ej. 'cerra la venta del 24 al 26 de diciembre' = un item por dia con closed:true. Confirma fechas y alcance antes de ejecutar: esto quita disponibilidad del motor.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      items: { type: "array", description: "Lista de restricciones por dia (ver descripcion)." },
    }, ["items"]),
    execution: { targetService: "booking-app", method: "PUT", pathTemplate: "/api/v1/day-restrictions/bulk" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: MARCA (pms-core) =================
  // La identidad de marca vive en Property.brand (logo, paleta, tono, narrativa,
  // contacto publico). Se lee con get_property_detail y se edita por PATCH.
  {
    toolId: "tool-420",
    name: "update_property_brand",
    displayName: "Editar identidad de marca",
    category: "marketing_write",
    description:
      "Edita la IDENTIDAD DE MARCA de la propiedad (app Marca): brand.palette (primary/secondary/accent/neutral en hex), brand.tone (tono de comunicacion), brand.typographyPreset, " +
      "brand.narrative (tagline, shortDescription, ...), brand.publicContact (whatsapp, email, ...) y brand.assets (logo/logoDark/hero/background/photo1..4 como { fileId, url } de la libreria). " +
      "IMPORTANTE: el PATCH REEMPLAZA el objeto brand completo. Flujo: get_property_detail -> tomar su campo brand -> aplicar los cambios pedidos -> mandar el objeto brand COMPLETO (no solo las claves cambiadas, o se pierde el resto). Para subir un logo adjunto, primero add_image_to_library y usa su fileId/url.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      brand: { type: "object", description: "Objeto brand COMPLETO (leido de get_property_detail y modificado)." },
    }, ["brand"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: LINKHUB (pms-core) ===============
  // Pagina de enlaces publicos (tipo Linktree) por propiedad. Flujo: la pagina
  // tiene un contenido PUBLICADO y un BORRADOR opcional; se edita el borrador
  // completo (get_linkhub_draft -> modificar -> save_linkhub_draft) y se publica.
  {
    toolId: "tool-425",
    name: "get_linkhub_page",
    displayName: "Ver LinkHub",
    category: "marketing_read",
    description:
      "Pagina LinkHub de la propiedad (se crea sola en la primera lectura): slug publico, status (draft/published), profile (displayName, bio, avatar), blocks (link, whatsapp, booking, reviews, text, gallery, ...), theme y seo. " +
      "Devuelve el contenido PUBLICADO; el borrador se lee con get_linkhub_draft.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/linkhub" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-426",
    name: "update_linkhub_meta",
    displayName: "Cambiar slug del LinkHub",
    category: "marketing_write",
    description: "Cambia el slug publico del LinkHub (la URL). Verifica antes con check_linkhub_slug que este libre.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      slug: { type: "string", description: "Nuevo slug (se normaliza a minusculas y guiones)." },
    }, ["slug"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/linkhub" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-427",
    name: "check_linkhub_slug",
    displayName: "Verificar slug de LinkHub",
    category: "marketing_read",
    description: "Verifica si un slug de LinkHub esta disponible.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      slug: { type: "string", description: "Slug a verificar." },
    }, ["slug"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/slug-check" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-428",
    name: "get_linkhub_draft",
    displayName: "Ver borrador del LinkHub",
    category: "marketing_read",
    description: "Borrador actual del LinkHub (o el contenido publicado si no hay borrador): { hasDraft, content: { profile, blocks, theme, seo } }. Es el punto de partida para editar.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/draft" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-429",
    name: "save_linkhub_draft",
    displayName: "Guardar borrador del LinkHub",
    category: "marketing_write",
    description:
      "Guarda el BORRADOR COMPLETO del LinkHub (reemplaza el borrador anterior; no es un merge). Flujo: get_linkhub_draft -> tomar content -> aplicar los cambios pedidos (agregar/quitar/reordenar blocks, editar profile.bio, cambiar theme.templateId, etc.) " +
      "-> save_linkhub_draft con `payload` = content completo. Bloques: { type: link|whatsapp|booking|reviews|text|gallery|..., title, subtitle?, content: {...}, isActive, featured, displayOrder }. No publica: para eso publish_linkhub.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      payload: { type: "object", description: "Contenido completo { profile, blocks, theme, seo }." },
    }, ["payload"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/draft" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-430",
    name: "discard_linkhub_draft",
    displayName: "Descartar borrador del LinkHub",
    category: "marketing_write",
    description: "Descarta el borrador del LinkHub y vuelve al contenido publicado.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/draft" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-431",
    name: "publish_linkhub",
    displayName: "Publicar LinkHub",
    category: "marketing_write",
    description: "PUBLICA el borrador del LinkHub: pasa a ser la pagina publica en su slug. Confirma antes: cambia lo que ven los huespedes.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/publish" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-432",
    name: "get_linkhub_analytics",
    displayName: "Analitica del LinkHub",
    category: "marketing_read",
    description: "Vistas y clics del LinkHub por dia y por bloque en los ultimos N dias.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      days: { type: "number", description: "Ventana en dias (default 30)." },
    }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/linkhub/analytics" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: PRESENCIA ONLINE (pms-core) ======
  // Social Hub: redes (instagram/facebook/tiktok), Google Business Profile, OTAs
  // (booking/expedia/airbnb/tripadvisor), piezas generadas por IA y score de
  // visibilidad. Rutas bajo /api/v1/properties/{propertyId}/social-hub.
  {
    toolId: "tool-435",
    name: "get_social_hub_overview",
    displayName: "Resumen de presencia online",
    category: "marketing_read",
    description: "Resumen de la presencia online de la propiedad: conexiones (redes/GBP/OTAs y su estado), alertas, piezas recientes y score de visibilidad.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/overview" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-436",
    name: "list_social_connections",
    displayName: "Conexiones de redes/GBP/OTAs",
    category: "marketing_read",
    description: "Lista las plataformas conectadas o declaradas (instagram, facebook, tiktok, google_business, booking, expedia, airbnb, tripadvisor) con su status: declared | connected | error | disconnected.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/connections" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-437",
    name: "upsert_social_connection",
    displayName: "Declarar/editar conexion de plataforma",
    category: "marketing_write",
    description: "Crea o edita la conexion de una plataforma (platform: instagram | facebook | tiktok | google_business | booking | expedia | airbnb | tripadvisor): handle/URL del perfil, id externo, status. Es una declaracion (no OAuth).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      platform: { type: "string", description: "Plataforma (ver descripcion)." },
      handle: { type: "string", description: "Usuario/handle o nombre del perfil." },
      url: { type: "string", description: "URL publica del perfil." },
      externalId: { type: "string", description: "ID externo (opcional)." },
      status: { type: "string", description: "declared | connected | error | disconnected." },
    }, ["platform"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/connections/{platform}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-438",
    name: "list_social_alerts",
    displayName: "Alertas de presencia online",
    category: "marketing_read",
    description: "Alertas del Social Hub (perfil incompleto, OTA desactualizada, sin publicaciones, etc.). unread=true para solo no leidas.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      unread: { type: "boolean", description: "Solo no leidas." },
    }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/alerts" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-439",
    name: "mark_social_alert_read",
    displayName: "Marcar alerta como leida",
    category: "marketing_write",
    description: "Marca una alerta del Social Hub como leida.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      alertId: { type: "string", description: "ID de la alerta." },
    }, ["alertId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/alerts/{alertId}/read" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-440",
    name: "list_social_assets",
    displayName: "Piezas para redes",
    category: "marketing_read",
    description: "Lista las piezas (posts/creatividades) generadas o cargadas para redes, con filtros opcionales channel (instagram|facebook|tiktok), status y batchId.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      channel: { type: "string" },
      status: { type: "string" },
      batchId: { type: "string" },
    }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/assets" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-441",
    name: "generate_social_assets",
    displayName: "Generar piezas para redes (IA)",
    category: "marketing_write",
    description: "Genera con IA un lote de piezas para redes a partir de la marca, fotos y datos del hotel: channel (instagram|facebook|tiktok), objective (texto: promocion, temporada, evento...), count y types (tipos de pieza). Quedan como borradores en list_social_assets.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      channel: { type: "string", description: "instagram | facebook | tiktok." },
      objective: { type: "string", description: "Objetivo/brief de la campaña." },
      count: { type: "number", description: "Cantidad de piezas." },
      types: { type: "array", description: "Tipos de pieza (opcional)." },
    }, ["channel"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/assets/generate", timeout: 60000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-442",
    name: "create_social_asset",
    displayName: "Crear pieza para redes",
    category: "marketing_write",
    description: "Crea manualmente una pieza para redes (channel, tipo, copy/caption, imagen de la libreria, hashtags).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      channel: { type: "string", description: "instagram | facebook | tiktok." },
      type: { type: "string", description: "Tipo de pieza (post, story, reel...)." },
      copy: { type: "string", description: "Texto/caption." },
      imageFileId: { type: "string", description: "fileId de la libreria (opcional)." },
      hashtags: { type: "array", description: "Hashtags (opcional)." },
    }, ["channel"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/assets" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-443",
    name: "update_social_asset",
    displayName: "Editar pieza para redes",
    category: "marketing_write",
    description: "Edita una pieza (copy, hashtags, imagen, status: draft|approved|published...). El assetId sale de list_social_assets.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      assetId: { type: "string" },
      copy: { type: "string" },
      hashtags: { type: "array" },
      imageFileId: { type: "string" },
      status: { type: "string" },
    }, ["assetId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/assets/{assetId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-444",
    name: "archive_social_asset",
    displayName: "Archivar pieza para redes",
    category: "marketing_write",
    description: "Archiva (oculta) una pieza para redes.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      assetId: { type: "string" },
    }, ["assetId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/assets/{assetId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-445",
    name: "get_gbp_profile",
    displayName: "Ver ficha de Google Business",
    category: "marketing_read",
    description: "Ficha de Google Business Profile de la propiedad tal como esta cargada en el PMS: business (nombre, categoria, descripcion, telefono, web), location, hours (por dia), attributes, photos y syncState.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/gbp" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-446",
    name: "update_gbp_profile",
    displayName: "Editar ficha de Google Business",
    category: "marketing_write",
    description: "Edita la ficha de Google Business (business, location, hours: [{day 0-6, open 'HH:mm', close 'HH:mm', closed}], attributes, photos). Manda solo lo que cambia. No publica en Google: para eso publish_gbp_profile.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      business: { type: "object" },
      location: { type: "object" },
      hours: { type: "array" },
      attributes: { type: "array" },
      photos: { type: "array" },
    }),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/gbp" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-447",
    name: "publish_gbp_profile",
    displayName: "Publicar ficha en Google Business",
    category: "marketing_write",
    description: "Publica/sincroniza la ficha cargada hacia Google Business Profile (requiere conexion google_business). Confirma antes.",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/gbp/publish", timeout: 30000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-448",
    name: "get_ota_profile",
    displayName: "Ver ficha de OTA",
    category: "marketing_read",
    description: "Ficha de la propiedad para una OTA (platform: booking | expedia | airbnb | tripadvisor): description, policies, roomTypes (por categoria: included, nameOverride, descriptionOverride, priceFromUsd, foto, amenityTags) y syncState.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      platform: { type: "string", description: "booking | expedia | airbnb | tripadvisor." },
    }, ["platform"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/otas/{platform}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-449",
    name: "update_ota_profile",
    displayName: "Editar ficha de OTA",
    category: "marketing_write",
    description: "Edita la ficha de una OTA (description, policies, roomTypes). Manda solo lo que cambia. No sincroniza con la OTA: para eso sync_ota_profile.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      platform: { type: "string", description: "booking | expedia | airbnb | tripadvisor." },
      description: { type: "object" },
      policies: { type: "object" },
      roomTypes: { type: "array" },
    }, ["platform"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/otas/{platform}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-450",
    name: "sync_ota_profile",
    displayName: "Sincronizar ficha con la OTA",
    category: "marketing_write",
    description: "Dispara la sincronizacion de la ficha hacia la OTA indicada. Confirma antes.",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      platform: { type: "string", description: "booking | expedia | airbnb | tripadvisor." },
    }, ["platform"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/otas/{platform}/sync", timeout: 30000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-451",
    name: "get_visibility_dashboard",
    displayName: "Score de visibilidad online",
    category: "marketing_read",
    description: "Dashboard de visibilidad online (score compuesto por completitud de perfiles, reseñas, actividad en redes, OTAs) para un rango (range: 7d | 30d | 90d).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      range: { type: "string", description: "7d | 30d | 90d." },
    }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/visibility/dashboard" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-452",
    name: "get_visibility_history",
    displayName: "Historial de visibilidad online",
    category: "marketing_read",
    description: "Serie historica del score de visibilidad online (range: 7d | 30d | 90d).",
    inputSchema: obj({
      ...PROPERTY_PARAM,
      range: { type: "string", description: "7d | 30d | 90d." },
    }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/properties/{propertyId}/social-hub/visibility/history" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: WEB BUILDER extras (pms-core) ====
  // Operaciones de SITIO (subSite) que faltaban: publicar cambios, descartar
  // borrador, duplicar, vincular a una propiedad, SEO/GEO, popups, Engine
  // Studio, boton de WhatsApp, idiomas, crear/quitar paginas, portada y favicon.
  // La edicion de COMPONENTES de una pagina sigue fuera (arboles enormes: se hace
  // en el editor visual).
  {
    toolId: "tool-455",
    name: "publish_site_changes",
    displayName: "Publicar cambios de un sitio",
    category: "marketing_write",
    description:
      "PUBLICA los cambios en borrador de un SITIO (subSiteId dentro del proyecto siteId). scopes indica que publicar: { page: [componentes...] } (requiere pageId), { top: [...] } (encabezado global), { bottom: [...] } (pie global). " +
      "Los arboles de componentes se obtienen del editor; desde el chat lo habitual es publicar lo que el usuario ya edito: pedile confirmar el sitio y la pagina. Confirma antes: cambia el sitio en vivo.",
    inputSchema: obj({
      siteId: { type: "string", description: "ID del proyecto." },
      subSiteId: { type: "string", description: "ID del sitio." },
      pageId: { type: "string", description: "Pagina (si scopes.page)." },
      scopes: { type: "object", description: "{ page?: [...], top?: [...], bottom?: [...] }." },
    }, ["siteId", "subSiteId", "scopes"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/site-data/publish/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-456",
    name: "discard_site_draft",
    displayName: "Descartar borrador de un sitio",
    category: "marketing_write",
    description: "Descarta el borrador (cambios sin publicar) de un sitio.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
    }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/site-data/draft/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-457",
    name: "duplicate_site",
    displayName: "Duplicar sitio",
    category: "marketing_write",
    description: "Duplica un SITIO dentro de su proyecto (copia paginas, componentes y configuracion). Devuelve el sitio nuevo.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
    }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/duplicate", timeout: 30000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-458",
    name: "set_site_property",
    displayName: "Vincular sitio a una propiedad",
    category: "marketing_write",
    description: "Vincula un SITIO a una propiedad del hotel (para que el motor de reservas, marca y GEO del sitio tomen esa propiedad).",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      propertyId: { type: "string", description: "Propiedad a vincular." },
    }, ["siteId", "subSiteId", "propertyId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/property" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-459",
    name: "update_site_seo_geo",
    displayName: "Editar SEO/GEO de un sitio",
    category: "marketing_write",
    description: "Edita el SEO/GEO de un SITIO: title, description, socialPreview (imagen OG), favicon, appleTouchIcon y aiDiscovery (config GEO: como lo describen los buscadores con IA). Al menos un campo. get_site devuelve el aiDiscovery actual.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      socialPreview: { type: "string", description: "URL de la imagen de preview social." },
      favicon: { type: "string" },
      appleTouchIcon: { type: "string" },
      aiDiscovery: { type: "object" },
    }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/seo-geo" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-460",
    name: "get_site_popups",
    displayName: "Ver popups de un sitio",
    category: "marketing_read",
    description: "Popups configurados en un SITIO (promos, avisos): contenido, disparador y vigencia.",
    inputSchema: obj({ siteId: { type: "string" }, subSiteId: { type: "string" } }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/popups" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-461",
    name: "update_site_popups",
    displayName: "Editar popups de un sitio",
    category: "marketing_write",
    description: "Reemplaza la lista de popups de un SITIO. Lee primero get_site_popups y manda la lista completa modificada en `popups`.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      popups: { type: "array", description: "Lista completa de popups." },
    }, ["siteId", "subSiteId", "popups"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/popups" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-462",
    name: "get_site_engine_studio",
    displayName: "Ver Engine Studio de un sitio",
    category: "marketing_read",
    description: "Configuracion del motor de reservas embebido en el SITIO (Engine Studio): apariencia, textos y comportamiento del widget de reservas.",
    inputSchema: obj({ siteId: { type: "string" }, subSiteId: { type: "string" } }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/engine-studio" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-463",
    name: "update_site_engine_studio",
    displayName: "Editar Engine Studio de un sitio",
    category: "marketing_write",
    description: "Edita la configuracion del motor embebido del SITIO. Lee primero get_site_engine_studio y manda el objeto en `engineStudio` con los cambios.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      engineStudio: { type: "object" },
    }, ["siteId", "subSiteId", "engineStudio"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/engine-studio" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-464",
    name: "get_site_whatsapp_button",
    displayName: "Ver boton de WhatsApp de un sitio",
    category: "marketing_read",
    description: "Configuracion del boton flotante de WhatsApp del SITIO (numero, mensaje, posicion, visibilidad).",
    inputSchema: obj({ siteId: { type: "string" }, subSiteId: { type: "string" } }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/whatsapp-button" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-465",
    name: "update_site_whatsapp_button",
    displayName: "Editar boton de WhatsApp de un sitio",
    category: "marketing_write",
    description: "Edita el boton flotante de WhatsApp del SITIO. Manda el objeto en `whatsappButton` (enabled, phone E.164, message, position...).",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      whatsappButton: { type: "object" },
    }, ["siteId", "subSiteId", "whatsappButton"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/subsite/{subSiteId}/from/{siteId}/whatsapp-button" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-466",
    name: "add_site_language",
    displayName: "Agregar idioma a un proyecto web",
    category: "marketing_write",
    description: "Agrega una variante de idioma al PROYECTO (siteId): crea el sitio en ese idioma (language: es, en, pt, ...).",
    inputSchema: obj({
      siteId: { type: "string" },
      language: { type: "string", description: "Codigo de idioma (es, en, pt, fr...)." },
    }, ["siteId", "language"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "/site-data/{siteId}/languages", timeout: 30000 },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-467",
    name: "delete_site_language",
    displayName: "Quitar idioma de un proyecto web",
    category: "marketing_write",
    description: "Elimina la variante de idioma de un PROYECTO (y su sitio). Irreversible: confirma antes.",
    inputSchema: obj({
      siteId: { type: "string" },
      language: { type: "string" },
    }, ["siteId", "language"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/site-data/{siteId}/languages/{language}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-468",
    name: "create_site_page",
    displayName: "Crear pagina en un sitio",
    category: "marketing_write",
    description: "Crea una PAGINA nueva en un SITIO: name (nombre interno), title (titulo SEO), description (meta description), urlPage (ruta publica, ej. 'contacto') y status (indraft | active | inactive; default indraft). Nace vacia: el contenido se arma en el editor visual.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      name: { type: "string", description: "Nombre de la pagina." },
      title: { type: "string", description: "Titulo (SEO)." },
      description: { type: "string", description: "Descripcion (SEO)." },
      urlPage: { type: "string", description: "Ruta publica (ej. contacto)." },
      status: { type: "string", description: "indraft | active | inactive." },
    }, ["siteId", "subSiteId", "name", "title", "description"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/create-page/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-469",
    name: "remove_site_page",
    displayName: "Eliminar pagina de un sitio",
    category: "marketing_write",
    description: "Elimina una PAGINA de un SITIO (pageId de list_site_pages). Irreversible: confirma antes.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      pageId: { type: "string" },
    }, ["siteId", "subSiteId", "pageId"]),
    execution: { targetService: "pms-core", method: "DELETE", pathTemplate: "/site-data/remove/{pageId}/from/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-470",
    name: "update_site_cover",
    displayName: "Cambiar portada de un sitio",
    category: "marketing_write",
    description: "Cambia la imagen de portada (cover) del SITIO que se ve en la lista de proyectos. `cover` es la URL de una imagen de la libreria.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      cover: { type: "string", description: "URL de la imagen." },
    }, ["siteId", "subSiteId", "cover"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/update-cover/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-471",
    name: "update_site_favicon",
    displayName: "Cambiar favicon de un sitio",
    category: "marketing_write",
    description: "Cambia el favicon del SITIO. `favicon` es la URL de una imagen de la libreria.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      favicon: { type: "string", description: "URL de la imagen." },
    }, ["siteId", "subSiteId", "favicon"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/update-favicon/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-472",
    name: "update_site_settings",
    displayName: "Editar ajustes de un sitio",
    category: "marketing_write",
    description: "Edita los ajustes de un SITIO: domain, socialPreview, appleTouchIcon, gaMeasurementId (Google Analytics), gtmContainerId (Tag Manager), utmPreserve, editorMode. Al menos un campo. Los dominios personalizados se ven con list_site_domains.",
    inputSchema: obj({
      siteId: { type: "string" },
      subSiteId: { type: "string" },
      domain: { type: "string" },
      socialPreview: { type: "string" },
      appleTouchIcon: { type: "string" },
      gaMeasurementId: { type: "string" },
      gtmContainerId: { type: "string" },
      utmPreserve: { type: "boolean" },
      editorMode: { type: "string" },
    }, ["siteId", "subSiteId"]),
    execution: { targetService: "pms-core", method: "PUT", pathTemplate: "/site-data/update-metadata/{subSiteId}/from/{siteId}" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-473",
    name: "list_property_sites",
    displayName: "Sitios web de una propiedad",
    category: "marketing_read",
    description: "Lista los SITIOS web vinculados a una propiedad concreta (subconjunto de list_site_projects).",
    inputSchema: obj({ ...PROPERTY_PARAM }),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/site-data/property/{propertyId}/subsites" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== ALCANCE COMPLETO: EQUIPO / BUSQUEDA (pms-core) =====
  {
    toolId: "tool-480",
    name: "update_company_user_access",
    displayName: "Editar accesos de un usuario (capacidades y propiedades)",
    category: "settings_write",
    description:
      "Edita los ACCESOS de un usuario de la empresa: capabilities (lista completa de capacidades administrativas: users.manage, users.assign_spaces, properties.create, properties.edit, properties.switch, spaces.manage, apps.toggle, company.settings, billing.manage, sites.manage), " +
      "allProperties (true = ve todas) y propertyIds (lista explicita cuando allProperties=false). Nadie puede otorgar lo que no tiene. Los permisos POR APP de un espacio operativo se editan con update_space_user, no aca. Confirma antes.",
    inputSchema: obj({
      ...COMPANY_PARAM,
      userId: { type: "string", description: "Usuario a editar." },
      capabilities: { type: "array", description: "Lista completa de capabilities." },
      allProperties: { type: "boolean" },
      propertyIds: { type: "array", description: "Propiedades habilitadas (si allProperties=false)." },
    }, ["userId"]),
    execution: { targetService: "pms-core", method: "PATCH", pathTemplate: "/company/{companyId}/users/{userId}/access" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: true, isDestructive: false },
  },
  {
    toolId: "tool-481",
    name: "find_user_by_email",
    displayName: "Buscar usuario por email",
    category: "settings_read",
    description: "Busca un usuario del PMS por email (para agregarlo a la empresa o a un espacio operativo).",
    inputSchema: obj({ email: { type: "string" } }, ["email"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/user/by-email" },
    permissions: { requiredRoles: CONFIG_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-482",
    name: "global_search",
    displayName: "Buscador global del PMS",
    category: "settings_read",
    description:
      "Buscador global (Ctrl+K del PMS): busca por texto en reservas, huespedes, habitaciones, categorias, propiedades, sitios, usuarios, etc. de la empresa. Util cuando el usuario no dice de que entidad habla ('busca Perez'). " +
      "propertyId acota a una propiedad; include limita los tipos (coma-separados).",
    inputSchema: obj({
      q: { type: "string", description: "Texto a buscar." },
      ...PROPERTY_PARAM,
      include: { type: "string", description: "Tipos a incluir, coma-separados (opcional)." },
      limit: { type: "number" },
    }, ["q"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/api/v1/search" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== LECTURA CRUDA DE LA API (GET a cualquier endpoint) ==
  // Estas 4 tools exponen el 100% de la API de cada microservicio PARA LECTURA.
  // El agente arma la ruta concreta (con los IDs ya sustituidos) y, opcional,
  // un objeto `query`. Se ejecutan con la identidad real del usuario (JWT
  // delegado) → el PMS sigue aplicando authorize/membership. Solo GET.
  {
    toolId: "tool-200",
    name: "read_pms_core_api",
    displayName: "Leer API de pms-core (GET crudo)",
    category: "raw_read",
    description:
      "GET a CUALQUIER endpoint de pms-core (propiedades, espacios operativos, dashboards, servicios, amenities, galerias, reseñas, empresa, equipo/usuarios, sitios web, libreria de archivos, catalogos, plantillas, notificaciones, chat). " +
      "Pasa `path` como ruta concreta con los IDs reales sustituidos. Familias de rutas: " +
      "/api/v1/properties · /api/v1/properties/<propertyId> · /api/v1/properties/<propertyId>/units · /api/v1/properties/<propertyId>/units/<unitId> · " +
      "/api/v1/properties/<propertyId>/spaces · /api/v1/properties/<propertyId>/spaces/<spaceId>/dashboards · /api/v1/properties/<propertyId>/services · " +
      "/api/v1/properties/<propertyId>/amenities · /api/v1/properties/<propertyId>/galleries · /api/v1/properties/<propertyId>/reviews · /api/v1/properties/<propertyId>/reports/dashboard · " +
      "/api/v1/property-templates · /api/v1/service-categories · /api/v1/site-templates · /api/v1/notifications · " +
      "/company/profile · /company/my-companies · /company/associated · /company/<companyId>/users · /user/profile · " +
      "/site-data/company/<companyId>/all · /site-data/<siteId> · /asset-library · /asset-library/folders · /asset-library/files · " +
      "/custom-catalog · /custom-catalog/items · /project/company/<companyId>. " +
      "Preferi las tools especificas (list_*/get_*) cuando existan; usa esta para todo lo demas.",
    inputSchema: obj({
      path: { type: "string", description: "Ruta concreta que empieza con '/', con los IDs reales sustituidos (sin {placeholders})." },
      query: { type: "object", description: "Opcional. Query params como objeto plano, ej. {\"status\":\"active\"}." },
    }, ["path"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "{path}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-201",
    name: "read_booking_api",
    displayName: "Leer API de booking-app (GET crudo)",
    category: "raw_read",
    description:
      "GET a CUALQUIER endpoint de booking-app (motor de reservas). Pasa `path` con los IDs sustituidos. Familias de rutas: " +
      "/api/v1/availability · /api/v1/availability/calendar · /api/v1/reservations · /api/v1/reservations/unassigned · /api/v1/reservations/<reservationId> · /api/v1/reservations/<reservationId>/services · " +
      "/api/v1/rate-plans · /api/v1/rate-plans/<ratePlanId> · /api/v1/promos · /api/v1/promos/<promoId> · /api/v1/engine-settings · /api/v1/reports/dashboard · " +
      "/api/v1/exchange-rates/preview · /api/v1/categories · /api/v1/migrations/open · /api/v1/migrations/<draftId> · /api/v1/unit-migrations/open · /api/v1/unit-migrations/<draftId> · /api/v1/units. " +
      "Preferi las tools especificas cuando existan.",
    inputSchema: obj({
      path: { type: "string", description: "Ruta concreta que empieza con '/', con los IDs reales sustituidos (sin {placeholders})." },
      query: { type: "object", description: "Opcional. Query params como objeto plano." },
    }, ["path"]),
    execution: { targetService: "booking-app", method: "GET", pathTemplate: "{path}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-202",
    name: "read_rooms_api",
    displayName: "Leer API de rooms-app (GET crudo)",
    category: "raw_read",
    description:
      "GET a CUALQUIER endpoint de rooms-app (inventario de habitaciones). Pasa `path` con los IDs sustituidos. Familias de rutas: " +
      "/api/v1/properties/<propertyId>/units · /api/v1/properties/<propertyId>/units/states · /api/v1/properties/<propertyId>/units/<unitId> · /api/v1/properties/<propertyId>/units/<unitId>/history · " +
      "/api/v1/properties/<propertyId>/categories · /api/v1/properties/<propertyId>/categories/<categoryId> · /api/v1/properties/<propertyId>/model-audit. " +
      "Preferi las tools especificas (get_room_states, list_units, list_room_categories) cuando existan.",
    inputSchema: obj({
      path: { type: "string", description: "Ruta concreta que empieza con '/', con los IDs reales sustituidos (sin {placeholders})." },
      query: { type: "object", description: "Opcional. Query params como objeto plano." },
    }, ["path"]),
    execution: { targetService: "rooms-app", method: "GET", pathTemplate: "{path}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },
  {
    toolId: "tool-206",
    name: "read_rms_api",
    displayName: "Leer API del RMS (GET crudo)",
    category: "raw_read",
    description:
      "GET a CUALQUIER endpoint del rms-app (Hub Revenue). Pasa `path` y, si hace falta, `query` (el propertyId se inyecta solo). Familias de rutas, todas bajo /api/v1/rms: " +
      "/dashboard · /summary · /daily · /booking-window · /dataset · /config · /compset-rates · " +
      "/pace/snapshot-today · /pace/pickup · /pace/curve · /pace/alerts · /pace/benchmark · /pace/signals · /pace/signals/summary · " +
      "/rules · /decisions · /recommendations · /events · /external-competitors · /external-competitors/rates. " +
      "Preferi las tools especificas (get_revenue_dashboard, get_pace_overview, list_rate_recommendations…): esas rinden graficos en el chat, esta no.",
    inputSchema: obj({
      path: { type: "string", description: "Ruta concreta que empieza con '/', con los IDs reales sustituidos (sin {placeholders})." },
      query: { type: "object", description: "Opcional. Query params como objeto plano." },
    }, ["path"]),
    execution: { targetService: "rms-app", method: "GET", pathTemplate: "{path}" },
    permissions: { requiredRoles: READ_ROLES, requiresConfirmation: false, isDestructive: false },
  },

  // ===================== ESCRITURA CRUDA (POST/PATCH/PUT/DELETE) ============
  // Cobertura TOTAL de acciones: el agente puede escribir en CUALQUIER endpoint
  // de cualquier microservicio. Cada llamada pasa por la POLITICA DE ACCESO del
  // runtime (shared/agentAuth/routePolicy): el path se mapea a la app del
  // espacio / capability / rol que exige el PMS y se valida contra el alcance
  // fresco del usuario ANTES de ejecutar; un path que ninguna regla reconoce
  // solo lo pueden escribir owner/admin. El PMS sigue aplicando authorize/
  // membership real (el JWT delegado lleva la identidad del usuario).
  // Confirmacion obligatoria.
  {
    toolId: "tool-220",
    name: "write_pms_core_api",
    displayName: "Escribir en pms-core (POST/PATCH/PUT/DELETE)",
    category: "raw_write",
    description:
      "Ejecuta una accion de escritura en CUALQUIER endpoint de pms-core. Pasa `method` (POST/PATCH/PUT/DELETE), `path` (ruta concreta con IDs y query ya armada, ej. /api/v1/properties/<id>) y `body` (objeto JSON). Usar solo cuando no exista una tool especifica. Describi la accion y confirma con el usuario antes. Cada escritura se valida contra los permisos del usuario (app del espacio, capability, rol, propiedad): si no le corresponde, se rechaza con el motivo y NO hay que insistir por otro path.",
    inputSchema: obj({
      method: { type: "string", description: "POST, PATCH, PUT o DELETE." },
      path: { type: "string", description: "Ruta concreta que empieza con '/', con IDs y query ya incluidos." },
      body: { type: "object", description: "Cuerpo JSON de la request (para POST/PATCH/PUT)." },
    }, ["method", "path"]),
    execution: { targetService: "pms-core", method: "POST", pathTemplate: "{path}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-221",
    name: "write_booking_api",
    displayName: "Escribir en booking-app (POST/PATCH/PUT/DELETE)",
    category: "raw_write",
    description:
      "Ejecuta una accion de escritura en CUALQUIER endpoint de booking-app (motor de reservas). Pasa `method`, `path` y `body`. Usar solo cuando no exista una tool especifica. Confirma antes. Cada escritura se valida contra los permisos del usuario (app del espacio, capability, rol, propiedad): si no le corresponde, se rechaza con el motivo y NO hay que insistir por otro path.",
    inputSchema: obj({
      method: { type: "string", description: "POST, PATCH, PUT o DELETE." },
      path: { type: "string", description: "Ruta concreta que empieza con '/', con IDs y query ya incluidos." },
      body: { type: "object", description: "Cuerpo JSON de la request." },
    }, ["method", "path"]),
    execution: { targetService: "booking-app", method: "POST", pathTemplate: "{path}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-222",
    name: "write_rooms_api",
    displayName: "Escribir en rooms-app (POST/PATCH/PUT/DELETE)",
    category: "raw_write",
    description:
      "Ejecuta una accion de escritura en CUALQUIER endpoint de rooms-app (inventario). Pasa `method`, `path` y `body`. Usar solo cuando no exista una tool especifica. Confirma antes. Cada escritura se valida contra los permisos del usuario (app del espacio, capability, rol, propiedad): si no le corresponde, se rechaza con el motivo y NO hay que insistir por otro path.",
    inputSchema: obj({
      method: { type: "string", description: "POST, PATCH, PUT o DELETE." },
      path: { type: "string", description: "Ruta concreta que empieza con '/', con IDs y query ya incluidos." },
      body: { type: "object", description: "Cuerpo JSON de la request." },
    }, ["method", "path"]),
    execution: { targetService: "rooms-app", method: "POST", pathTemplate: "{path}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-223",
    name: "write_staypass_api",
    displayName: "Escribir en staypass (POST/PATCH/PUT/DELETE)",
    category: "raw_write",
    description:
      "Ejecuta una accion de escritura en CUALQUIER endpoint de staypass (huespedes, confirmaciones de reserva). Pasa `method`, `path` (con ?propertyId= si aplica) y `body`. Usar solo cuando no exista una tool especifica. Confirma antes. Cada escritura se valida contra los permisos del usuario (app del espacio, capability, rol, propiedad): si no le corresponde, se rechaza con el motivo y NO hay que insistir por otro path.",
    inputSchema: obj({
      method: { type: "string", description: "POST, PATCH, PUT o DELETE." },
      path: { type: "string", description: "Ruta concreta que empieza con '/', con IDs y query ya incluidos." },
      body: { type: "object", description: "Cuerpo JSON de la request." },
    }, ["method", "path"]),
    execution: { targetService: "staypass", method: "POST", pathTemplate: "{path}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },
  {
    toolId: "tool-224",
    name: "write_rms_api",
    displayName: "Escribir en el RMS (POST/PATCH/PUT/DELETE)",
    category: "raw_write",
    description:
      "Ejecuta una accion de escritura en CUALQUIER endpoint del rms-app (Hub Revenue). Pasa `method`, `path` (con ?propertyId= incluido) y `body`. " +
      "OJO: los schemas de escritura del RMS son estrictos (rechazan claves desconocidas) y el propertyId va en la QUERY, nunca en el body. " +
      "Usar solo cuando no exista una tool especifica. Confirma antes: esto mueve tarifas reales. Cada escritura se valida contra los permisos del usuario (app del espacio, capability, rol, propiedad): si no le corresponde, se rechaza con el motivo y NO hay que insistir por otro path.",
    inputSchema: obj({
      method: { type: "string", description: "POST, PATCH, PUT o DELETE." },
      path: { type: "string", description: "Ruta concreta que empieza con '/', con IDs y ?propertyId= ya incluidos." },
      body: { type: "object", description: "Cuerpo JSON de la request." },
    }, ["method", "path"]),
    execution: { targetService: "rms-app", method: "POST", pathTemplate: "{path}" },
    permissions: { requiredRoles: WRITE_ROLES, requiresConfirmation: true, isDestructive: true },
  },

  // ===================== ACCIONES DE UI (cliente) ==========================
  {
    toolId: "tool-230",
    name: "set_dashboard_theme",
    displayName: "Cambiar tema del dashboard (claro/oscuro)",
    category: "ui_action",
    description:
      "Cambia el TEMA visual del dashboard a oscuro o claro AL INSTANTE en la pantalla del usuario. Esta funcionalidad SI existe — usar esta tool, NO registrar el pedido como faltante. " +
      "mode: 'dark' (modo oscuro), 'light' (modo claro) o 'system' (segun el sistema). Para que el cambio quede guardado tambien en el servidor, despues llama get_active_dashboard y update_dashboard con { theme: { mode } }.",
    inputSchema: obj({
      mode: { type: "string", description: "Tema: dark, light o system." },
      accentColor: { type: "string", description: "Opcional. Color de acento en hex (ej. #2f74df)." },
    }, ["mode"]),
    execution: { targetService: "pms-core", method: "GET", pathTemplate: "/ui/set-theme", authStrategy: "none" },
    permissions: { requiredRoles: [], requiresConfirmation: false, isDestructive: false },
  },
];
