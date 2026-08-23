import {
  clearUserScopeCache,
  resolveUserScope,
  type SpaceAppClaim,
  type SpacePermissionsClaim,
} from "./userScope";

/**
 * Claims de ESPACIO OPERATIVO para el JWT delegado del agente.
 *
 * Las sub-apps (booking-app, rooms-app, rms-app) protegen sus rutas con
 * `requireSpaceAccess(appId, "operate"|"write")`, que lee `spacePermissions` del
 * token. owner/admin hacen bypass; cualquier otro rol sin el claim recibe 403
 * NO_ACTIVE_SPACE. Como el JWT delegado no lo llevaba, el agente solo podia
 * operar esas apps en nombre de un owner/admin — y el RMS, cuyo modulo entero
 * vive detras de `requireSpaceAccess("revenue", …)`, quedaba inaccesible para
 * el staff que si tiene acceso desde la UI del PMS.
 *
 * Desde que el runtime resuelve el ALCANCE COMPLETO del usuario (ver
 * `userScope.ts`: rol, capabilities, propiedades y espacio) este modulo es una
 * vista parcial de eso: mismo GET /user/profile, mismo cache. Se conserva la
 * API para no tocar `mintAgentJwt`.
 */

export type { SpaceAppClaim, SpacePermissionsClaim };

export interface AgentSpaceClaims {
  activeOperativeSpaceId?: string;
  spacePermissions?: SpacePermissionsClaim;
}

/**
 * Espacio operativo activo + permisos por app del usuario, segun pms-core.
 *
 * Best-effort: si pms-core no responde o el usuario no tiene espacio activo,
 * devuelve `{}` y el JWT sale como salia antes. El agente pierde acceso a las
 * rutas con `requireSpaceAccess` (403 accionable), nunca gana acceso de mas.
 */
export async function resolveSpaceClaims(
  secret: string,
  userId: string,
  companyId?: string,
): Promise<AgentSpaceClaims> {
  const scope = await resolveUserScope(secret, userId, companyId);
  if (!scope.space && !scope.activeOperativeSpaceId) return {};
  return {
    activeOperativeSpaceId: scope.activeOperativeSpaceId,
    spacePermissions: scope.space,
  };
}

/** Invalida el cache (tests y cambios de espacio disparados por el propio agente). */
export function clearSpaceClaimsCache(userId?: string, companyId?: string): void {
  clearUserScopeCache(userId, companyId);
}
