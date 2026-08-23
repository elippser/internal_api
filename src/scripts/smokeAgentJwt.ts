/**
 * Smoke test del modulo agentJwt + verificacion del token contra los
 * secrets aceptados por los 3 servicios del PMS.
 *
 * Uso:
 *   AGENT_JWT_SECRET=... npx ts-node src/scripts/smokeAgentJwt.ts
 *
 * NO requiere DB ni servicios corriendo. Solo valida que el JWT que se
 * emite es interpretable con los mismos secrets que cada servicio del PMS
 * acepta en su lista.
 */
import "dotenv/config";
import jwt from "jsonwebtoken";
import { mintAgentJwt, verifyAgentJwt } from "../shared/agentAuth/agentJwt";

async function main() {
  console.log("Smoke test agentJwt\n");

  const secret = process.env.AGENT_JWT_SECRET;
  if (!secret) {
    console.error("✗ AGENT_JWT_SECRET no esta configurado");
    process.exit(1);
  }
  console.log(`✓ AGENT_JWT_SECRET presente (${secret.length} chars)`);

  // Nota: mintAgentJwt llama a resolveUserRole que necesita pmsDb.
  // Para smoke offline, firmamos directo aca con el mismo secret.
  const token = jwt.sign(
    {
      sub: "user-smoke-test",
      userId: "user-smoke-test",
      role: "admin",
      companyId: "company-smoke",
      activeCompany: "company-smoke",
      iss: "internal-laupser-agent",
      agentId: "agent-smoke",
      sessionId: "session-smoke",
    },
    secret,
    { expiresIn: 180 },
  );
  console.log(`✓ JWT emitido (${token.length} chars)`);

  // Verificacion local
  try {
    const decoded = verifyAgentJwt(token);
    console.log("✓ Verifica con AGENT_JWT_SECRET local");
    console.log("  payload:", {
      sub: decoded.sub,
      userId: decoded.userId,
      role: decoded.role,
      companyId: decoded.companyId,
      iss: decoded.iss,
      agentId: decoded.agentId,
      sessionId: decoded.sessionId,
    });
  } catch (err) {
    console.error("✗ Falla verificacion local:", err);
    process.exit(1);
  }

  // Simulacion: cada servicio del PMS prueba multiples secrets.
  // pms-core: [JWT_SECRET, SHARED_JWT_SECRET, AGENT_JWT_SECRET]
  // booking-app: [STAFF_JWT_SECRET, JWT_SECRET, SHARED_JWT_SECRET, AGENT_JWT_SECRET]
  // rooms-app: [JWT_SECRET, PMS_JWT_SECRET, SHARED_JWT_SECRET, CORE_JWT_SECRET, AGENT_JWT_SECRET]
  console.log("\nSimulando verificacion en los 3 servicios del PMS:");
  const services = [
    {
      name: "pms-core",
      secrets: [
        process.env.JWT_SECRET,
        process.env.SHARED_JWT_SECRET,
        process.env.AGENT_JWT_SECRET,
      ],
    },
    {
      name: "booking-app",
      secrets: [
        process.env.STAFF_JWT_SECRET,
        process.env.JWT_SECRET,
        process.env.SHARED_JWT_SECRET,
        process.env.AGENT_JWT_SECRET,
      ],
    },
    {
      name: "rooms-app",
      secrets: [
        process.env.JWT_SECRET,
        process.env.PMS_JWT_SECRET,
        process.env.SHARED_JWT_SECRET,
        process.env.CORE_JWT_SECRET,
        process.env.AGENT_JWT_SECRET,
      ],
    },
  ];

  let allOk = true;
  for (const s of services) {
    const valid = s.secrets.filter((x): x is string => Boolean(x?.trim()));
    let matched = false;
    let matchedIdx = -1;
    for (let i = 0; i < valid.length; i++) {
      try {
        jwt.verify(token, valid[i]);
        matched = true;
        matchedIdx = i;
        break;
      } catch {
        /* siguiente */
      }
    }
    if (matched) {
      console.log(
        `  ✓ ${s.name} acepta el token (secret slot #${matchedIdx + 1} de ${valid.length})`,
      );
    } else {
      allOk = false;
      console.log(
        `  ✗ ${s.name} NO acepta el token. Secrets configurados: ${valid.length}/${s.secrets.length}`,
      );
    }
  }

  // El supuesto critico del spec: que el SHARED_JWT_SECRET / JWT_SECRET
  // alcance para verificar tokens del PMS de usuario al crear sesion.
  console.log("\nSecrets para verificar token del usuario (createSession):");
  const userSecrets = [
    { name: "SHARED_JWT_SECRET", val: process.env.SHARED_JWT_SECRET },
    { name: "JWT_SECRET", val: process.env.JWT_SECRET },
    { name: "PMS_JWT_SECRET", val: process.env.PMS_JWT_SECRET },
  ];
  for (const s of userSecrets) {
    console.log(`  ${s.val ? "✓" : "·"} ${s.name}: ${s.val ? "set" : "not set"}`);
  }
  const hasAny = userSecrets.some((s) => Boolean(s.val));
  if (!hasAny) {
    console.log(
      "  ⚠ Ninguno seteado — verifyUserToken siempre devolvera null. Configurar uno para que las sesiones con token funcionen.",
    );
  }

  console.log("");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
