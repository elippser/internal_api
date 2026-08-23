import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { makeId } from "../shared/utils/ids";
import { MktPage, MktSite } from "../modules/mktsite/mktsite.model";

/**
 * DEPRECADO. Importaba HTML crudo a `mkt_pages`, que ya no es de donde sale el
 * sitio: hoy el sitio es el repo `public-side/mkt-renderer` y se edita como un
 * proyecto Next. Para llevar una página de HTML a JSX está
 * `migrateMktSiteToNext.ts` (y `POST /mkt/project/html-to-jsx` desde el panel).
 *
 * Importa el landing de `mkt-project/web` como home del sitio de bookfer.
 *
 * El repo lo tiene como tres archivos sueltos (html/css/js) sin build ni
 * conexion al monorepo. Acá se parte en las tres pestañas del editor:
 *
 *   - `<head>`  -> `site.headHtml` (las fuentes de Google viven ahi, no en la
 *                  pagina: aplican a todo el sitio y no solo a la home)
 *   - `<body>`  -> `page.html`, sin el <script src> local, que pasa a `page.js`
 *   - css.css   -> `page.css`
 *   - js.js     -> `page.js`
 *
 * Idempotente: reimportar pisa el contenido de la home, no crea otra pagina.
 */

const SOURCE_DIR = path.resolve(
  __dirname,
  "../../../../mkt-project/web",
);
const SITE_SLUG = process.env.MKT_SITE_SLUG ?? "bookfer";

function read(file: string): string {
  const full = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(full)) throw new Error(`No existe ${full}`);
  return fs.readFileSync(full, "utf8");
}

/** Contenido entre <body> y </body>, sin los tags. */
function extractBody(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return (match ? match[1] : html).trim();
}

/**
 * Del <head> se rescatan solo los <link> remotos (fuentes). El
 * `<link rel="stylesheet" href="css.css">` local se descarta: ese CSS pasa a
 * la pestaña CSS y lo inyecta el render.
 */
function extractHeadLinks(html: string): string {
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  return links
    .filter((tag) => {
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
      return /^https?:\/\//i.test(href);
    })
    .join("\n");
}

/** Saca los <script src="..."> locales del cuerpo: el JS va a su pestaña. */
function stripLocalScripts(body: string): string {
  return body
    .replace(/<script\b[^>]*\bsrc=["'](?!https?:\/\/)[^"']+["'][^>]*>\s*<\/script>/gi, "")
    .trim();
}

async function main() {
  await connectDB();

  const rawHtml = read("html.html");
  const css = read("css.css");
  const js = read("js.js");

  const headLinks = extractHeadLinks(rawHtml);
  const body = stripLocalScripts(extractBody(rawHtml));

  console.log("=== Origen ===");
  console.log(`  ${SOURCE_DIR}`);
  console.log(`  html ${rawHtml.length} -> body ${body.length} bytes`);
  console.log(`  css  ${css.length} bytes`);
  console.log(`  js   ${js.length} bytes`);
  console.log(`  head: ${headLinks.split("\n").filter(Boolean).length} links remotos`);

  let site = await MktSite.findOne({ slug: SITE_SLUG });
  if (!site) {
    site = await MktSite.create({
      siteId: makeId("site"),
      name: "Bookfer",
      slug: SITE_SLUG,
      status: "published",
      createdByUserId: "import",
    });
    console.log(`\n  sitio "${SITE_SLUG}" creado`);
  } else {
    console.log(`\n  sitio "${SITE_SLUG}" ya existia`);
  }

  // Las fuentes son del sitio entero, no de una pagina.
  if (headLinks && !site.headHtml?.includes("fonts.googleapis.com")) {
    site.set("headHtml", [site.headHtml, headLinks].filter(Boolean).join("\n"));
    await site.save();
    console.log("  headHtml actualizado con las fuentes");
  }

  let page = await MktPage.findOne({ siteId: site.siteId, path: "/" });
  if (!page) {
    page = new MktPage({
      pageId: makeId("page"),
      siteId: site.siteId,
      name: "Inicio",
      path: "/",
    });
    console.log("  home creada");
  } else {
    console.log("  home existente, se pisa el contenido");
  }

  page.set("html", body);
  page.set("css", css);
  page.set("js", js);
  page.set("seo", {
    ...(page.seo ?? {}),
    title: page.seo?.title || "Bookfer",
  });
  await page.save();

  // Se publica para que quede visible en /s/:slug al toque.
  page.set("publishedHtml", page.html);
  page.set("publishedCss", page.css);
  page.set("publishedJs", page.js);
  page.set("publishedAt", new Date());
  page.set("status", "published");
  await page.save();

  console.log("\n=== Resultado ===");
  console.log(`  pagina ${page.pageId} publicada`);
  console.log(`  HTML ${page.html.length} · CSS ${page.css.length} · JS ${page.js.length}`);
  console.log(`  ver en: /s/${SITE_SLUG}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("importMktLanding fallo:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
