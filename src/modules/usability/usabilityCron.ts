import cron from "node-cron";
import { runIaLabeling } from "./iaLabeler.service";
import { runUsabilityRollup } from "./usabilityRollup.service";

/**
 * Consolidacion diaria de usabilidad: 05:30 UTC, despues del rollup de
 * metricas (05:15). Recalcula ayer (completo) y hoy (parcial).
 *
 * Kill switch: `USABILITY_CRON_DISABLED=1`.
 */
export function startUsabilityCron(): void {
  if (process.env.USABILITY_CRON_DISABLED === "1") {
    console.log("[usability] cron deshabilitado por USABILITY_CRON_DISABLED");
    return;
  }
  cron.schedule("30 5 * * *", () => {
    void runUsabilityRollup()
      .then(({ days, docs }) => console.log(`[usability] rollup ok: ${days.join(", ")} · ${docs} doc(s)`))
      .catch((err) => console.error("[usability] rollup fallo:", err instanceof Error ? err.message : err));
  });
  // Etiquetado de la IA: 06:00 UTC, tope USD 1 y 2000 mensajes por corrida.
  // Kill switch propio (cuesta plata): USABILITY_IA_CRON_DISABLED=1.
  if (process.env.USABILITY_IA_CRON_DISABLED !== "1") {
    cron.schedule("0 6 * * *", () => {
      void runIaLabeling({ budgetUsd: 1, maxMessages: 2000 })
        .then((r) => console.log(`[usability-ia] ${r.labeled} etiquetadas, ${r.signalsOnly} solo señales, USD ${r.costUsd} (${r.stoppedBy})`))
        .catch((err) => console.error("[usability-ia] fallo:", err instanceof Error ? err.message : err));
    });
  }
  console.log("[usability] cron programado (05:30 UTC rollup, 06:00 UTC IA)");
}
