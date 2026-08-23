/**
 * Bitácora estructurada del motor (§23).
 *
 * Dos propiedades que la hacen útil en producción y que un `console.log` suelto
 * no da:
 *   1. Cada línea lleva el ámbito ambiental (inquilino, ejecución, agente,
 *      trabajador) sin que quien loguea tenga que acordarse de pasarlo. Una
 *      corrida se sigue grepeando por `executionId` y aparece completa.
 *   2. Fuera de desarrollo el formato es JSON de una línea, para que el
 *      agregador de logs no tenga que adivinar dónde empieza un mensaje.
 *
 * El filtro de contexto se instala acá y no en cada sitio de llamada porque un
 * log sin correlación, en un sistema con N trabajadores concurrentes, es ruido.
 */
import { currentScope } from "./scope";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.ENGINE_LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const isProd = process.env.NODE_ENV === "production";

function emit(
  level: LogLevel,
  component: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;

  const scope = currentScope();
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(scope.executionId ? { executionId: scope.executionId } : {}),
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(scope.workerId ? { workerId: scope.workerId } : {}),
    ...(fields ?? {}),
  };

  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (isProd) {
    sink(JSON.stringify(record));
    return;
  }

  // En desarrollo la lectura humana gana: prefijo compacto + campos al final.
  const tags = [scope.executionId, scope.workerId].filter(Boolean).join(" ");
  const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  sink(`[${component}] ${level.toUpperCase()} ${message}${tags ? ` (${tags})` : ""}${extra}`);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(suffix: string): Logger;
}

export function createLogger(component: string): Logger {
  return {
    debug: (m, f) => emit("debug", component, m, f),
    info: (m, f) => emit("info", component, m, f),
    warn: (m, f) => emit("warn", component, m, f),
    error: (m, f) => emit("error", component, m, f),
    child: (suffix: string) => createLogger(`${component}:${suffix}`),
  };
}

/** Serializa un error para un campo de log sin arrastrar el stack entero a prod. */
export function errField(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err: err.message,
      errName: err.name,
      ...(isProd ? {} : { stack: err.stack }),
    };
  }
  return { err: String(err) };
}
