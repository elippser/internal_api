// Cron del motor de senales (spec v2 §6): martes 07:00 ART. El radar de
// entrantes sigue los lunes (radarCron); el change watch mensual de v1 lo
// absorbe el connector watched_pages (cadencia por pagina).
//
// CI_SIGNALS_CRON_DISABLED=1 lo apaga.

import cron from "node-cron";
import { runSignals } from "./signals.service";

const TZ = "America/Argentina/Buenos_Aires";
let started = false;

export function startSignalsCron() {
  if (started) return;
  started = true;
  if (process.env.CI_SIGNALS_CRON_DISABLED === "1") {
    console.log("[competitors] cron de señales deshabilitado (CI_SIGNALS_CRON_DISABLED=1)");
    return;
  }
  cron.schedule(
    "0 7 * * 2",
    () => {
      runSignals({ trigger: "cron" }).catch((err) => console.error("[competitors] señales (cron) falló:", err?.message ?? err));
    },
    { timezone: TZ },
  );
  console.log("[competitors] cron de señales programado (martes 07:00 ART)");
}
