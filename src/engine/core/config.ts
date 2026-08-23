/**
 * Configuración tipada del motor, desde variables de entorno, cacheada como
 * instancia única (§30).
 *
 * Dos reglas que valen la pena:
 *   - Cada servicio opcional expone un derivado `*Enabled` para degradar con
 *     elegancia. El motor arranca sin almacenamiento de objetos, sin telemetría
 *     y sin sandbox; no arranca sin base de datos.
 *   - Los valores se leen UNA vez y se congelan. Leer `process.env` en caliente
 *     hace que dos ejecuciones concurrentes puedan ver configuraciones distintas
 *     si alguien toca el entorno, y vuelve irreproducible cualquier incidente.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["false", "0", "no", "off"].includes(raw.toLowerCase());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export interface EngineConfig {
  readonly environment: string;
  readonly debug: boolean;

  readonly worker: {
    /** Si el worker arranca dentro del proceso API o corre aparte. */
    readonly enabled: boolean;
    /** Identidad del proceso. Aparece en cada fila reclamada y en la evidencia de zombie. */
    readonly id: string;
    /** Ranuras concurrentes POR CARRIL. Carriles disjuntos, conteos disjuntos. */
    readonly slots: { readonly root: number; readonly sub_agent: number; readonly coding: number };
    readonly pollIntervalMs: number;
    /** Cada cuánto el worker refresca el latido de sus corridas en vuelo. */
    readonly heartbeatIntervalMs: number;
    /**
     * Un latido más viejo que esto marca la corrida como expirada. Debe ser
     * varios múltiplos del intervalo: si es apenas mayor, una pausa de GC
     * declara zombie a un worker perfectamente vivo.
     */
    readonly zombieThresholdMs: number;
    readonly zombieSweepIntervalMs: number;
    /** Tiempo máximo de drenado ordenado; debe quedar por debajo del tope duro del orquestador. */
    readonly shutdownGraceMs: number;
    readonly healthFilePath: string | null;
  };

  readonly execution: {
    readonly defaultTimeoutSeconds: number;
    readonly maxDurationSeconds: number;
    /** Tope de iteraciones del bucle razonamiento-acción. */
    readonly maxIterations: number;
    /** Profundidad máxima de delegación. Permite auto-recursión sin bucle infinito. */
    readonly maxSubAgentDepth: number;
    /** Tope de caracteres de un resultado de herramienta antes de comprimir. */
    readonly maxToolResultChars: number;
  };

  readonly context: {
    /** Ventana de historial por defecto cuando el catálogo no sabe del modelo. */
    readonly fallbackWindowTokens: number;
    /** Proporción de la ventana que puede ocupar el historial. */
    readonly windowRatio: number;
    /** Reserva para la respuesta; se acota a un cuarto de la ventana. */
    readonly reserveTokens: number;
    readonly globalMaxTokens: number;
  };

  readonly observability: {
    /** TTL de las cargas crudas de proveedor (tabla fría). */
    readonly payloadTtlDays: number;
    /** TTL del diario de eventos. */
    readonly eventJournalTtlDays: number;
    readonly persistPayloads: boolean;
    readonly persistEventJournal: boolean;
  };

  readonly budget: {
    /** El presupuesto falla cerrado, pero se puede apagar por completo. */
    readonly enforcementEnabled: boolean;
  };

  /** Derivados de degradación elegante. */
  readonly payloadsEnabled: boolean;
  readonly eventJournalEnabled: boolean;
}

let cached: EngineConfig | null = null;

export function getEngineConfig(): EngineConfig {
  if (cached) return cached;

  const observability = {
    payloadTtlDays: num("ENGINE_PAYLOAD_TTL_DAYS", 14),
    eventJournalTtlDays: num("ENGINE_EVENT_TTL_DAYS", 30),
    persistPayloads: bool("ENGINE_PERSIST_PAYLOADS", true),
    persistEventJournal: bool("ENGINE_PERSIST_EVENTS", true),
  } as const;

  cached = Object.freeze({
    environment: str("NODE_ENV", "development"),
    debug: bool("ENGINE_DEBUG", process.env.NODE_ENV !== "production"),

    worker: Object.freeze({
      enabled: bool("ENGINE_WORKER_ENABLED", true),
      id: str("ENGINE_WORKER_ID", `${process.env.HOSTNAME ?? "local"}-${process.pid}`),
      slots: Object.freeze({
        root: num("ENGINE_SLOTS_ROOT", 4),
        sub_agent: num("ENGINE_SLOTS_SUB_AGENT", 4),
        coding: num("ENGINE_SLOTS_CODING", 1),
      }),
      pollIntervalMs: num("ENGINE_POLL_INTERVAL_MS", 1000),
      heartbeatIntervalMs: num("ENGINE_HEARTBEAT_INTERVAL_MS", 10_000),
      zombieThresholdMs: num("ENGINE_ZOMBIE_THRESHOLD_MS", 90_000),
      zombieSweepIntervalMs: num("ENGINE_ZOMBIE_SWEEP_INTERVAL_MS", 30_000),
      shutdownGraceMs: num("ENGINE_SHUTDOWN_GRACE_MS", 20_000),
      healthFilePath: process.env.ENGINE_HEALTH_FILE || null,
    }),

    execution: Object.freeze({
      defaultTimeoutSeconds: num("ENGINE_DEFAULT_TIMEOUT_S", 300),
      maxDurationSeconds: num("ENGINE_MAX_DURATION_S", 1800),
      maxIterations: num("ENGINE_MAX_ITERATIONS", 12),
      maxSubAgentDepth: num("ENGINE_MAX_SUBAGENT_DEPTH", 3),
      maxToolResultChars: num("ENGINE_MAX_TOOL_RESULT_CHARS", 60_000),
    }),

    context: Object.freeze({
      fallbackWindowTokens: num("ENGINE_FALLBACK_WINDOW_TOKENS", 32_000),
      windowRatio: num("ENGINE_WINDOW_RATIO", 0.6),
      reserveTokens: num("ENGINE_RESERVE_TOKENS", 16_000),
      globalMaxTokens: num("ENGINE_GLOBAL_MAX_CONTEXT_TOKENS", 400_000),
    }),

    observability: Object.freeze(observability),

    budget: Object.freeze({
      enforcementEnabled: bool("ENGINE_BUDGET_ENFORCEMENT", false),
    }),

    payloadsEnabled: observability.persistPayloads,
    eventJournalEnabled: observability.persistEventJournal,
  });

  return cached;
}

/** Sólo para pruebas: invalida la instancia única. */
export function resetEngineConfigCache(): void {
  cached = null;
}
