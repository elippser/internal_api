import jwt from "jsonwebtoken";
import { Schema, type Model } from "mongoose";
import { getPmsConnection } from "../../../shared/pmsDb";
import { pmsRequest } from "../../../shared/middleware/pmsProxy";

export type PmsUserRole = "owner" | "admin" | "staff" | "viewer" | "editor";

interface RawContext {
  userId?: string;
  companyId?: string;
  propertyId?: string;
  operativeSpaceId?: string;
  operativeSpaceName?: string;
  userRole?: string;
  channel: string;
  // JWT del hotelero, reenviado por el widget del PMS al crear sesion.
  // Se verifica contra SHARED_JWT_SECRET / JWT_SECRET (no contra
  // AGENT_JWT_SECRET, que es para el camino inverso).
  token?: string;
}

interface EnrichedContext {
  userId?: string;
  companyId?: string;
  propertyId?: string;
  operativeSpaceId?: string;
  operativeSpaceName?: string;
  userRole?: PmsUserRole | string;
  channel: string;
  userName?: string;
  propertyName?: string;
  propertyType?: string;
  companyName?: string;
}

// Schema RO minimo para leer User.memberships desde la DB del PMS sin
// duplicar todo el modelo. strict:false ignora campos no declarados.
interface PmsUserDoc {
  userId: string;
  role?: string;
  activeCompanyId?: string;
  memberships?: Array<{
    companyId: string;
    role: string;
    status?: string;
  }>;
}

const pmsUserSchema = new Schema(
  {
    userId: String,
    role: String,
    activeCompanyId: String,
    memberships: [
      {
        _id: false,
        companyId: String,
        role: String,
        status: String,
      },
    ],
  },
  { strict: false, collection: "users" },
);

let pmsUserModel: Model<PmsUserDoc> | null = null;
async function getPmsUserModel(): Promise<Model<PmsUserDoc>> {
  if (pmsUserModel) return pmsUserModel;
  const conn = await getPmsConnection();
  pmsUserModel = conn.model<PmsUserDoc>("PmsUser", pmsUserSchema);
  return pmsUserModel;
}

interface PmsPropertyDoc {
  propertyId: string;
  companyId: string;
  name?: string;
  type?: string;
  status?: string;
}
const pmsPropertySchema = new Schema(
  {
    propertyId: String,
    companyId: String,
    name: String,
    type: String,
    status: String,
  },
  { strict: false, collection: "properties" },
);
let pmsPropertyModel: Model<PmsPropertyDoc> | null = null;
async function getPmsPropertyModel(): Promise<Model<PmsPropertyDoc>> {
  if (pmsPropertyModel) return pmsPropertyModel;
  const conn = await getPmsConnection();
  pmsPropertyModel = conn.model<PmsPropertyDoc>("PmsProperty", pmsPropertySchema);
  return pmsPropertyModel;
}

// Propiedades de una company (lectura directa de la DB del PMS). Se usa para
// auto-seleccionar la propiedad activa cuando la sesion no trae una.
export async function resolveCompanyProperties(
  companyId: string,
): Promise<Array<{ propertyId: string; name?: string; type?: string }>> {
  try {
    const Model = await getPmsPropertyModel();
    const props = await Model.find(
      { companyId, status: { $ne: "deleted" } },
      { propertyId: 1, name: 1, type: 1 },
    ).lean();
    return props.map((p) => ({
      propertyId: p.propertyId,
      name: p.name,
      type: p.type,
    }));
  } catch (err) {
    console.warn("[conversations] resolveCompanyProperties failed:", err);
    return [];
  }
}

// Llamadas best-effort: si pms-core esta caido, devolvemos los campos
// disponibles y omitimos los que no se pudieron resolver. El runtime
// nunca depende de que el PMS este arriba para crear una sesion.
async function safeGet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn("[conversations] context resolve failed:", err);
    return null;
  }
}

// Verifica el token del hotelero contra los secrets que el PMS usa para
// firmar JWTs de usuario. Probamos SHARED_JWT_SECRET primero (es el patron
// "secret compartido entre servicios" que ya usa rooms-app) y caemos a
// JWT_SECRET si no esta seteado. Devuelve userId verificado o null.
export function verifyUserToken(token: string): { userId: string } | null {
  const secrets = [
    process.env.SHARED_JWT_SECRET,
    process.env.JWT_SECRET,
    process.env.PMS_JWT_SECRET,
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s));
  if (secrets.length === 0) return null;

  for (const secret of secrets) {
    try {
      const decoded = jwt.verify(token, secret) as Record<string, unknown>;
      const uid =
        (typeof decoded.userId === "string" && decoded.userId) ||
        (typeof decoded.sub === "string" && decoded.sub) ||
        null;
      if (uid) return { userId: uid };
    } catch {
      // probar siguiente secret
    }
  }
  return null;
}

// Best-effort: resuelve el rol PMS del usuario para una company dada,
// leyendo memberships del User en la DB del PMS. Si no encuentra
// membership activa para esa company cae a user.role legacy (que es
// lo que pms-core/middleware/autenticateJWT usa hoy).
//
// Importante: esto es para UX/prompt — NO es el authz real. La autorizacion
// real la hace el PMS via su pipeline authorize(role) + membership check.
export async function resolveUserRole(
  userId: string,
  companyId?: string,
): Promise<PmsUserRole | undefined> {
  try {
    const Model = await getPmsUserModel();
    const user = await Model.findOne({ userId }, {
      role: 1,
      memberships: 1,
      activeCompanyId: 1,
    }).lean();
    if (!user) return undefined;

    if (companyId && Array.isArray(user.memberships)) {
      const m = user.memberships.find(
        (m) => m.companyId === companyId && m.status !== "suspended",
      );
      if (m && m.role) return m.role as PmsUserRole;
    }
    if (user.role) return user.role as PmsUserRole;
    return undefined;
  } catch (err) {
    console.warn("[conversations] resolveUserRole failed:", err);
    return undefined;
  }
}

export async function enrichContext(
  raw: RawContext,
): Promise<EnrichedContext> {
  // 1) Si vino token del PMS embebido, verificarlo y extraer userId.
  // El userId verificado tiene prioridad sobre raw.userId (que el cliente
  // podria haber falseado).
  let effectiveUserId = raw.userId;
  if (raw.token) {
    const verified = verifyUserToken(raw.token);
    if (verified) {
      effectiveUserId = verified.userId;
    } else {
      console.warn(
        "[conversations] token de usuario invalido — siguiendo sin userId verificado",
      );
    }
  }

  // 2) Role real via membership. Si el cliente paso userRole pero el lookup
  // devuelve algo distinto, el lookup gana (es la fuente de verdad para UX).
  let effectiveRole = raw.userRole as PmsUserRole | undefined;
  if (effectiveUserId) {
    const resolved = await resolveUserRole(effectiveUserId, raw.companyId);
    if (resolved) effectiveRole = resolved;
  }

  // 2.5) Propiedad activa. Si la sesion no trae propertyId pero la company
  // tiene exactamente una propiedad, la usamos (caso hotel single-property).
  // Si tiene varias, dejamos propertyId vacio: el agente debe usar
  // list_properties y confirmar con el usuario (ver buildPath + prompt).
  let effectivePropertyId = raw.propertyId;
  let autoPropertyName: string | undefined;
  let autoPropertyType: string | undefined;
  if (!effectivePropertyId && raw.companyId) {
    const props = await resolveCompanyProperties(raw.companyId);
    if (props.length === 1) {
      effectivePropertyId = props[0].propertyId;
      autoPropertyName = props[0].name;
      autoPropertyType = props[0].type;
    }
  }

  // 3) Enriquecimiento opcional via HTTP al PMS (best-effort).
  const [property, company, user] = await Promise.all([
    effectivePropertyId && !autoPropertyName
      ? safeGet(() =>
          pmsRequest<{ name?: string; type?: string }>({
            service: "pms-core",
            path: `/api/v1/properties/${effectivePropertyId}`,
          }),
        )
      : null,
    raw.companyId
      ? safeGet(() =>
          pmsRequest<{ name?: string }>({
            service: "pms-core",
            path: `/api/v1/companies/${raw.companyId}`,
          }),
        )
      : null,
    effectiveUserId
      ? safeGet(() =>
          pmsRequest<{ firstName?: string; lastName?: string; email?: string }>(
            {
              service: "pms-core",
              path: `/api/v1/users/${effectiveUserId}/profile`,
            },
          ),
        )
      : null,
  ]);

  return {
    userId: effectiveUserId,
    companyId: raw.companyId,
    propertyId: effectivePropertyId,
    operativeSpaceId: raw.operativeSpaceId,
    operativeSpaceName: raw.operativeSpaceName,
    userRole: effectiveRole,
    channel: raw.channel,
    propertyName: autoPropertyName ?? property?.name,
    propertyType: autoPropertyType ?? property?.type,
    companyName: company?.name,
    userName: user
      ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() ||
        user.email ||
        undefined
      : undefined,
  };
}
