import cron from "node-cron";
import { runRollup } from "./metricsRollup.service";

/**
 * Consolidación diaria de métricas.
 *
 * Corre a las 05:15 UTC: después del snapshot del RMS (04:00 UTC), así el
 * rollup del día ya encuentra los facts frescos en vez de leer los de ayer.
 *
 * Kill switch: `METRICS_CRON_DISABLED=1`.
 */
export function startMetricsCron(): void {
  if (process.env.METRICS_CRON_DISABLED === "1") {
    console.log("[metrics] cron deshabilitado por METRICS_CRON_DISABLED");
    return;
  }

  cron.schedule("15 5 * * *", () => {
    void runRollup()
      .then(({ days, docs }) =>
        console.log(
          `[metrics] rollup ok: ${days.length} día(s), ${docs} doc(s)`,
        ),
      )
      .catch((err) =>
        console.error("[metrics] rollup falló:", err instanceof Error ? err.message : err),
      );
  });

  console.log("[metrics] cron programado (05:15 UTC)");
}
