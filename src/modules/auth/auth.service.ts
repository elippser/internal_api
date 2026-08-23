import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import { sanitizeUser } from "../users/users.model";
import { usersService } from "../users/users.service";

interface LoginResult {
  token: string;
  user: ReturnType<typeof sanitizeUser>;
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await usersService.getByEmailWithHash(email);
    if (!user) {
      throwUnauthorized("Credenciales invalidas");
    }
    if (user!.status !== "active") {
      throwUnauthorized("Usuario inactivo");
    }

    const valid = await bcrypt.compare(password, user!.passwordHash);
    if (!valid) {
      throwUnauthorized("Credenciales invalidas");
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      const err = new Error("JWT_SECRET no configurado") as Error & {
        status?: number;
      };
      err.status = 500;
      throw err;
    }

    const expiresIn = (process.env.JWT_EXPIRES_IN ?? "8h") as SignOptions["expiresIn"];
    const token = jwt.sign(
      { userId: user!.userId, email: user!.email, role: user!.role },
      secret,
      { expiresIn },
    );

    await usersService.touchLastLogin(user!.userId);

    return { token, user: sanitizeUser(user) };
  },

  async getMe(userId: string) {
    return usersService.getById(userId);
  },
};

function throwUnauthorized(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 401;
  throw err;
}
