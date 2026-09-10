/**
 * Ver el correo del alta sin pasar por el formulario.
 *
 * Existe porque probar este mail por la via normal cuesta caro: hay que levantar
 * el sitio, completar el alta, esperar el rate limit y quemar una direccion de
 * correo. Y si algo se ve mal, hay que repetirlo entero para ver el arreglo.
 *
 * Tres cosas, y las tres se pueden pedir sueltas:
 *
 *   npm run mail:preview              -> escribe los 5 idiomas a HTML y abre nada
 *   npm run mail:preview -- --verify  -> ademas prueba la conexion SMTP
 *   npm run mail:preview -- --send=vos@dominio.com
 *                                     -> ademas manda UNO de verdad (es, salvo
 *                                        que pases --locale=en)
 *
 * El `--send` manda un correo real a una direccion real. No hay confirmacion
 * interactiva a proposito (esto corre en terminales sin tty), asi que la
 * direccion va explicita en el comando: no hay default que puedas disparar sin
 * querer.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { LOCALES, resolveLocale, type Locale } from "../modules/leads/leads.i18n";
import { leadsMailer, verifySmtp } from "../modules/leads/leads.mailer";
import { renderExisting, renderInvite } from "../modules/leads/leads.template";

const OUT = path.resolve(process.cwd(), ".mail-preview");

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Los mismos datos para los 5, para que la unica diferencia sea el idioma. */
const SAMPLE = {
  contactName: "Ana Ferrer",
  hotelName: "Hotel Costa Verde",
  url: "https://app.roombir.com/register?inv=ejemplo-de-token-de-43-caracteres-abcdefg&utm_source=email&utm_medium=invite&utm_campaign=lead_access",
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("=== Plantillas ===");
  for (const locale of LOCALES) {
    const invite = renderInvite(SAMPLE, locale);
    const existing = renderExisting(
      { hotelName: SAMPLE.hotelName, loginUrl: "https://app.roombir.com/login" },
      locale,
    );
    fs.writeFileSync(path.join(OUT, `invite.${locale}.html`), invite.html, "utf8");
    fs.writeFileSync(path.join(OUT, `existing.${locale}.html`), existing.html, "utf8");
    console.log(`  ${locale}  ${invite.subject}`);
  }
  console.log(`\n  -> ${OUT}`);

  if (has("verify")) {
    console.log("\n=== Conexion SMTP ===");
    const res = await verifySmtp();
    console.log(`  ${res.ok ? "OK" : "FALLO"}  ${res.detail}`);
    if (!res.ok) process.exitCode = 1;
  }

  const to = arg("send");
  if (to) {
    const locale: Locale = resolveLocale(arg("locale") ?? "es");
    console.log(`\n=== Envio real -> ${to} (${locale}) ===`);
    await leadsMailer.sendInvite({
      to,
      contactName: SAMPLE.contactName,
      hotelName: SAMPLE.hotelName,
      locale,
      url: SAMPLE.url,
      expiresAt: SAMPLE.expiresAt,
    });
    console.log("  enviado");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("\nFALLO:", err?.message ?? err);
    process.exit(1);
  });
