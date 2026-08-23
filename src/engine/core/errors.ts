/**
 * Jerarquía de excepciones de dominio del motor, mapeada a códigos HTTP en un
 * ÚNICO manejador (`toHttpError`).
 *
 * La regla: los servicios y el motor lanzan errores de dominio, nunca objetos
 * con `.status` improvisados. Un solo punto de traducción evita que dos rutas
 * devuelvan códigos distintos para la misma falla, y permite decidir en un
 * lugar qué se reporta al sistema de errores (sólo 5xx: un 404 esperado no es
 * una falla del sistema).
 */

export type EngineErrorCode =
  | "not_found"
  | "unauthenticated"
  | "forbidden"
  | "conflict"
  | "validation"
  | "budget_exceeded"
  | "requires_reauth"
  | "not_implemented"
  | "internal";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly status: number;
  /** Contexto legible por máquina para que la UI no tenga que parsear strings. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: EngineErrorCode,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends EngineError {
  constructor(message = "Recurso no encontrado", details?: Record<string, unknown>) {
    super("not_found", 404, message, details);
  }
}

export class UnauthenticatedError extends EngineError {
  constructor(message = "No autenticado", details?: Record<string, unknown>) {
    super("unauthenticated", 401, message, details);
  }
}

export class ForbiddenError extends EngineError {
  constructor(message = "Permisos insuficientes", details?: Record<string, unknown>) {
    super("forbidden", 403, message, details);
  }
}

export class ConflictError extends EngineError {
  constructor(message = "Conflicto de estado", details?: Record<string, unknown>) {
    super("conflict", 409, message, details);
  }
}

export class ValidationError extends EngineError {
  constructor(message = "Entrada inválida", details?: Record<string, unknown>) {
    super("validation", 422, message, details);
  }
}

/**
 * Presupuesto agotado. 402 y no 429 a propósito: no es "probá más tarde", es
 * "hace falta plata". §35.7: la tarificación falla abierta, el presupuesto
 * falla cerrado.
 */
export class BudgetExceededError extends EngineError {
  constructor(message = "Presupuesto agotado", details?: Record<string, unknown>) {
    super("budget_exceeded", 402, message, details);
  }
}

/**
 * Un proveedor externo pide reautorización. Lleva código legible por máquina y
 * el proveedor, para que la interfaz renderice un banner de reconexión en vez
 * de analizar cadenas de error.
 */
export class RequiresReauthError extends EngineError {
  constructor(provider: string, message = "Se requiere reautorizar el proveedor") {
    super("requires_reauth", 401, message, { provider, action: "reauthorize" });
  }
}

/**
 * Extensión declarada pero no implementada en esta entrega. Se lanza explícito
 * en vez de fallar de forma opaca a mitad de ejecución: el autor del agente ve
 * un 501 con el punto de extensión exacto que hay que tocar.
 */
export class NotImplementedError extends EngineError {
  constructor(what: string, extensionPoint: string) {
    super("not_implemented", 501, `${what} no está implementado en esta entrega`, {
      extensionPoint,
    });
  }
}

/** Normaliza cualquier throwable a un EngineError. */
export function asEngineError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new EngineError("internal", 500, message);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

export interface HttpErrorBody {
  status: number;
  body: { error: string; code: EngineErrorCode; details?: Record<string, unknown> };
  /** Sólo los 5xx son fallas del sistema; un 4xx esperado no se reporta. */
  reportable: boolean;
}

export function toHttpError(err: unknown): HttpErrorBody {
  const e = asEngineError(err);
  return {
    status: e.status,
    body: {
      error: e.message,
      code: e.code,
      ...(e.details ? { details: e.details } : {}),
    },
    reportable: e.status >= 500,
  };
}
