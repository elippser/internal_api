import "dotenv/config";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { connectDB } from "../shared/db";
import { AnalyticsEvent } from "../modules/analytics/analytics.model";
import { MetricsDaily } from "../modules/metrics/metrics.model";

/**
 * Smoke de la cadena de métricas de punta a punta:
 *   ingesta (auth + registry + idempotencia) → analytics_events → rollup → API.
 *
 *   npm run smoke:metrics
 *
 * Requiere el api corriendo en :8600. Escribe unos pocos eventos con una
 * compañía sintética y los borra al final, así se puede correr contra la base
 * de desarrollo sin ensuciar las métricas reales.
 *
 * Verifica lo que se rompe en silencio si alguien toca la ingesta: que sin
 * secret devuelva 401, que un evento fuera del registry se descarte, que un
 * payload incompleto se descarte, y que un reintento con el mismo
 * correlationId no cuente dos veces.
 */

const API = process.env.SMOKE_API_URL || "http://localhost:8600";
const SECRET = process.env.PMS_INTERNAL_SECRET || "";
const SMOKE_COMPANY = "SMOKE-METRICS";

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : " FALLA"} ${label}${detail ? ` → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures += 1;
}

async function post(body: unknown, withSecret = true): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}/api/v1/analytics/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withSecret ? { "X-Internal-Secret": SECRET } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 401 puede no traer json */
  }
  return { status: res.status, json };
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventName: "app_opened",
    source: "pms-core",
    companyId: SMOKE_COMPANY,
    sessionId: "smoke-session",
    clientTimestamp: new Date().toISOString(),
    payload: { appId: "informes" },
    ...over,
  };
}

async function run(): Promise<void> {
  if (!SECRET) throw new Error("PMS_INTERNAL_SECRET vacío: no se puede probar la ingesta");
  await connectDB();

  console.log("→ ingesta");
  check("sin secret responde 401", (await post(event(), false)).status === 401);

  const unknown = await post(event({ eventName: "evento_que_no_existe" }));
  check("evento fuera del registry se descarta", unknown.json.accepted === 0, unknown.json);

  const badSource = await post(event({ source: "web-renderer" }));
  check("source no autorizada se descarta", badSource.json.accepted === 0, badSource.json);

  const badPayload = await post(event({ payload: {} }));
  check("payload sin campo obligatorio se descarta", badPayload.json.accepted === 0, badPayload.json);

  const cid = `smoke:${Date.now()}`;
  const first = await post(event({ correlationId: cid }));
  check("evento válido se acepta", first.json.accepted === 1, first.json);

  const retry = await post(event({ correlationId: cid }));
  check("reintento con mismo correlationId no duplica", retry.json.accepted === 0, retry.json);

  const batch = await post({
    events: [
      event({ correlationId: `${cid}:a` }),
      event({ eventName: "no_existe", correlationId: `${cid}:b` }),
    ],
  });
  check("lote mixto acepta sólo lo válido", batch.json.accepted === 1, batch.json);

  const persisted = await AnalyticsEvent.countDocuments({ companyId: SMOKE_COMPANY });
  check("quedaron persistidos los 2 aceptados", persisted === 2, { persisted });

  console.log("→ rollup y API");
  const token = jwt.sign(
    { userId: "smoke", email: "smoke@bookfer.com", role: "super_admin" },
    process.env.JWT_SECRET as string,
    { expiresIn: "5m" },
  );
  const health = await fetch(`${API}/api/v1/metrics/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // `ok()` devuelve el objeto sin envolver, así que la salud está en la raíz.
  // (Leerla de `.data` hacía que el chequeo pasara siempre: `undefined <= 1`
  // nunca se evaluaba y un rollup rancio no lo detectaba nadie.)
  const healthJson = (await health.json()) as {
    rollup?: { staleDays?: number | null; lastError?: string | null };
  };
  check("/metrics/health responde", health.status === 200);
  const stale = healthJson.rollup?.staleDays;
  check(
    "el rollup corrió y no está rancio (<= 1 día)",
    typeof stale === "number" && stale <= 1,
    { staleDays: stale },
  );
  check("el rollup no dejó error", !healthJson.rollup?.lastError, {
    lastError: healthJson.rollup?.lastError,
  });

  const overview = await fetch(`${API}/api/v1/metrics/overview`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("/metrics/overview responde", overview.status === 200);

  const pilot = await fetch(`${API}/api/v1/metrics/pilot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("/metrics/pilot responde", pilot.status === 200);

  console.log("→ limpieza");
  const del = await AnalyticsEvent.deleteMany({ companyId: SMOKE_COMPANY });
  check("eventos de prueba borrados", del.deletedCount === persisted, { borrados: del.deletedCount });
  await MetricsDaily.deleteMany({ companyId: SMOKE_COMPANY });

  await mongoose.disconnect();

  console.log(failures === 0 ? "\nsmoke OK" : `\nsmoke con ${failures} falla(s)`);
  if (failures > 0) process.exit(1);
}

run().catch(async (err) => {
  console.error("smoke falló:", err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
