/**
 * E2E del flujo de créditos / contratos de IA (incluye contrato GLOBAL).
 *
 * Requiere la API corriendo en :8600 con .env. Verifica, vía el MISMO endpoint
 * que consume el widget del chat (`/conversations/sessions/credits`, secret):
 *   - company sin contrato → "sin plan" (mide consumo del mes)
 *   - contrato específico → la company ve su bolsa
 *   - contrato GLOBAL (appliesToAll) → cubre companies sin contrato propio
 *   - prioridad: específico GANA sobre global
 *   - cleanup: archiva los contratos de prueba (no deja un global activo)
 */
import "dotenv/config";

const API = process.env.E2E_API ?? "http://localhost:8600/api/v1";
const SECRET = process.env.PMS_INTERNAL_SECRET!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@bookfer.com";
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";

const PREFIX = "E2E-CRED-";
const CO_SPEC = "c-cred-e2e-spec";
const CO_NOPLAN = "c-cred-e2e-noplan";

let passed = 0;
let failed = 0;
const ok = (l: string, d = "") => {
  passed++;
  console.log(`  ✓ ${l}${d ? ` — ${d}` : ""}`);
};
const fail = (l: string, d = "") => {
  failed++;
  console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`);
};
const step = (n: string) => console.log(`\n[${n}]`);

async function req(
  method: string,
  path: string,
  opts: { token?: string; secret?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.secret) headers["X-Internal-Secret"] = opts.secret;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// Créditos tal cual los ve el widget del chat (endpoint runtime con secret).
async function creditsOf(companyId: string) {
  const r = await req(
    "GET",
    `/conversations/sessions/credits?companyId=${encodeURIComponent(companyId)}`,
    { secret: SECRET },
  );
  return r.body;
}

async function archive(token: string, contractId: string) {
  await req("PATCH", `/contracts/${contractId}/status`, {
    token,
    body: { status: "archived" },
  });
}

async function cleanup(token: string) {
  const list = await req("GET", "/contracts?limit=100", { token });
  const mine = (list.body?.data ?? []).filter((c: any) =>
    String(c.name).startsWith(PREFIX),
  );
  for (const c of mine) {
    if (c.status !== "archived") await archive(token, c.contractId);
  }
  return mine.length;
}

async function main() {
  console.log("E2E créditos / contratos");
  console.log(`API: ${API}\n`);

  step("1. login admin");
  const login = await req("POST", "/auth/login", {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  const token = login.body?.token;
  if (login.status !== 200 || !token) {
    fail("login", `status=${login.status}`);
    process.exit(1);
  }
  ok("login");

  step("2. limpiar contratos E2E previos");
  const cleaned = await cleanup(token);
  ok("cleanup previo", `${cleaned} contrato(s) E2E archivados`);

  // ¿Hay un contrato GLOBAL real ya activo (ej. el "Basic contract 1")?
  const noplanBefore = await creditsOf(CO_NOPLAN);
  const preexistingGlobal = !!noplanBefore?.hasContract;
  console.log(
    `    global preexistente: ${preexistingGlobal ? `sí (contractId=${noplanBefore.contractId}, monthly=${noplanBefore.monthlyCredits})` : "no"}`,
  );

  // ── TEST A: contrato específico ──────────────────────────────────────────
  step("3. contrato específico para una company");
  const created = await req("POST", "/contracts", {
    token,
    body: { name: `${PREFIX}specific`, description: "e2e" },
  });
  const specId = created.body?.contractId;
  if (created.status !== 201 || !specId) {
    fail("create específico", `status=${created.status} body=${JSON.stringify(created.body)}`);
    process.exit(1);
  }
  ok("create específico", specId);

  await req("PATCH", `/contracts/${specId}`, {
    token,
    body: { ia: { enabled: true, monthlyCredits: 50000, resetDayUTC: 1 } },
  });
  await req("PATCH", `/contracts/${specId}/associate`, {
    token,
    body: { companyIds: [CO_SPEC] },
  });
  const actSpec = await req("PATCH", `/contracts/${specId}/status`, {
    token,
    body: { status: "active" },
  });
  if (actSpec.status !== 200) {
    fail("activar específico", `status=${actSpec.status} body=${JSON.stringify(actSpec.body)}`);
  } else {
    ok("activar específico");
  }

  const cSpec = await creditsOf(CO_SPEC);
  if (cSpec?.hasContract && cSpec.monthlyCredits === 50000 && cSpec.contractId === specId) {
    ok(
      "credits company específica",
      `hasContract=${cSpec.hasContract} monthly=${cSpec.monthlyCredits} consumed=${cSpec.consumed}`,
    );
  } else {
    fail("credits company específica", JSON.stringify(cSpec));
  }

  // ── TEST B: contrato global ──────────────────────────────────────────────
  step("4. contrato global (appliesToAll)");
  let globalId: string | null = null;
  if (preexistingGlobal) {
    ok(
      "global preexistente detectado",
      "se respeta el global real; CO_NOPLAN ya queda cubierto",
    );
    const cNo = await creditsOf(CO_NOPLAN);
    if (cNo?.hasContract) ok("company sin contrato cubierta por global real", `monthly=${cNo.monthlyCredits}`);
    else fail("company sin contrato cubierta por global", JSON.stringify(cNo));
  } else {
    const cg = await req("POST", "/contracts", {
      token,
      body: { name: `${PREFIX}global`, description: "e2e global", appliesToAll: true },
    });
    globalId = cg.body?.contractId;
    if (cg.status !== 201 || !globalId) {
      fail("create global", `status=${cg.status} body=${JSON.stringify(cg.body)}`);
    } else {
      ok("create global", globalId);
      await req("PATCH", `/contracts/${globalId}`, {
        token,
        body: { appliesToAll: true, ia: { enabled: true, monthlyCredits: 99000, resetDayUTC: 1 } },
      });
      const actG = await req("PATCH", `/contracts/${globalId}/status`, {
        token,
        body: { status: "active" },
      });
      if (actG.status !== 200) {
        fail("activar global (sin companies)", `status=${actG.status} body=${JSON.stringify(actG.body)}`);
      } else {
        ok("activar global sin asociar companies");
      }

      const cNo = await creditsOf(CO_NOPLAN);
      if (cNo?.hasContract && cNo.monthlyCredits === 99000 && cNo.contractId === globalId) {
        ok("company SIN contrato cubierta por el global", `monthly=${cNo.monthlyCredits}`);
      } else {
        fail("company cubierta por global", JSON.stringify(cNo));
      }

      // Prioridad: la company con contrato específico NO debe tomar el global.
      const cSpec2 = await creditsOf(CO_SPEC);
      if (cSpec2?.monthlyCredits === 50000 && cSpec2.contractId === specId) {
        ok("prioridad: específico gana sobre global", `monthly=${cSpec2.monthlyCredits}`);
      } else {
        fail("prioridad específico>global", JSON.stringify(cSpec2));
      }
    }
  }

  // ── Cleanup + verificación "sin plan" ────────────────────────────────────
  step("5. cleanup y verificación final");
  await archive(token, specId);
  if (globalId) await archive(token, globalId);
  ok("contratos E2E archivados");

  if (!preexistingGlobal) {
    const cNoAfter = await creditsOf(CO_NOPLAN);
    if (!cNoAfter?.hasContract) {
      ok("company sin plan tras cleanup", `reason=${cNoAfter?.reason} consumed=${cNoAfter?.consumed}`);
    } else {
      fail("company debería quedar sin plan", JSON.stringify(cNoAfter));
    }
  }

  console.log(`\n=== resultado: ${passed} OK / ${failed} FAIL ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e créditos crashed:", e);
  process.exit(1);
});
