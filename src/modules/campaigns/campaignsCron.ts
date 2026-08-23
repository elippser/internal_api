import cron from "node-cron";
import { campaignsService } from "./campaigns.service";

const TZ = "America/Argentina/Buenos_Aires";

let started = false;

/**
 * Barre la cola de envios cada minuto. El `delayHours` de cada template ya
 * quedo resuelto en `sendAfter` al encolar, asi que este worker solo pregunta
 * que vencio — no tiene que entender de triggers ni de campañas.
 */
export function startCampaignsCron() {
  if (started) return;
  started = true;

  if (process.env.MKT_QUEUE_DISABLED === "1") {
    console.log("[campaigns] cola deshabilitada");
    return;
  }

  cron.schedule(
    "* * * * *",
    () => {
      campaignsService.processQueue().then(
        (r) => {
          if (r.processed > 0) {
            console.log(`[campaigns] cola: ${r.sent} enviados, ${r.failed} con error`);
          }
        },
        (err) => console.error("[campaigns] cola fallo:", err?.message ?? err),
      );
    },
    { timezone: TZ },
  );
}
