import { Schema, model, type InferSchemaType } from "mongoose";

export const INTERNAL_ROLES = [
  "super_admin",
  "admin",
  "developer",
  "analyst",
  "support",
] as const;

export type InternalRole = (typeof INTERNAL_ROLES)[number];

const userSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    role: { type: String, enum: INTERNAL_ROLES, required: true },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    lastLoginAt: { type: Date },
    /**
     * Permisos por area (shared/access/areas.ts): { metrics: "read", crm: "none" }.
     * Solo se guardan las areas recortadas; lo que no esta vale "write" (lo que
     * el rol permita). Nunca suma por encima del rol.
     */
    areaAccess: { type: Schema.Types.Mixed, default: {} },
    /** Restriccion: despues de esta fecha el usuario no entra (null = sin vencimiento). */
    accessExpiresAt: { type: Date, default: null },
    /** Quien lo dio de alta (userId), para la auditoria del padron. */
    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: "internal_users" },
);

export type InternalUserDoc = InferSchemaType<typeof userSchema>;

export const InternalUser = model("InternalUser", userSchema);

export function sanitizeUser(doc: any) {
  if (!doc) return doc;
  const obj = "toObject" in doc ? doc.toObject() : doc;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, _id, __v, ...rest } = obj;
  return rest;
}
