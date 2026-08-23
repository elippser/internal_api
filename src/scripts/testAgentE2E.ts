/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E REAL a traves del agente: ejecuta operaciones de escritura de TODA la app
// (renombrar property, notas, check-in, estado de habitacion, crear categoria/
// tarifa/promo/servicio/amenity/galeria/reseña/espacio, email settings) y
// VERIFICA contra la DB que cada una persistio. Limpia/revierte cada cambio.
// "Si en la app existe la funcionalidad, el agente debe poder hacerla y debe
// funcionar igual que sin el agente." Gasta tokens/tiempo a proposito.
import "dotenv/config";
import { connectDB } from "../shared/db";
import mongoose from "mongoose";
import { AgentDefinition } from "../modules/agents/agents.model";
import { devUserToken } from "./devUserToken";

const BASE = (process.env.E2E_API ?? "http://localhost:8600/api/v1") + "/conversations/sessions";
const SECRET = process.env.PMS_INTERNAL_SECRET!;
const PROPERTY = "prop-59f127d5-271c-4e24-b025-94d848495482";
const CTX = {
  userId: "user-a0d6653c-0397-4ed9-82aa-ea4729ebd05a",
  companyId: "elippser-bd8cd057-c7d9-42ac-8745-72195f5808b8",
  propertyId: PROPERTY,
  userRole: "admin",
  channel: "pms_app",
};
const TAG = "E2E" + Date.now().toString().slice(-6);

let AGENT_ID = "";
let db: any;
let pass = 0, fail = 0;
const results: string[] = [];

// Token del usuario del contexto: las rutas /sessions/:id exigen identidad
// verificada del hotelero, no solo el secret de servicio.
const USER_TOKEN = devUserToken(CTX.userId);

async function http(m: string, p: string, b?: any) {
  const res = await fetch(`${BASE}${p}`, {
    method: m,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
      "X-Pms-User-Token": USER_TOKEN,
    },
    body: b ? JSON.stringify(b) : undefined,
  });
  const t = await res.text();
  let j: any; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}

// Corre una operacion: sesion fresca, manda los prompts (accion + confirmacion),
// devuelve los toolsExecuted del ultimo turno.
async function drive(prompts: string[]): Promise<{ tools: string[]; lastContent: string; allTools: any[] }> {
  const s = await http("POST", "/", { agentId: AGENT_ID, context: CTX });
  const sid = s.body?.sessionId;
  let lastContent = ""; const allTools: any[] = [];
  for (const q of prompts) {
    const m = await http("POST", `/${sid}/messages`, { content: q });
    lastContent = String(m.body?.message?.content ?? "");
    const tx = (m.body?.message?.agentMeta?.toolsExecuted ?? []) as any[];
    allTools.push(...tx);
  }
  return { tools: allTools.map((t) => `${t.toolName}:${t.outcome}`), lastContent, allTools };
}

interface Op {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

async function execOp(op: Op) {
  process.stdout.write(`\n[${op.name}] ... `);
  try {
    const { ok, detail } = await op.run();
    if (ok) { pass++; console.log(`✓ ${detail}`); results.push(`✓ ${op.name} — ${detail}`); }
    else { fail++; console.log(`✗ ${detail}`); results.push(`✗ ${op.name} — ${detail}`); }
  } catch (e: any) {
    fail++; console.log(`✗ EXCEPTION ${e.message}`); results.push(`✗ ${op.name} — EXCEPTION ${e.message}`);
  }
}

const CONFIRM = "Si, confirmo, hacelo.";

const OPS: Op[] = [
  {
    name: "property_rename",
    run: async () => {
      const prop = await db.collection("properties").findOne({ propertyId: PROPERTY });
      const orig = prop.name;
      const target = `${TAG} Hotel`;
      const { tools } = await drive([`Cambiá el nombre de la propiedad a "${target}"`, CONFIRM]);
      const after = await db.collection("properties").findOne({ propertyId: PROPERTY }, { projection: { name: 1 } });
      const ok = after?.name === target;
      await db.collection("properties").updateOne({ propertyId: PROPERTY }, { $set: { name: orig } });
      return { ok, detail: `name "${orig}" -> "${after?.name}" [${tools.join(",")}]` };
    },
  },
  {
    name: "reservation_notes",
    run: async () => {
      const rv = await db.collection("reservations").findOne({ propertyId: PROPERTY, status: "confirmed" });
      const note = `${TAG} nota`;
      const { tools } = await drive([`Agregale la nota interna "${note}" a la reserva ${rv.reservationCode}`, CONFIRM]);
      const after = await db.collection("reservations").findOne({ reservationId: rv.reservationId });
      const ok = String(after?.internalNotes ?? "").includes(TAG);
      await db.collection("reservations").updateOne({ reservationId: rv.reservationId }, { $set: { internalNotes: rv.internalNotes ?? "" } });
      return { ok, detail: `internalNotes="${after?.internalNotes}" [${tools.join(",")}]` };
    },
  },
  {
    name: "reservation_checkin",
    run: async () => {
      // Precondicion: una reserva confirmed con unidad asignada en estado
      // AVAILABLE (check-in la ocupa; occupied->occupied seria invalido). Si la
      // unidad no esta available, la dejamos available temporalmente (snapshot)
      // para poder probar el check-in, y revertimos al final.
      const rv = await db.collection("reservations").findOne({ propertyId: PROPERTY, status: "confirmed", assignedUnitId: { $ne: null } });
      if (!rv) return { ok: false, detail: "no hay confirmed con unidad asignada" };
      const unit = await db.collection("units").findOne({ unitId: rv.assignedUnitId }, { projection: { status: 1 } });
      if (unit && unit.status !== "available") {
        await db.collection("units").updateOne({ unitId: rv.assignedUnitId }, { $set: { status: "available" } });
      }
      const { tools } = await drive([`Hacé el check-in de la reserva ${rv.reservationCode}`, CONFIRM]);
      const after = await db.collection("reservations").findOne({ reservationId: rv.reservationId }, { projection: { status: 1 } });
      const ok = after?.status === "checked-in";
      // revertir reserva Y unidad
      await db.collection("reservations").updateOne({ reservationId: rv.reservationId }, { $set: { status: "confirmed" } });
      await db.collection("units").updateOne({ unitId: rv.assignedUnitId }, { $set: { status: unit.status } });
      return { ok, detail: `status="${after?.status}" [${tools.join(",")}]` };
    },
  },
  {
    name: "unit_status",
    run: async () => {
      const u = await db.collection("units").findOne({ propertyId: PROPERTY, status: { $in: ["available", "cleaning"] } });
      const orig = u.status;
      const target = orig === "available" ? "maintenance" : "available";
      const { tools } = await drive([`Cambiá el estado de la habitación ${u.code ?? u.name} (unitId ${u.unitId}) a ${target === "maintenance" ? "mantenimiento" : "disponible"}`, CONFIRM]);
      const after = await db.collection("units").findOne({ unitId: u.unitId }, { projection: { status: 1 } });
      const ok = after?.status === target;
      await db.collection("units").updateOne({ unitId: u.unitId }, { $set: { status: orig } });
      return { ok, detail: `status "${orig}" -> "${after?.status}" (target ${target}) [${tools.join(",")}]` };
    },
  },
  {
    name: "category_create",
    run: async () => {
      const nm = `${TAG}-Cat`;
      const { tools } = await drive([`Creá una categoría de habitación llamada "${nm}", para 2 adultos y 1 niño, precio base 100 USD. Si la propiedad está en modo unidad, usá modoVenta unidad.`, CONFIRM, CONFIRM]);
      const found = await db.collection("categories").findOne({ propertyId: PROPERTY, name: nm });
      const ok = Boolean(found);
      if (found) await db.collection("categories").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "rateplan_create",
    run: async () => {
      const nm = `${TAG}-Rate`;
      const { tools } = await drive([`Creá un plan de tarifas llamado "${nm}" para la primera categoría de habitación que tengamos, vigente del 1 al 10 de agosto de 2026, a 120 USD por noche`, CONFIRM, CONFIRM]);
      const found = await db.collection("rateplans").findOne({ propertyId: PROPERTY, name: nm });
      const ok = Boolean(found);
      if (found) await db.collection("rateplans").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "promo_create",
    run: async () => {
      const code = `${TAG}P`;
      const { tools } = await drive([`Creá una promoción llamada "${code}" de tipo código, con código "${code}", 10% de descuento (porcentaje)`, CONFIRM, CONFIRM]);
      const found = await db.collection("promos").findOne({ propertyId: PROPERTY, code });
      const ok = Boolean(found);
      if (found) await db.collection("promos").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "service_create",
    run: async () => {
      const nm = `${TAG}-Svc`;
      const { tools } = await drive([`Creá un servicio de la propiedad llamado "${nm}", 50 USD por uso, en la primera categoría de servicio disponible`, CONFIRM, CONFIRM]);
      const found = await db.collection("services").findOne({ propertyId: PROPERTY, title: nm });
      const ok = Boolean(found);
      if (found) await db.collection("services").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "amenity_create",
    run: async () => {
      const nm = `${TAG}-Amen`;
      const { tools } = await drive([`Creá una amenity de la propiedad (tipo property) llamada "${nm}"`, CONFIRM, CONFIRM]);
      const found = await db.collection("amenities").findOne({ propertyId: PROPERTY, title: nm });
      const ok = Boolean(found);
      if (found) await db.collection("amenities").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "gallery_create",
    run: async () => {
      const nm = `${TAG}-Gal`;
      const { tools } = await drive([`Creá una galería llamada "${nm}"`, CONFIRM, CONFIRM]);
      const found = await db.collection("galleries").findOne({ propertyId: PROPERTY, title: nm });
      const ok = Boolean(found);
      if (found) await db.collection("galleries").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "review_create",
    run: async () => {
      const cmt = `${TAG} reseña`;
      const { tools } = await drive([`Creá una reseña manual (source own) con rating 5 y texto "${cmt}", autor "Tester E2E"`, CONFIRM, CONFIRM]);
      const found = await db.collection("reviews").findOne({ propertyId: PROPERTY, text: { $regex: TAG } });
      const ok = Boolean(found);
      if (found) await db.collection("reviews").deleteOne({ _id: found._id });
      else await db.collection("reviews").deleteMany({ propertyId: PROPERTY, authorName: "Tester E2E" });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "operative_space_create",
    run: async () => {
      const nm = `${TAG}-Space`;
      const { tools } = await drive([`Creá un espacio operativo llamado "${nm}"`, CONFIRM]);
      const found = await db.collection("operativespaces").findOne({ propertyId: PROPERTY, name: nm });
      const ok = Boolean(found);
      if (found) await db.collection("operativespaces").deleteOne({ _id: found._id });
      return { ok, detail: `creada=${ok} [${tools.join(",")}]` };
    },
  },
  {
    name: "hotel_notification_email_update",
    run: async () => {
      const col = db.collection("enginesettings");
      const before = await col.findOne({ propertyId: PROPERTY });
      const target = `${TAG}@test.com`;
      const { tools } = await drive([`Configurá el email de avisos del hotel en "${target}"`, CONFIRM]);
      const after = await col.findOne(
        { propertyId: PROPERTY },
        { projection: { hotelNotificationEmail: 1 } },
      );
      const ok = after?.hotelNotificationEmail === target;
      if (before) {
        await col.updateOne(
          { propertyId: PROPERTY },
          { $set: { hotelNotificationEmail: before.hotelNotificationEmail ?? "" } },
        );
      }
      return { ok, detail: `hotelNotificationEmail="${after?.hotelNotificationEmail}" [${tools.join(",")}]` };
    },
  },
];

async function main() {
  // OJO: mongoose.disconnect() cierra TODAS las conexiones (incluida la pms de
  // createConnection). Por eso NO desconectamos a mitad: dejamos ambas abiertas
  // (default = internal para AgentDefinition; pms para verificar/limpiar) y
  // recien cerramos al final.
  const pms = await mongoose.createConnection(process.env.PMS_MONGODB_URI!).asPromise();
  db = pms.db!;
  await connectDB();
  const a = await AgentDefinition.findOne({ slug: "asistente-de-operaciones" });
  AGENT_ID = a!.agentId;
  console.log(`E2E agente=${AGENT_ID} property=${PROPERTY} TAG=${TAG}\nOperaciones: ${OPS.length}`);

  for (const op of OPS) await execOp(op);

  console.log(`\n===================== ${pass} OK / ${fail} FAIL =====================`);
  results.forEach((r) => console.log(r));
  await mongoose.disconnect();
  await pms.close().catch(() => {});
  // pequeño respiro para que el stdout bufferizado se vacie antes de salir
  await new Promise((r) => setTimeout(r, 150));
  process.exitCode = fail > 0 ? 1 : 0;
}
main().catch((e) => { console.error("crash:", e); process.exitCode = 1; });
