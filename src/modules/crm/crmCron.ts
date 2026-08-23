import cron from "node-cron";
import { crmService } from "./crm.service";

const TZ = "America/Argentina/Buenos_Aires";

let started = false;

/**
 * Dos trabajos, con ritmos distintos a proposito:
 *
 *  - El outbox se drena seguido (cada minuto): un `lead.captured` que espera
 *    una hora para disparar su campana de bienvenida ya no sirve.
 *  - Las stats se recalculan de noche: son un escaneo de properties + un
 *    aggregate sobre los rollups, y ningun tablero necesita ese dato al minuto.
 */
export function startCrmCron() {
  if (started) return;
  started = true;

  if (process.env.CRM_CRON_DISABLED === "1") {
    console.log("[crm] cron deshabilitado");
    return;
  }

  cron.schedule(
    "* * * * *",
    () => {
      crmService.drainOutbox().then(
        (r) => {
          if (r.processed > 0) {
            console.log(
              `[crm] outbox: ${r.delivered} entregados, ${r.skipped} sin cuenta, ${r.failed} con error`,
            );
          }
        },
        (err) => console.error("[crm] outbox fallo:", err?.message ?? err),
      );
    },
    { timezone: TZ },
  );

  cron.schedule(
    "0 4 * * *",
    () => {
      crmService.refreshStats().then(
        (r) => console.log(`[crm] stats recalculadas: ${r.refreshed} cuentas`),
        (err) => console.error("[crm] refreshStats fallo:", err?.message ?? err),
      );
    },
    { timezone: TZ },
  );

  // Al arrancar: una pasada de stats para no esperar hasta las 4am la primera
  // vez. Con delay para no competir con la conexion inicial a los dos Mongo.
  if (process.env.CRM_STATS_ON_STARTUP !== "0") {
    setTimeout(() => {
      crmService
        .refreshStats()
        .catch((err) => console.error("[crm] stats de arranque:", err?.message ?? err));
    }, 15_000);
  }
}
