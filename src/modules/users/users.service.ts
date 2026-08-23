import bcrypt from "bcrypt";
import { makeId } from "../../shared/utils/ids";
import { InternalUser, type InternalRole, sanitizeUser } from "./users.model";

interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: InternalRole;
}

interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  role?: InternalRole;
  status?: "active" | "inactive";
  password?: string;
}

interface ListUsersInput {
  role?: InternalRole;
  status?: "active" | "inactive";
  page: number;
  limit: number;
  skip: number;
}

const BCRYPT_ROUNDS = 10;

export const usersService = {
  async create(input: CreateUserInput) {
    const existing = await InternalUser.findOne({ email: input.email.toLowerCase() });
    if (existing) {
      const err = new Error("Email ya registrado") as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const doc = await InternalUser.create({
      userId: makeId("iuser"),
      email: input.email.toLowerCase(),
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      status: "active",
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

  async update(userId: string, input: UpdateUserInput) {
    const update: Record<string, unknown> = {};
    if (input.firstName !== undefined) update.firstName = input.firstName;
    if (input.lastName !== undefined) update.lastName = input.lastName;
    if (input.role !== undefined) update.role = input.role;
    if (input.status !== undefined) update.status = input.status;
    if (input.password !== undefined) {
      update.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    }

    const doc = await InternalUser.findOneAndUpdate(
      { userId },
      { $set: update },
      { new: true },
    );
    return doc ? sanitizeUser(doc) : null;
  },

  async softDelete(userId: string) {
    const doc = await InternalUser.findOneAndUpdate(
      { userId },
      { $set: { status: "inactive" } },
      { new: true },
    );
    return doc ? sanitizeUser(doc) : null;
  },

  async touchLastLogin(userId: string) {
    await InternalUser.updateOne({ userId }, { $set: { lastLoginAt: new Date() } });
  },
};
