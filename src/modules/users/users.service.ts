import bcrypt from "bcrypt";
import { cleanAreaAccess, type AreaAccess } from "../../shared/access/areas";
import { invalidateUserAccess } from "../../shared/access/userAccessCache";
import { hasMinRole } from "../../shared/middleware/authorize";
import { makeId } from "../../shared/utils/ids";
import { InternalUser, type InternalRole, sanitizeUser } from "./users.model";

/** Quien hace el cambio (el operador logueado). */
export interface Actor {
  userId: string;
  role: InternalRole;
}

interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: InternalRole;
  areaAccess?: AreaAccess;
  accessExpiresAt?: Date | null;
}

interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  role?: InternalRole;
  status?: "active" | "inactive";
  password?: string;
  areaAccess?: AreaAccess;
  accessExpiresAt?: Date | null;
}

interface ListUsersInput {
  role?: InternalRole;
  status?: "active" | "inactive";
  page: number;
  limit: number;
  skip: number;
}

const BCRYPT_ROUNDS = 10;

function httpError(status: number, message: string, code: string): Error {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Reglas de quien puede tocar a quien:
 *   - Nadie asigna un rol por encima del suyo (un admin no crea super_admins).
 *   - Nadie edita a alguien de rol superior al suyo.
 *   - Nadie se cambia a si mismo rol, status, permisos ni vencimiento: evita
 *     tanto autoascenderse como dejarse afuera sin querer. Nombre y password si.
 */
function assertCanAssignRole(actor: Actor, role: InternalRole): void {
  if (!hasMinRole(actor.role, role)) {
    throw httpError(403, "No podes asignar un rol superior al tuyo", "role_above_actor");
  }
}

function assertCanManage(actor: Actor, target: { role: string }): void {
  if (!hasMinRole(actor.role, target.role as InternalRole)) {
    throw httpError(403, "No podes editar a un usuario de rol superior al tuyo", "target_above_actor");
  }
}

/** super_admin no lleva recortes (ver authenticate): se guardan vacios. */
function areasFor(role: InternalRole, raw: AreaAccess | undefined): AreaAccess {
  return role === "super_admin" ? {} : cleanAreaAccess(raw);
}

export const usersService = {
  async create(input: CreateUserInput, actor: Actor) {
    assertCanAssignRole(actor, input.role);
    const existing = await InternalUser.findOne({ email: input.email.toLowerCase() });
    if (existing) throw httpError(409, "Email ya registrado", "email_taken");

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const doc = await InternalUser.create({
      userId: makeId("iuser"),
      email: input.email.toLowerCase(),
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      status: "active",
      areaAccess: areasFor(input.role, input.areaAccess),
      accessExpiresAt: input.accessExpiresAt ?? null,
      createdBy: actor.userId,
    });
    return sanitizeUser(doc);
  },

  async list(input: ListUsersInput) {
    const filter: Record<string, unknown> = {};
    if (input.role) filter.role = input.role;
    if (input.status) filter.status = input.status;

    const [docs, total] = await Promise.all([
      InternalUser.find(filter)
        .sort({ createdAt: -1 })
        .skip(input.skip)
        .limit(input.limit),
      InternalUser.countDocuments(filter),
    ]);
    return {
      data: docs.map(sanitizeUser),
      total,
      page: input.page,
      limit: input.limit,
    };
  },

  async getById(userId: string) {
    const doc = await InternalUser.findOne({ userId });
    return doc ? sanitizeUser(doc) : null;
  },

  async getByEmailWithHash(email: string) {
    return InternalUser.findOne({ email: email.toLowerCase() });
  },

  async update(userId: string, input: UpdateUserInput, actor: Actor) {
    const current = await InternalUser.findOne({ userId });
    if (!current) return null;
    assertCanManage(actor, current);

    const self = actor.userId === userId;
    if (
      self &&
      (input.role !== undefined ||
        input.status !== undefined ||
        input.areaAccess !== undefined ||
        input.accessExpiresAt !== undefined)
    ) {
      throw httpError(
        403,
        "No podes cambiar tu propio rol, estado, permisos ni vencimiento",
        "self_restriction",
      );
    }
    if (input.role !== undefined) assertCanAssignRole(actor, input.role);

    const role = (input.role ?? current.role) as InternalRole;
    const update: Record<string, unknown> = {};
    if (input.firstName !== undefined) update.firstName = input.firstName;
    if (input.lastName !== undefined) update.lastName = input.lastName;
    if (input.role !== undefined) update.role = input.role;
    if (input.status !== undefined) update.status = input.status;
    if (input.accessExpiresAt !== undefined) update.accessExpiresAt = input.accessExpiresAt;
    if (input.areaAccess !== undefined || input.role === "super_admin") {
      update.areaAccess = areasFor(role, input.areaAccess ?? cleanAreaAccess(current.areaAccess));
    }
    if (input.password !== undefined) {
      update.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    }

    const doc = await InternalUser.findOneAndUpdate(
      { userId },
      { $set: update },
      { new: true },
    );
    invalidateUserAccess(userId);
    return doc ? sanitizeUser(doc) : null;
  },

  async softDelete(userId: string, actor: Actor) {
    if (actor.userId === userId) {
      throw httpError(403, "No podes desactivarte a vos mismo", "self_restriction");
    }
    const current = await InternalUser.findOne({ userId });
    if (!current) return null;
    assertCanManage(actor, current);
    const doc = await InternalUser.findOneAndUpdate(
      { userId },
      { $set: { status: "inactive" } },
      { new: true },
    );
    invalidateUserAccess(userId);
    return doc ? sanitizeUser(doc) : null;
  },

  async touchLastLogin(userId: string) {
    await InternalUser.updateOne({ userId }, { $set: { lastLoginAt: new Date() } });
  },
};
