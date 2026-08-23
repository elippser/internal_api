/**
 * Capa 1 del aislamiento: filtrado automático por ámbito (§8).
 *
 * Ningún servicio del motor construye una consulta de negocio sin pasar por
 * `scopedFilter`. La razón es que el modo de falla del filtrado manual es
 * silencioso y catastrófico: una consulta a la que se le olvidó el `tenantId`
 * no da error, da DE MÁS — devuelve las filas de otros inquilinos y nadie se
 * entera hasta que un cliente ve datos ajenos.
 *
 * Semántica de ámbito, que es la pieza central del modelo de permisos (§7.2):
 *
 *   tenantId  organizationId  significado
 *   --------  --------------  -------------------------------------------------
 *   definido  nulo            ámbito de inquilino: sólo actúa sobre el suyo
 *   nulo      definido        ámbito de organización: cualquier inquilino de esa org
 *   nulo      nulo            ámbito de sistema: entre organizaciones
 *
 * Un `tenantId` nulo NO significa "sin filtro". Significa recursos GLOBALES de
 * plataforma. El ámbito de sistema se pide explícitamente con `crossTenant`, y
 * sólo lo puede activar una credencial de organización o de sistema — nunca el
 * cuerpo de una petición.
 */
import type { FilterQuery } from "mongoose";
import { currentScope, type EngineScope } from "../core/scope";

export interface ScopeFilterOptions {
  /**
   * Incluir además los recursos globales (tenantId nulo). Verdadero por
   * defecto: un inquilino ve sus agentes Y los de plataforma.
   */
  includeGlobal?: boolean;
  /** Ámbito explícito. Si se omite, se lee del contexto ambiental. */
  scope?: EngineScope;
}

/**
 * Construye la porción de ámbito de un filtro. Se compone con el resto de la
 * consulta por `$and` para que un `$or` propio del llamador no anule el
 * aislamiento — pegar ambos `$or` al mismo nivel del objeto haría que el
 * segundo sobrescriba al primero, que es exactamente la fuga que este módulo
 * evita.
 */
export function scopeClause(opts: ScopeFilterOptions = {}): FilterQuery<Record<string, unknown>> {
  const scope = opts.scope ?? currentScope();
  const includeGlobal = opts.includeGlobal !== false;

  // Ámbito de sistema: ve entre organizaciones. Sin cláusula.
  if (scope.crossTenant) return {};

  if (scope.tenantId) {
    return includeGlobal
      ? { $or: [{ tenantId: scope.tenantId }, { tenantId: null }] }
      : { tenantId: scope.tenantId };
  }

  if (scope.organizationId) {
    return includeGlobal
      ? { $or: [{ organizationId: scope.organizationId }, { tenantId: null }] }
      : { organizationId: scope.organizationId };
  }

  // Sin inquilino ni organización y sin ámbito de sistema: sólo lo global.
  return { tenantId: null };
}

/** Compone un filtro de negocio con la cláusula de ámbito, de forma segura. */
export function scopedFilter<T>(
  filter: FilterQuery<T>,
  opts: ScopeFilterOptions = {},
): FilterQuery<T> {
  const clause = scopeClause(opts);
  if (Object.keys(clause).length === 0) return filter;
  return { $and: [filter, clause] } as FilterQuery<T>;
}

/**
 * Capa 2 del aislamiento: comprobación de escritura. Leer un recurso global es
 * legítimo; ESCRIBIRLO desde un inquilino no lo es. Compartir concede lectura y
 * ejecución, jamás escritura (§35.9).
 */
export function assertCanWrite(resource: { tenantId?: string | null }, what = "el recurso"): void {
  const scope = currentScope();
  if (scope.crossTenant) return;

  if (resource.tenantId === null) {
    if (!scope.organizationId && !scope.crossTenant) {
      throw new Error(
        `[engine] intento de escribir ${what} de plataforma desde un ámbito de inquilino`,
      );
    }
    return;
  }

  if (scope.tenantId && resource.tenantId !== scope.tenantId) {
    throw new Error(`[engine] intento de escribir ${what} de otro inquilino`);
  }
}
