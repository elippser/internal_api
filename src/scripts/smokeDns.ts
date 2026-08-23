import "dotenv/config";
import { cloudflare, isConfigured } from "../modules/dns/cloudflare.client";
import { dnsService } from "../modules/dns/dns.service";
import {
  EXPECTED_RECORDS,
  FORBIDDEN_HOSTS,
  fqdn,
  proxyRuleFor,
} from "../modules/dns/dns.inventory";

/**
 * Verificacion del gestor de DNS. Es de SOLO LECTURA: no crea, no edita y no
 * borra nada en Cloudflare, asi que se puede correr contra la zona real.
 *
 * Es lo primero que hay que correr despues de pegar el token: dice si el token
 * sirve, si la zona resuelve y como esta la zona contra el inventario, sin
 * tener que abrir el panel.
 *
 *   npm run smoke:dns
 */

const ZONE = (process.env.CLOUDFLARE_ZONE_NAME ?? "bookfer.com").trim();

function line(char = "─") {
  console.log(char.repeat(64));
}

async function main() {
  console.log("=== 1. Inventario (offline) ===");
  const platform = EXPECTED_RECORDS.filter((e) => e.group === "platform");
  const email = EXPECTED_RECORDS.filter((e) => e.group === "email");
  console.log(`  ${platform.length} registros de plataforma`);
  console.log(`  ${email.length} registros de email (Resend)`);
  console.log(`  ${FORBIDDEN_HOSTS.length} hostname(s) que NO deben existir`);

  const mustBeGrey = platform.filter((e) => e.proxy === false);
  console.log(`  ${mustBeGrey.length} obligados a ir en gris:`);
  for (const e of mustBeGrey) {
    console.log(`    · ${fqdn(e.host, ZONE)}`);
  }

  // El guardarrail tiene que reconocer los que van en gris por FQDN.
  for (const e of mustBeGrey) {
    const rule = proxyRuleFor(fqdn(e.host, ZONE), ZONE);
    if (!rule || rule.proxy !== false) {
      throw new Error(
        `El guardarrail no reconoce ${fqdn(e.host, ZONE)} como "debe ir gris"`,
      );
    }
  }
  console.log("  ✓ los guardarrailes de proxy resuelven bien");

  line();
  console.log("=== 2. Token y zona ===");
  if (!isConfigured()) {
    console.log("  CLOUDFLARE_DNS_API_TOKEN vacio.");
    console.log("  Crea un API Token en dash.cloudflare.com/profile/api-tokens:");
    console.log("    Permissions:     Zone · DNS · Edit");
    console.log("                     Zone · Zone · Read");
    console.log(`    Zone Resources:  Include · Specific zone · ${ZONE}`);
    console.log("  (NO la Global API Key: no se puede acotar a una zona.)");
    return;
  }

  const verified = await cloudflare.verifyToken();
  console.log(`  token ${verified.id} → ${verified.status}`);

  const status = await dnsService.status();
  if (!status.zone) {
    console.log(`  ✗ ${status.error}`);
    return;
  }
  console.log(
    `  zona ${status.zone.name} (${status.zone.id}) · ${status.zone.status} · plan ${status.zone.plan}`,
  );
  console.log(`  nameservers: ${status.zone.nameServers.join(", ") || "—"}`);
  console.log(`  ${status.recordCount} registros en la zona`);

  line();
  console.log("=== 3. Auditoria contra el inventario ===");
  const audit = await dnsService.audit();
  const s = audit.summary;
  console.log(
    `  ok ${s.ok} · faltan ${s.missing} · proxy al reves ${s.proxyMismatch} · prohibidos ${s.forbidden} · fuera del inventario ${s.unknown}`,
  );

  for (const r of audit.rows.filter((x) => x.status !== "ok")) {
    const mark = r.status === "missing" ? "FALTA " : "PROXY ";
    console.log(`  ${mark} ${r.name.padEnd(30)} ${r.service}`);
  }
  for (const f of audit.forbidden) {
    console.log(`  SOBRA  ${f.name}`);
  }

  line();
  console.log("=== 4. Listado anotado ===");
  const list = await dnsService.list({});
  const conProblema = list.data.filter((r) => r.issues.length > 0);
  console.log(`  ${list.total} registros, ${conProblema.length} con observaciones`);
  for (const r of conProblema.slice(0, 10)) {
    console.log(`  ! ${r.type.padEnd(6)} ${r.name.padEnd(30)} ${r.issues[0].message.slice(0, 60)}`);
  }

  console.log("");
  console.log(
    s.missing + s.proxyMismatch + s.forbidden === 0
      ? "✓ La zona coincide con el inventario del monorepo."
      : "✗ Hay diferencias contra el inventario — ver arriba y DNS-CLOUDFLARE-BOOKFER.md",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke:dns]", err?.message ?? err);
    process.exit(1);
  });
