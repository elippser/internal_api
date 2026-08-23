// Crons del radar de competencia (spec §7.6). Horarios en ART.
//
//   search    lunes 07:00     busqueda de entrantes (connector web_search)
//   changes   dia 2, 07:30    change watch mensual (snapshot + hash de home/pricing)
//
// CI_RADAR_CRON_DISABLED=1 apaga los dos. Sin corrida al arrancar: el radar es
// semanal y barato, no hace falta poblar nada al boot.

import cron from "node-cron";
import { runRadar } from "./radar.service";

const TZ = "America/Argentina/Buenos_Aires";

let started = false;

export function startRadarCron() {
  if (started) return;
  started = true;

  if (process.env.CI_RADAR_CRON_DISABLED === "1") {
    console.log("[competitors] cron del radar deshabilitado (CI_RADAR_CRON_DISABLED=1)");
    return;
  }

  cron.schedule(
    "0 7 * * 1",
    () => {
      runRadar({ mode: "search", trigger: "cron" }).catch((err) =>
        console.error("[competitors] radar search (cron) falló:", err?.message ?? err),
      );
    },
    { timezone: TZ },
  );

  // v2: el change watch mensual lo absorbe el connector watched_pages del motor
  // de señales (cadencia por página, martes 07:00). `POST /radar/run {mode:
  // "changes"}` sigue disponible a mano para un barrido puntual.
  console.log("[competitors] cron del radar programado (search lunes 07:00 ART)");
}
