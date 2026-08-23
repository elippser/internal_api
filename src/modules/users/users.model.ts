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
