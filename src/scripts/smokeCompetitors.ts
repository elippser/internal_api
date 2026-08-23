import "dotenv/config";

/**
 * Humo del modulo de competencia (COMPETITIVE-INTEL-SPEC.md §12). GASTA TOKENS.
 * Requiere la API corriendo en :8600 y ANTHROPIC_API_KEY.
 *
 *   npm run smoke:competitors -- <url-del-competidor> [--evidence] [--radar]
 *
 * 1. login como ADMIN_EMAIL/ADMIN_PASSWORD
 * 2. crea (o reusa) el competidor con esa URL
 * 3. corre el borrador IA (con evidencia si --evidence) y hace polling hasta ready/error
 * 4. si --radar: corre el radar en modo "search" con la config actual y muestra el resumen
 */

const BASE = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.PORT ?? 8600}/api/v1`;

function arg(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!url) {
    console.error("Uso: npm run smoke:competitors -- <url> [--evidence] [--radar]");
    process.exit(1);
  }
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL / ADMIN_PASSWORD no configurados");

  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login -> ${login.status}`);
  const { token } = (await login.json()) as { token: string };
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, json };
  };

  const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  console.log(`[smoke] competidor ${host}`);
  let competitorId: string;
  const created = await call("POST", "/competitors", { name: host, website: url, segment: "latam" });
  if (created.status === 409) {
    competitorId = created.json.competitorId;
    console.log(`[smoke] ya existía -> ${competitorId}`);
  } else {
    competitorId = created.json.competitorId;
    console.log(`[smoke] creado -> ${competitorId}`);
  }

  const includeEvidence = arg("--evidence");
  const started = await call("POST", `/competitors/${competitorId}/ai-draft`, { includeEvidence });
  console.log(`[smoke] borrador: ${JSON.stringify(started.json)}`);
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const { json } = await call("GET", `/competitors/${competitorId}`);
    const draft = json.competitor?.aiDraft;
    if (draft?.status !== "running") {
      console.log(`[smoke] borrador ${draft?.status} en ${Math.round((Date.now() - t0) / 1000)} s`);
      console.log(JSON.stringify({ sources: draft?.sources, warnings: draft?.warnings, confidence: draft?.confidence, usage: draft?.usage }, null, 2));
      console.log(JSON.stringify(draft?.fields, null, 2));
      break;
    }
    if (Date.now() - t0 > 170_000) {
      console.log("[smoke] el borrador sigue running después de 170 s");
      break;
    }
  }

  if (arg("--radar")) {
    console.log("[smoke] corriendo radar (search)... (asíncrono: se hace polling de /radar/runs)");
    const started = await call("POST", "/competitors/radar/run", { mode: "search" });
    const runId = started.json.runId;
    const t1 = Date.now();
    let run = started;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const runs = await call("GET", "/competitors/radar/runs");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = (runs.json.data as any[]).find((x) => x.runId === runId);
      if (found && found.status !== "running") {
        run = { status: 200, json: found };
        break;
      }
      if (Date.now() - t1 > 10 * 60_000) {
        console.log("[smoke] la corrida sigue running después de 10 min");
        break;
      }
    }
    console.log(`[smoke] corrida terminó en ${Math.round((Date.now() - t1) / 1000)} s`);
    console.log(JSON.stringify({ status: run.json.status, totals: run.json.totals, errors: run.json.errors }, null, 2));
    const pending = await call("GET", "/competitors/radar?status=pending&limit=10");
    console.log(`[smoke] pendientes: ${pending.json.total}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const it of pending.json.data as any[]) console.log(`  - ${it.detectedName} (${it.domain}) · ${it.aiSummary}`);
  }
}

main().catch((err) => {
  console.error("[smoke] falló:", err?.message ?? err);
  process.exit(1);
});
