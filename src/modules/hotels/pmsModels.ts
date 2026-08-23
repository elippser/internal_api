import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../shared/pmsDb";

// Schemas read-only minimos para leer datos del PMS desde internal-laupser.
// NO replicamos toda la forma del PMS — solo los campos que la UI muestra.
// Mongoose ignora los campos no declarados al hacer .lean(), asi que esto
// es seguro aunque el modelo del PMS evolucione.

export interface PmsCompany {
  companyId: string;
  name: string;
  email?: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  planStatus?: string;
  propertyCount?: number;
  memberCount?: number;
  industry?: string;
  status?: "active" | "suspended" | "deleted";
  verified?: boolean;
  ownerUserId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PmsProperty {
  propertyId: string;
  companyId: string;
  name: string;
  slug?: string;
  type?: string;
  unitCount?: number;
  spaceCount?: number;
  address?: { city?: string; country?: string };
  timezone?: string;
  currency?: string;
  status?: string;
  createdAt?: Date;
}

const companySchema = new Schema(
  {
    companyId: String,
    name: String,
    email: String,
    plan: String,
    planStatus: String,
    propertyCount: Number,
    memberCount: Number,
    industry: String,
    status: String,
    verified: Boolean,
    ownerUserId: String,
    createdAt: Date,
    updatedAt: Date,
  },
  { strict: false, collection: "companies" },
);

const propertySchema = new Schema(
  {
    propertyId: String,
    companyId: String,
    name: String,
    slug: String,
    type: String,
    unitCount: Number,
    spaceCount: Number,
    address: {
      city: String,
      country: String,
    },
    timezone: String,
    currency: String,
    status: String,
    createdAt: Date,
  },
  { strict: false, collection: "properties" },
);

export interface PmsUnit {
  unitId: string;
  propertyId: string;
  companyId: string;
  status?: string;
  isActive?: boolean;
}

// `properties.unitCount` es un contador desnormalizado que en la base real
// quedo en 0 para todas las properties. Las unidades de verdad estan acá, y
// traen `companyId` propio, asi que se cuentan directo sin pasar por property.
const unitSchema = new Schema(
  {
    unitId: String,
    propertyId: String,
    companyId: String,
    status: String,
    isActive: Boolean,
  },
  { strict: false, collection: "units" },
);

let companyModel: Model<PmsCompany> | null = null;
let propertyModel: Model<PmsProperty> | null = null;
let unitModel: Model<PmsUnit> | null = null;

export async function getCompanyModel(): Promise<Model<PmsCompany>> {
  if (companyModel) return companyModel;
  const conn = await getPmsConnection();
  companyModel = conn.model<PmsCompany>("PmsCompany", companySchema);
  return companyModel;
}

export async function getPropertyModel(): Promise<Model<PmsProperty>> {
  if (propertyModel) return propertyModel;
  const conn = await getPmsConnection();
  propertyModel = conn.model<PmsProperty>("PmsProperty", propertySchema);
  return propertyModel;
}

export async function getUnitModel(): Promise<Model<PmsUnit>> {
  if (unitModel) return unitModel;
  const conn = await getPmsConnection();
  unitModel = conn.model<PmsUnit>("PmsUnit", unitSchema);
  return unitModel;
}
