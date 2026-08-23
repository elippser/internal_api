/**
 * E2E del pipeline completo de internal-laupser.
 *
 * Requiere la API corriendo en :8600 con .env cargado.
 * Pasos:
 *   1. login admin → JWT
 *   2. POST /conversations/sessions (X-Internal-Secret)
 *   3. POST /sessions/:id/messages — pregunta RAG (politica de cancelacion)
 *   4. POST /sessions/:id/messages — pregunta que dispara capture_feedback (Airbnb)
 *   5. POST /tickets/cron/run — Claude sintetiza ticket
 *   6. GET /conversations — la sesion aparece en audit
 *   7. GET /conversations/:id/messages — el chat completo persistido
 *   8. GET /feedback — el feedback creado
 *   9. GET /tickets — el ticket sintetizado por Claude
 */
import "dotenv/config";
import { devUserToken } from "./devUserToken";

const API = process.env.E2E_API ?? "http://localhost:8600/api/v1";
const SECRET = process.env.PMS_INTERNAL_SECRET!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@bookfer.com";
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";
const AGENT_SLUG = "asistente-de-operaciones";
// Usuario ficticio de la sesion runtime + su token, que las rutas
// /sessions/:id exigen para comprobar que la conversacion es suya.
const E2E_USER_ID = "u-e2e";

let totalPassed = 0;
let totalFailed = 0;

function ok(label: string, detail = "") {
  totalPassed++;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail = "") {
  totalFailed++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function step(name: string) {
  console.log(`\n[${name}]`);
}

async function req(
  method: string,
  path: string,
  opts: {
    token?: string;
    secret?: string;
    // JWT del hotelero para las rutas runtime de /conversations/sessions:
    // el secret dice "viene del PMS", esto dice QUE usuario es.
    userToken?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.secret) headers["X-Internal-Secret"] = opts.secret;
  if (opts.userToken) headers["X-Pms-User-Token"] = opts.userToken;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function main() {
  console.log("E2E internal-laupser");
  console.log(`API: ${API}`);
  console.log("");

  // 1) login
  step("1. login admin");
  const login = await req("POST", "/auth/login", {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  if (login.status !== 200 || !login.body?.token) {
    fail("login", `status=${login.status}`);
    process.exit(1);
  }
  const token = login.body.token as string;
  ok("login", `token=${token.slice(0, 16)}…`);

  // resolver agentId
  const agentsRes = await req("GET", "/agents?limit=20", { token });
  const agent = agentsRes.body?.data?.find((a: any) => a.slug === AGENT_SLUG);
  if (!agent) {
    fail("agent lookup", `slug ${AGENT_SLUG} not found`);
    process.exit(1);
  }
  const agentId = agent.agentId as string;
  ok("agent lookup", agentId);

  // 2) crear sesion runtime
  step("2. crear sesion (runtime, X-Internal-Secret)");
  const sess = await req("POST", "/conversations/sessions", {
    secret: SECRET,
    body: {
      agentId,
      context: {
        userId: E2E_USER_ID,
        companyId: "c-e2e",
        propertyId: "p-e2e",
        userRole: "admin",
        channel: "pms_app",
      },
    },
  });
  if (sess.status !== 201 || !sess.body?.sessionId) {
    fail("createSession", `status=${sess.status} body=${JSON.stringify(sess.body)}`);
    process.exit(1);
  }
  const sessionId = sess.body.sessionId as string;
  ok("createSession", sessionId);
  const userToken = devUserToken(E2E_USER_ID);

  // 3) mensaje RAG
  step("3. mensaje RAG (politica de cancelacion)");
  const msg1 = await req(
    "POST",
    `/conversations/sessions/${sessionId}/messages`,
    {
      secret: SECRET,
      userToken,
      body: { content: "Cual es la politica de cancelacion por defecto?" },
    },
  );
  if (msg1.status !== 200 || !msg1.body?.message?.content) {
    fail("postMessage RAG", `status=${msg1.status}`);
  } else {
    const meta = msg1.body.message.agentMeta;
    ok(
      "postMessage RAG",
      `tokens=${meta?.inputTokens}/${meta?.outputTokens} · latency=${meta?.latencyMs}ms · model=${meta?.modelUsed}`,
    );
    console.log(
      `    respuesta: "${msg1.body.message.content.slice(0, 120).replace(/\n/g, " ")}…"`,
    );
  }

  // 4) mensaje que dispara capture_feedback
  step("4. mensaje feedback-capture (Airbnb)");
  const msg2a = await req(
    "POST",
    `/conversations/sessions/${sessionId}/messages`,
    {
      secret: SECRET,
      userToken,
      body: {
        content: "Se puede conectar el PMS con Airbnb? Si no, registralo como pedido por favor.",
      },
    },
  );
  if (msg2a.status !== 200) {
    fail("postMessage Airbnb (1)", `status=${msg2a.status}`);
  } else {
    ok("postMessage Airbnb (1)");
    console.log(
      `    respuesta: "${msg2a.body.message.content.slice(0, 120).replace(/\n/g, " ")}…"`,
    );
  }

  // Si el agente todavia no llamo capture_feedback (suele preguntar primero),
  // mandamos un "Si dale" como confirmacion.
  const tools1 =
    (msg2a.body?.message?.agentMeta?.toolsExecuted as any[]) ?? [];
  const calledFb1 = tools1.some(
    (t) => t.toolName === "capture_feedback_request" && t.outcome === "success",
  );
  let feedbackCreated = calledFb1;

  if (!calledFb1) {
    const msg2b = await req(
      "POST",
      `/conversations/sessions/${sessionId}/messages`,
      {
        secret: SECRET,
        userToken,
        body: { content: "Si dale, registralo." },
      },
    );
    if (msg2b.status !== 200) {
      fail("postMessage Airbnb (2)", `status=${msg2b.status}`);
    } else {
      const tools2 =
        (msg2b.body?.message?.agentMeta?.toolsExecuted as any[]) ?? [];
      feedbackCreated = tools2.some(
        (t) => t.toolName === "capture_feedback_request" && t.outcome === "success",
      );
      ok("postMessage Airbnb (2)");
      console.log(
        `    respuesta: "${msg2b.body.message.content.slice(0, 120).replace(/\n/g, " ")}…"`,
      );
    }
  }

  if (feedbackCreated) ok("capture_feedback_request ejecutada");
  else fail("capture_feedback_request", "el agente no la llamo en este run");

  // 5) cron de tickets
  step("5. correr cron de tickets");
  const cron = await req("POST", "/tickets/cron/run", { token });
  if (cron.status !== 200) {
    fail("runCron", `status=${cron.status}`);
  } else {
    ok(
      "runCron",
      `newFeedbacks=${cron.body.newFeedbacks} clusters=${cron.body.clusters} created=${cron.body.ticketsCreated} appended=${cron.body.ticketsAppended}`,
    );
  }

  // 6) audit list conversations
  step("6. GET /conversations (audit, JWT support+)");
  const audit = await req("GET", "/conversations?limit=10", { token });
  if (audit.status !== 200) {
    fail("auditList", `status=${audit.status}`);
  } else {
    const found = (audit.body.data as any[]).find(
      (s) => s.sessionId === sessionId,
    );
    if (found) {
      ok(
        "auditList includes new session",
        `agentName="${found.agentName}" turns=${found.turnCount} feedbackCount=${found.feedbackCount}`,
      );
    } else {
      fail("auditList includes new session");
    }
  }

  // 7) audit messages
  step("7. GET /conversations/:id/messages");
  const msgs = await req(
    "GET",
    `/conversations/${sessionId}/messages`,
    { token },
  );
  if (msgs.status !== 200 || !Array.isArray(msgs.body)) {
    fail("auditMessages", `status=${msgs.status}`);
  } else {
    const userMsgs = msgs.body.filter((m: any) => m.role === "user").length;
    const assistantMsgs = msgs.body.filter(
      (m: any) => m.role === "assistant",
    ).length;
    ok(
      "auditMessages",
      `total=${msgs.body.length} user=${userMsgs} assistant=${assistantMsgs}`,
    );
  }

  // 8) feedback
  step("8. GET /feedback");
  const fbs = await req("GET", "/feedback?limit=20", { token });
  if (fbs.status !== 200) {
    fail("feedbackList", `status=${fbs.status}`);
  } else {
    const fromSession = (fbs.body.data as any[]).filter(
      (f) => f.sessionId === sessionId,
    );
    if (fromSession.length > 0) {
      const f = fromSession[0];
      ok(
        "feedback de esta sesion",
        `category=${f.classification.category} confidence=${f.classification.confidence} status=${f.status} ticket=${f.linkedTicketId ?? "—"}`,
      );
    } else {
      fail("feedback de esta sesion", "ninguno");
    }
  }

  // 9) tickets
  step("9. GET /tickets");
  const tix = await req("GET", "/tickets?limit=20", { token });
  if (tix.status !== 200) {
    fail("ticketList", `status=${tix.status}`);
  } else {
    const recent = (tix.body.data as any[]).filter(
      (t) => t.createdByAgent && t.cronRunId,
    );
    if (recent.length > 0) {
      for (const t of recent.slice(0, 3)) {
        ok(
          `ticket ${t.ticketId.slice(-8)}`,
          `prio=${t.priority} score=${t.priorityScore} type=${t.type} title="${t.title}"`,
        );
      }
    } else {
      fail("ticket creado por agente", "ninguno (cron skipeo?)");
    }
  }

  console.log("");
  console.log(
    `\n=== resultado: ${totalPassed} OK / ${totalFailed} FAIL ===`,
  );
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
