import { InternalUser } from "../../modules/users/users.model";
import { cleanAreaAccess, type AreaAccess } from "./areas";

/**
 * Estado vigente de un usuario interno para autorizar cada request: rol,
 * status, permisos por area y vencimiento. Se lee de la DB y no del JWT para
 * que una baja, un cambio de rol o un recorte de permisos rijan enseguida y no
 * cuando vence el token (8 h).
 *
 * Cache en memoria de 15 s: un panel abre ~10 requests por pantalla y no vale
 * la pena ir a Mongo por cada una. `invalidateUserAccess` se llama al editar,
 * asi que en este proceso el cambio es inmediato; en otra instancia tarda como
 * mucho el TTL.
 */

export interface UserAccess {
  userId: string;
  email: string;
  role: string;
  status: "active" | "inactive";
  areaAccess: AreaAccess;
  accessExpiresAt: Date | null;
}

const TTL_MS = 15_000;
const cache = new Map<string, { value: UserAccess | null; expiresAt: number }>();

export async function getUserAccess(userId: string): Promise<UserAccess | null> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const doc = await InternalUser.findOne({ userId })
    .select("userId email role status areaAccess accessExpiresAt")
    .lean();
  const value: UserAccess | null = doc
    ? {
        userId: doc.userId,
        email: doc.email,
        role: doc.role,
        status: doc.status as "active" | "inactive",
        areaAccess: cleanAreaAccess(doc.areaAccess),
        accessExpiresAt: doc.accessExpiresAt ?? null,
      }
    : null;
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidateUserAccess(userId: string): void {
  cache.delete(userId);
}

export function isAccessExpired(access: Pick<UserAccess, "accessExpiresAt">): boolean {
  return Boolean(access.accessExpiresAt && access.accessExpiresAt.getTime() <= Date.now());
}
