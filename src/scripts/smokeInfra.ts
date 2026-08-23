import "dotenv/config";
import { INFRA_SERVICES } from "../modules/infra/infra.inventory";
import { infraService, resetCache } from "../modules/infra/infra.service";
import { isConfigured, rateLimit } from "../modules/infra/vercel.client";

/**
 * Verificacion del modulo de infraestructura. Es de SOLO LECTURA y cuesta 2 o 3
 * llamadas a Vercel: se puede correr contra la cuenta real sin miedo.
 *
 * Es lo primero que hay que correr despues de pegar el token: dice si el token
 * sirve, que proyectos vio y como quedo cada servicio del inventario, sin tener
 * que abrir el panel.
 *
 *   npm run smoke:infra
 */

function line(char = "─") {
  console.log(char.repeat(72));
}

const ICON: Record<string, string> = {
  ok: "✓",
  building: "…",
  error: "✗",
  canceled: "-",
  no_deploy: "○",
  not_found: "?",
  unlinked: "·",
};

async function main() {
  console.log("=== 1. Inventario (offline) ===");
  const byProvider = INFRA_SERVICES.reduce<Record<string, number>>((acc, s) => {
    acc[s.provider] = (acc[s.provider] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  ${INFRA_SERVICES.length} servicios declarados`);
  for (const [p, n] of Object.entries(byProvider)) console.log(`    ${p}: ${n}`);
  const core = INFRA_SERVICES.filter((s) => s.criticality === "core");
  console.log(`  ${core.length} criticos: ${core.map((s) => s.id).join(", ")}`);

  line();
  console.log("=== 2. Proveedores ===");
  const status = await infraService.status();
  for (const p of status.providers) {
    if (!p.configured) {
      console.log(`  ${p.provider}: sin configurar (${p.envVars.join(", ")})`);
      continue;
    }
    console.log(
      `  ${p.provider}: ${p.ok ? "OK" : "FALLA"} · ${p.account ?? "?"} · ${p.detail ?? ""}`,
    );
    if (p.error) console.log(`     ${p.error}`);
  }

  const gh = status.github;
  if (!gh.configured) {
    console.log(`  github: sin configurar (${gh.envVars.join(", ")})`);
  } else if (gh.ok) {
    console.log(
      `  github: OK · ${gh.account} · org ${gh.owner} · ${gh.repoCount ?? "?"} repos · ${gh.rateLimit.remaining ?? "?"} llamadas libres`,
    );
  } else {
    console.log(`  github: FALLA · ${gh.error}`);
  }
  console.log(
    `  ${gh.servicesWithoutRepo} servicio(s) del inventario sin repo declarado`,
  );

  if (gh.ok) {
    line();
    console.log("=== 3. Repos en GitHub ===");
    const repos = await infraService.repos();
    console.log(
      `  ${repos.summary.linked}/${repos.services.length} servicios enlazados · ${repos.summary.unlinked} sin repo · ${repos.summary.orphans} repos huerfanos · ${repos.summary.publicRepos} publicos`,
    );
    for (const r of repos.services.filter((x) => x.unlinked || x.missing)) {
      console.log(
        `  ! ${r.id.padEnd(18)} ${r.missing ? `declara ${r.declared} y GitHub no lo devuelve` : "sin repo: se despliega a mano"}`,
      );
    }
    for (const o of repos.orphans.slice(0, 10)) {
      console.log(`  ? ${o.fullName} no corresponde a ningun servicio`);
    }
  }

  if (!isConfigured()) {
    line();
    console.log("VERCEL_API_TOKEN vacio. Creá un token en:");
    console.log("  https://vercel.com/account/settings/tokens");
    console.log("Scope: la cuenta personal (Hobby). Pegalo en api/.env y repetí.");
    return;
  }

  line();
  console.log("=== 4. Tablero (mide el costo en llamadas) ===");
  resetCache();
  const before = rateLimit().remaining;
  const t0 = Date.now();
  const ov = await infraService.overview({ refresh: true });
  const after = rateLimit().remaining;
  console.log(`  ${Date.now() - t0} ms`);
  if (before !== null && after !== null) {
    console.log(`  llamadas gastadas: ${before - after} (quedan ${after})`);
  } else {
    console.log(`  rate limit: ${after ?? "no informado por Vercel"}`);
  }

  console.log(
    `  ${ov.summary.ok} ok · ${ov.summary.error} con error · ${ov.summary.building} construyendo · ${ov.summary.notFound} sin proyecto · ${ov.summary.unlinked} sin conectar`,
  );

  line();
  console.log("=== 5. Servicio por servicio ===");
  for (const s of ov.services) {
    const icon = ICON[s.status] ?? "?";
    const when = s.production?.createdAt
      ? new Date(s.production.createdAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";
    console.log(
      `  ${icon} ${s.id.padEnd(18)} ${(s.host ?? "(interno)").padEnd(26)} ${s.provider.padEnd(8)} ${(s.matchedBy ?? "—").padEnd(7)} ${when}`,
    );
    for (const i of s.issues) {
      console.log(`      ${i.severity === "danger" ? "!!" : i.severity === "warn" ? " !" : "  "} ${i.message}`);
    }
  }

  if (ov.unmatched.length > 0) {
    line();
    console.log("=== 6. Proyectos de Vercel sin identificar ===");
    console.log("  (o falta la fila en infra.inventory.ts, o hay que borrarlos)");
    for (const p of ov.unmatched) {
      console.log(
        `  · ${p.name} — root: ${p.rootDirectory ?? "(raiz)"} — ${p.production?.state ?? "sin produccion"}`,
      );
    }
  }

  line();
  console.log("=== 7. Plan gratis ===");
  console.log(
    `  deploys en 24 h: ${ov.quota.deploysLast24h}${ov.quota.deployCountIsFloor ? "+" : ""} de ${ov.quota.deploysPerDayLimit}`,
  );
  console.log(`  builds corriendo: ${ov.quota.buildsRunning}`);
  console.log(`  fallidos en 24 h: ${ov.quota.failedLast24h}`);
  for (const w of ov.warnings) console.log(`  ! ${w}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ smoke:infra fallo:", err?.message ?? err);
    process.exit(1);
  });
