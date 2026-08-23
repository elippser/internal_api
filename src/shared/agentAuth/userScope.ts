import jwt from "jsonwebtoken";
import { pmsRequest } from "../middleware/pmsProxy";
import {
  COMPANY_CAPABILITIES,
  isCompanyCapability,
  roleIsAdmin,
  type CompanyCapability,
  type OSAppAccess,
  type PmsRole,
} from "./pmsAccessCatalog";

/**
 * ALCANCE EFECTIVO del hotelero en nombre del cual opera el agente.
 *
 * Es la foto completa de lo que el PMS le permite hacer al usuario AHORA:
 * rol en la company, capacidades administrativas, propiedades visibles y el
 * espacio operativo activo con su nivel por app. El runtime del chat la usa
 * para (1) no ofrecerle al modelo herramientas que el usuario no puede usar,
 * (2) rechazar en el propio runtime cualquier tool call fuera de alcance antes
 * de pegarle al PMS y (3) contarle al modelo, en el prompt, qué puede y qué no
 * puede hacer este usuario para que lo explique en vez de improvisar.
 *
 * NO reimplementa la resolución de permisos: se la pide a pms-core con el
 * mismo GET /user/profile que ya usaba `spaceClaims.ts` (que ahora es una vista
 * parcial de esto). pms-core devuelve `role`, `capabilities`, `allProperties`,
 * `propertyIds`, `activeOperativeSpaceId` y `spacePermissions` ya resueltos
 * desde la membership activa — la única fuente de verdad. Duplicar esa lógica
 * acá garantizaba dos copias desincronizadas de una decisión de autorización.
 *
 * Es un snapshot, nunca una elevación: si pms-core no responde, el alcance
 * queda VACÍO (sin rol, sin apps, sin capabilities) y el agente pierde
 * escrituras hasta el próximo turno; nunca gana acceso de más.
 */

export interface SpaceAppClaim {
  appId: string;
  access: OSAppAccess;
  modules?: unknown;
}

export interface SpacePermissionsClaim {
  spaceId: string;
  propertyId: string;
  isAdmin: boolean;
  apps: SpaceAppClaim[];
}

export interface UserScope {
  userId: string;
  /** Company sobre la que pms-core resolvió el alcance (su activeCompanyId). */
  companyId?: string;
  role?: PmsRole | string;
  /** owner/admin: bypass total de apps y capabilities (como en el PMS). */
  isAdmin: boolean;
  capabilities: CompanyCapability[];
  /** true = ve todas las propiedades del tenant (presentes y futuras). */
  allProperties: boolean;
  /** Sólo significativo cuando allProperties === false. */
  propertyIds: string[];
  activeOperativeSpaceId?: string;
  space?: SpacePermissionsClaim;
  /** El perfil se pudo leer del PMS. false = alcance vacío por fallo/timeout. */
  resolved: boolean;
  /** Password temporal pendiente: el PMS rechaza todo salvo cambiarla. */
  mustChangePassword: boolean;
}

interface UserProfileResponse {
  userId?: string;
  role?: string;
  activeCompanyId?: string;
  activeCompany?: string;
  companyId?: string;
  capabilities?: string[];
  allProperties?: boolean;
  propertyIds?: string[];
  activeOperativeSpaceId?: string;
  spacePermissions?: SpacePermissionsClaim;
  mustChangePassword?: boolean;
}

const CACHE_TTL_MS = 60_000;
/**
 * Un fallo (PMS caído / timeout) se cachea poco: lo suficiente para no
 * reintentar en cada tool call del mismo turno, pero no tanto como para dejar
 * al agente sin permisos un minuto entero por un hipo de 4 segundos.
 */
const FAIL_TTL_MS = 10_000;
/** El bootstrap solo tiene que sobrevivir al GET de perfil. */
const BOOTSTRAP_TTL_SECONDS = 30;
const PROFILE_TIMEOUT_MS = 4000;

const cache = new Map<string, { value: UserScope; expiresAt: number }>();

function cacheKey(userId: string, companyId?: string): string {
  return `${userId}|${companyId ?? ""}`;
}

/**
 * JWT mínimo solo para autenticar el GET de perfil. Se firma acá y no con
 * `mintAgentJwt` a propósito: mintAgentJwt depende de esta resolución, y
 * reusarlo sería recursión infinita.
 */
function bootstrapToken(secret: string, userId: string, companyId?: string): string {
  return jwt.sign(
    {
      sub: userId,
      userId,
      companyId,
      activeCompany: companyId,
      iss: "internal-laupser-agent",
    },
    secret,
    { expiresIn: BOOTSTRAP_TTL_SECONDS },
  );
}

/** Alcance vacío: sin rol ni apps. Es lo que queda cuando el PMS no responde. */
export function emptyScope(userId: string, companyId?: string): UserScope {
  return {
    userId,
    companyId,
    isAdmin: false,
    capabilities: [],
    allProperties: false,
    propertyIds: [],
    resolved: false,
    mustChangePassword: false,
  };
}

function scopeFromProfile(
  userId: string,
  requestedCompanyId: string | undefined,
  p: UserProfileResponse,
): UserScope {
  const role = typeof p.role === "string" ? p.role : undefined;
  const isAdmin = roleIsAdmin(role);
  const companyId =
    (typeof p.activeCompanyId === "string" && p.activeCompanyId) ||
    (typeof p.activeCompany === "string" && p.activeCompany) ||
    (typeof p.companyId === "string" && p.companyId) ||
    requestedCompanyId;
  const capabilities = isAdmin
    ? [...COMPANY_CAPABILITIES]
    : (Array.isArray(p.capabilities) ? p.capabilities : []).filter(isCompanyCapability);
  // pms-core lee `allProperties: undefined` como true (memberships previas al
  // campo). Mismo criterio acá para no acotar de más a usuarios viejos.
  const allProperties = isAdmin ? true : p.allProperties !== false;
  const propertyIds = allProperties
    ? []
    : [...new Set((Array.isArray(p.propertyIds) ? p.propertyIds : []).filter(Boolean))];
  const space =
    p.spacePermissions && typeof p.spacePermissions === "object"
      ? {
          spaceId: String(p.spacePermissions.spaceId ?? ""),
          propertyId: String(p.spacePermissions.propertyId ?? ""),
          isAdmin: p.spacePermissions.isAdmin === true,
          apps: Array.isArray(p.spacePermissions.apps)
            ? p.spacePermissions.apps.map((a) => ({
                appId: String(a.appId),
                access: (a.access ?? "none") as OSAppAccess,
                modules: a.modules,
              }))
            : [],
        }
      : undefined;
  return {
    userId,
    companyId,
    role,
    isAdmin,
    capabilities,
    allProperties,
    propertyIds,
    activeOperativeSpaceId:
      typeof p.activeOperativeSpaceId === "string" ? p.activeOperativeSpaceId : undefined,
    space,
    resolved: true,
    mustChangePassword: p.mustChangePassword === true,
  };
}

/**
 * Alcance del usuario según pms-core (GET /user/profile con un JWT delegado de
 * bootstrap). Cache en memoria de TTL corto: el alcance cambia por acción
 * explícita de un admin, no a mitad de un turno; y `mintAgentJwt` lo consulta
 * en cada tool call.
 *
 * Best-effort: ante error devuelve el alcance VACÍO (y lo cachea igual, para no
 * reintentar en cada tool call de un turno con el PMS caído).
 */
export async function resolveUserScope(
  secret: string,
  userId: string,
  companyId?: string,
  opts: { force?: boolean } = {},
): Promise<UserScope> {
  const key = cacheKey(userId, companyId);
  const now = Date.now();
  const hit = cache.get(key);
  if (!opts.force && hit && hit.expiresAt > now) return hit.value;

  let scope = emptyScope(userId, companyId);
  try {
    // `/user/profile`, sin el prefijo /api/v1: en pms-core las rutas de usuario
    // son legacy y cuelgan de la raíz (`routes/index.ts`). Es el mismo endpoint
    // al que caen booking/rooms/rms cuando no pueden verificar el token local.
    const profile = await pmsRequest<UserProfileResponse>({
      service: "pms-core",
      path: "/user/profile",
      timeoutMs: PROFILE_TIMEOUT_MS,
      agentJwt: bootstrapToken(secret, userId, companyId),
    });
    if (profile && typeof profile === "object") {
      scope = scopeFromProfile(userId, companyId, profile);
    }
  } catch (err) {
    console.warn(
      "[agentAuth] no se pudo resolver el alcance del usuario (queda vacío este turno):",
      err instanceof Error ? err.message : err,
    );
  }

  cache.set(key, {
    value: scope,
    expiresAt: now + (scope.resolved ? CACHE_TTL_MS : FAIL_TTL_MS),
  });
  return scope;
}

/** Invalida el cache (tests y cambios de permisos disparados por el propio agente). */
export function clearUserScopeCache(userId?: string, companyId?: string): void {
  if (!userId) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(userId, companyId));
}

// ── Helpers de evaluación (misma semántica que los middlewares del PMS) ──────

/** Nivel de acceso a una app en el espacio activo. Admin: write en todo. */
export function appAccessOf(scope: UserScope, appId: string): OSAppAccess {
  if (scope.isAdmin || scope.space?.isAdmin) return "write";
  const app = scope.space?.apps.find((a) => a.appId === appId);
  return app?.access ?? "none";
}

/** Igual que `requireSpaceAccess(appId, level)`: operate acepta operate|write. */
export function hasAppAccess(
  scope: UserScope,
  appId: string,
  level: "operate" | "write",
): boolean {
  const access = appAccessOf(scope, appId);
  return level === "operate" ? access === "operate" || access === "write" : access === "write";
}

/** Igual que `requireCapability(...caps)`: alcanza con una (OR); admin pasa. */
export function hasCapability(scope: UserScope, ...caps: string[]): boolean {
  if (scope.isAdmin) return true;
  return caps.some((c) => (scope.capabilities as string[]).includes(c));
}

/** Igual que `canSeeProperty` de pms-core. */
export function canSeeProperty(scope: UserScope, propertyId?: string | null): boolean {
  if (scope.isAdmin || scope.allProperties) return true;
  if (!propertyId) return false;
  return scope.propertyIds.includes(propertyId);
}
