/**
 * Ámbito ambiental por tarea asíncrona (§8).
 *
 * Mongo no tiene seguridad a nivel de fila, así que el aislamiento del motor se
 * defiende en DOS capas en vez de tres: repositorio (filtro automático por
 * `tenantId`) y servicio (reglas de visibilidad). Esta variable de contexto es
 * lo que hace posible la primera: el repositorio base la lee sin que cada
 * servicio tenga que pasarla a mano, y por lo tanto no existe el camino
 * "me olvidé de filtrar".
 *
 * Se usa AsyncLocalStorage (no una variable de módulo) porque el proceso
 * atiende peticiones concurrentes: una global se pisaría entre inquilinos, que
 * es exactamente la fuga que este módulo existe para prevenir.
 *
 * `tenantId: null` significa **ámbito de plataforma** (agente global). No
 * significa "sin filtro": el repositorio lo traduce a "sólo filas globales"
 * salvo que el llamador pida explícitamente el ámbito de sistema.
 */
import { AsyncLocalStorage } from "async_hooks";

export interface EngineScope {
  /** Inquilino activo. En internal-laupser el inquilino es la `companyId`. */
  tenantId: string | null;
  /** Techo de ámbito. Ancla de un agente global. */
  organizationId: string | null;
  /** Usuario en cuyo nombre se actúa (para tools con identidad delegada). */
  userId?: string | null;
  /** Rol efectivo del principal, para el filtrado de herramientas por piso. */
  role?: string | null;
  /** Ejecución en curso, para la bitácora estructurada. */
  executionId?: string | null;
  agentId?: string | null;
  workerId?: string | null;
  /**
   * Ámbito de sistema: ve entre inquilinos. Sólo lo puede activar una credencial
   * de organización o de sistema (ver deps de la API), nunca el cuerpo de una
   * petición.
   */
  crossTenant?: boolean;
}

const storage = new AsyncLocalStorage<EngineScope>();

const EMPTY: EngineScope = { tenantId: null, organizationId: null };

/** Ámbito actual. Nunca lanza: fuera de un `runWithScope` devuelve el vacío. */
export function currentScope(): EngineScope {
  return storage.getStore() ?? EMPTY;
}

/** Corre `fn` bajo un ámbito. Todo lo que await-ee adentro lo hereda. */
export function runWithScope<T>(scope: EngineScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * Extiende el ámbito actual. Lo usa el corredor para sumar `executionId` sin
 * perder el inquilino que ya venía puesto.
 */
export function extendScope<T>(patch: Partial<EngineScope>, fn: () => T): T {
  return storage.run({ ...currentScope(), ...patch }, fn);
}

/**
 * Inquilino requerido. Lo llaman los caminos que NO pueden correr sin ámbito
 * (crear una ejecución, escribir memoria). Fallar acá es preferible a escribir
 * una fila sin `tenantId` que después nadie puede filtrar ni borrar.
 */
export function requireTenant(): string {
  const t = currentScope().tenantId;
  if (!t) {
    throw new Error(
      "[engine] operación con ámbito de inquilino invocada sin tenantId en el contexto",
    );
  }
  return t;
}
