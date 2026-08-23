/**
 * Arranque del motor agéntico.
 *
 * Es IDEMPOTENTE y TOLERANTE, igual que el arranque de la API que lo invoca
 * (§3): cada paso está envuelto y sólo advierte si falla. El criterio es que un
 * subsistema opcional roto degrada una capacidad, mientras que un arranque que
 * aborta deja la aplicación entera afuera — incluidas las superficies que no
 * tienen nada que ver con el motor.
 *
 * Lo único que NO se tolera es la deriva del registro de herramientas, y aun
 * así sólo se advierte: se reporta ruidosamente con los nombres exactos para
 * que se note en el primer despliegue tras el cambio.
 */
import { getEngineConfig } from "./core/config";
import { createLogger, errField } from "./core/logger";
import { registerBuiltinTools } from "./tools/builtins";
import { assertAllowlistIntegrity } from "./tools/registry";
import { installInlineGraphRunner } from "./runtime/inline";
import { warmOpenRouterCatalog } from "./llm/providers/openrouterCatalog";
import { startWorker, shutdownWorker } from "./worker";

const log = createLogger("engine:bootstrap");

let booted = false;

export interface BootstrapResult {
  workerStarted: boolean;
  allowlistOk: boolean;
  problems: string[];
}

/**
 * Inicializa el motor. Llamar desde el arranque de la API, DESPUÉS de conectar
 * a la base: el registro no la necesita, pero el worker empieza a reclamar de
 * inmediato y sin conexión sólo produciría ruido de errores.
 */
export function bootstrapEngine(): BootstrapResult {
  const cfg = getEngineConfig();
  const problems: string[] = [];

  if (booted) {
    return { workerStarted: cfg.worker.enabled, allowlistOk: true, problems };
  }
  booted = true;

  // 1. Herramientas de código al registro.
  try {
    registerBuiltinTools();
  } catch (err) {
    problems.push("no se pudieron registrar las herramientas de código");
    log.error("fallo al registrar herramientas de código", errField(err));
  }

  // 2. Corredor en línea, para romper el ciclo grafo <-> sub-agentes.
  try {
    installInlineGraphRunner();
  } catch (err) {
    problems.push("no se pudo instalar el corredor de grafos en línea");
    log.error("fallo al instalar el corredor en línea", errField(err));
  }

  // 3. Prueba de deriva: registrado <=> en la lista de permitidos.
  let allowlistOk = true;
  try {
    const integrity = assertAllowlistIntegrity();
    allowlistOk = integrity.ok;
    problems.push(...integrity.problems);
  } catch (err) {
    allowlistOk = false;
    log.error("fallo la verificación de deriva del registro", errField(err));
  }

  // 4. Precalentado del catálogo del gateway agregador (§3, §11.3).
  //    Va en segundo plano a propósito: la consulta de capacidades es SÍNCRONA
  //    y está en el camino caliente, así que necesita el caché en memoria — pero
  //    bloquear el arranque de la API por un catálogo de metadata sería atar la
  //    disponibilidad del panel entero a un servicio de terceros.
  void warmOpenRouterCatalog()
    .then((warm) => {
      if (warm) log.info("catálogo de OpenRouter listo");
    })
    .catch((err) => log.warn("precalentado de OpenRouter fallido", errField(err)));

  // 5. Trabajador.
  let workerStarted = false;
  try {
    startWorker();
    workerStarted = cfg.worker.enabled;
  } catch (err) {
    problems.push("no se pudo arrancar el trabajador");
    log.error("fallo al arrancar el trabajador", errField(err));
  }

  log.info("motor agéntico listo", {
    workerStarted,
    allowlistOk,
    problems: problems.length,
  });

  return { workerStarted, allowlistOk, problems };
}

export { shutdownWorker };
export { getEngineConfig };
