import jwt from "jsonwebtoken";
import { resolveUserRole } from "../../modules/conversations/services/pmsContextResolver";
import { resolveSpaceClaims } from "./spaceClaims";

// JWT delegado que internal-laupser firma para representar al hotelero real
// cuando una tool del agente pega contra pms-core/booking-app/rooms-app.
//
// Los 3 servicios del PMS agregan AGENT_JWT_SECRET a su lista de secrets
// aceptados por authenticate. A partir de ahi, el pipeline existente
// (authenticate -> authorize(role) -> membership/multi-tenancy) corre tal
// cual como si el hotelero hubiera hecho el request desde el PMS.
//
// El TTL es corto a proposito: se remintea sin estado en cada tool call.
// Si al usuario le revocan acceso a mitad de conversacion, el proximo tool
// call ya falla con 403 en el authorize del PMS.
//
// Nota sobre claims (desviacion documentada del spec):
// El spec original pedia solo { sub: userId, iss, agentId, sessionId } y
// dejaba que cada servicio resolviera role+companyId desde la membership
// real en DB. En la practica solo pms-core hace ese DB lookup; rooms-app
// y booking-app leen role/companyId directo del JWT (no tienen tabla User
// propia). Para que las tools contra esos 2 servicios funcionen,
// incluimos role y companyId como claims — pero los resolvemos FRESH
// desde pms.users.memberships en cada mint, no del session.context.
// Esto preserva la garantia "siempre actualizado" del spec sin requerir
// refactor de los 3 servicios.
//
// Espacio operativo (activeOperativeSpaceId + spacePermissions): tambien va en
// el JWT, resuelto contra pms-core en cada mint (ver spaceClaims.ts). Antes no
// iba, y eso dejaba fuera del agente a todo usuario que no fuera owner/admin en
// las apps protegidas con `requireSpaceAccess` — el rms-app entero entre ellas.
// Sigue siendo un snapshot de lo que el PMS dice AHORA, no una elevacion: si el
// usuario no tiene acceso al espacio, el claim viene vacio y la sub-app 403ea.

const DEFAULT_TTL_SECONDS = 180; // 3 min

export interface AgentJwtClaims {
  userId: string;
  companyId?: string;
  agentId?: string;
  sessionId?: string;
}

export class AgentJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentJwtError";
  }
}

function getSecret(): string {
  const secret = process.env.AGENT_JWT_SECRET;
  if (!secret) {
    throw new AgentJwtError(
      "AGENT_JWT_SECRET no esta configurado. Sin esto el agente no puede ejecutar tools contra el PMS.",
    );
  }
  return secret;
}

// Resuelve el role fresco desde la DB del PMS y firma el JWT delegado.
// Si no encuentra membership devuelve un JWT sin role; el PMS respondera
// 403 en authorize y el toolExecutor lo mapea a "permisos insuficientes".
export async function mintAgentJwt(
  claims: AgentJwtClaims,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  if (!claims.userId) {
    throw new AgentJwtError("userId requerido para firmar JWT delegado");
  }

  const secret = getSecret();
  const [role, space] = await Promise.all([
    resolveUserRole(claims.userId, claims.companyId),
    resolveSpaceClaims(secret, claims.userId, claims.companyId),
  ]);

  return jwt.sign(
    {
      // Identidad del usuario suplantado
      sub: claims.userId,
      userId: claims.userId, // alias para servicios que leen userId del claim
      // Snapshot fresh de DB — rooms-app/booking-app leen estos campos
      role,
      companyId: claims.companyId,
      activeCompany: claims.companyId,
      // Espacio operativo activo, tal como lo resuelve pms-core. Sin esto,
      // `requireSpaceAccess` de booking-app/rooms-app/rms-app 403ea a todo el
      // que no sea owner/admin.
      activeOperativeSpaceId: space.activeOperativeSpaceId,
      spacePermissions: space.spacePermissions,
      // Trazabilidad
      iss: "internal-laupser-agent",
      agentId: claims.agentId,
      sessionId: claims.sessionId,
    },
    secret,
    { expiresIn: ttlSeconds },
  );
}

// Verificacion en caso de testing. El PMS verifica con su propia lista
// de secrets; aca solo lo exponemos para los tests del propio modulo.
export function verifyAgentJwt(token: string): Record<string, unknown> {
  return jwt.verify(token, getSecret()) as Record<string, unknown>;
}
