import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { MktPage, MktSite } from "../modules/mktsite/mktsite.model";
import { htmlToJsx } from "../modules/mktproject/htmlToJsx";
import { mktprojectService, normalizeRoute } from "../modules/mktproject/mktproject.service";

/**
 * Pasa el sitio que vivía en Mongo (`mkt_sites` / `mkt_pages`, tres campos de
 * texto html/css/js por página) al repo Next `public-side/mkt-renderer`.
 *
 * Qué sale de dónde:
 *
 *   page.html  -> src/app<ruta>/page.tsx        (JSX de verdad, ver htmlToJsx)
 *   page.css   -> src/app/globals.css           (la home; el resto, page.css propio)
 *   page.js    -> src/components/<X>.animation.js + <X>Scripts.tsx
 *   site.*     -> site.config.json
 *   site.headHtml -> preconnect + stylesheets del config
 *
 * El JS heredado queda en un `.js` a propósito: es código de landing escrito
 * para correr suelto en el navegador, con globals de CDN (`gsap`) que en TS
 * habría que declarar uno por uno. Con `allowJs` y sin `checkJs`, Next lo
 * compila igual y se puede portar a TS de a poco.
 *
 * NO borra nada de Mongo: si la conversión sale mal, el sitio viejo sigue
 * sirviéndose desde /s/:slug hasta que alguien lo apague a mano.
 *
 *   npm run migrate:mkt-next            # escribe
 *   npm run migrate:mkt-next -- --dry   # solo muestra qué haría
 */

const SITE_SLUG = process.env.MKT_SITE_SLUG ?? "bookfer";
const DRY = process.argv.includes("--dry");
const ROOT = mktprojectService.root;

function write(relative: string, content: string) {
  const full = path.join(ROOT, relative);
  console.log(
    `  ${DRY ? "[dry] " : ""}${fs.existsSync(full) ? "pisa " : "crea "}${relative} (${content.length} bytes)`,
  );
  if (DRY) return;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

/** `/` -> `Home`; `/legal/terminos` -> `LegalTerminos`. */
function pascalOf(route: string): string {
  if (route === "/") return "Home";
  return route
    .slice(1)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

/** `Home` -> `home`; `LegalTerminos` -> `legalTerminos`. */
function camelOf(pascal: string): string {
  return pascal[0].toLowerCase() + pascal.slice(1);
}

/** Los `<link>` del headHtml viejo, partidos en los campos del config nuevo. */
function parseHeadLinks(headHtml: string) {
  const preconnect: string[] = [];
  const stylesheets: string[] = [];
  for (const tag of headHtml.match(/<link\b[^>]*>/gi) ?? []) {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!href) continue;
    if (rel === "preconnect") preconnect.push(href);
    else if (rel === "stylesheet") stylesheets.push(href);
  }
  return { preconnect, stylesheets };
}

function indent(jsx: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return jsx
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

function pageModule(args: {
  route: string;
  name: string;
  title: string;
  description: string;
  noindex: boolean;
  ogImage: string;
  jsx: string;
  cssImport: string | null;
  scriptsComponent: string | null;
}): string {
  const {
    route,
    name,
    title,
    description,
    noindex,
    ogImage,
    jsx,
    cssImport,
    scriptsComponent,
  } = args;

  const imports = ['import type { Metadata } from "next";'];
  if (scriptsComponent) {
    imports.push(`import ${scriptsComponent} from "@/components/${scriptsComponent}";`);
  }
  if (cssImport) imports.push(`import "${cssImport}";`);

  const meta: string[] = [];
  if (title) meta.push(`  title: ${JSON.stringify(title)},`);
  if (description) meta.push(`  description: ${JSON.stringify(description)},`);
  if (ogImage) {
    meta.push(`  openGraph: { images: [${JSON.stringify(ogImage)}] },`);
  }
  if (noindex) meta.push("  robots: { index: false, follow: false },");

  const body = [
    indent(jsx, 6),
    scriptsComponent ? `      <${scriptsComponent} />` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${imports.join("\n")}

// Migrado desde el editor viejo (mkt_pages ${JSON.stringify(route)}).
// El markup salió de HTML crudo, así que todavía es un bloque largo: partirlo
// en componentes de \`src/components\` es el próximo paso, no un requisito.
export const metadata: Metadata = {
${meta.join("\n")}
};

export default function ${pascalOf(route)}Page() {
  return (
    <>
${body}
    </>
  );
}
`;
}

function scriptsModule(args: {
  component: string;
  animationFile: string;
  externalScripts: string[];
}): string {
  const { component, animationFile, externalScripts } = args;
  const hasExternal = externalScripts.length > 0;

  if (!hasExternal) {
    return `"use client";

import { useEffect } from "react";
import run from "./${animationFile}";

/**
 * JS heredado de la página, portado tal cual. Corre una vez, después de montar.
 */
export default function ${component}() {
  useEffect(() => {
    run();
  }, []);

  return null;
}
`;
  }

  return `"use client";

import Script from "next/script";
import { useCallback, useRef } from "react";
import run from "./${animationFile}";

/**
 * Librerías de CDN que usaba la página + el JS heredado que depende de ellas.
 *
 * El JS no puede correr en un \`useEffect\` pelado: las librerías se cargan
 * async y en ese momento todavía no existen sus globals. Por eso se cuentan los
 * \`onLoad\` y recién con el último se dispara.
 *
 * Se ejecuta una sola vez por carga completa: \`next/script\` no reinyecta un
 * script ya cargado, así que si algún día hay navegación cliente entre páginas
 * hay que reinicializar a mano al volver.
 */
const EXTERNAL = ${JSON.stringify(externalScripts, null, 2).replace(/\n/g, "\n")};

export default function ${component}() {
  const pending = useRef(EXTERNAL.length);
  const started = useRef(false);

  const onLoad = useCallback(() => {
    pending.current -= 1;
    if (pending.current > 0 || started.current) return;
    started.current = true;
    run();
  }, []);

  return (
    <>
      {EXTERNAL.map((src) => (
        <Script key={src} src={src} strategy="afterInteractive" onLoad={onLoad} />
      ))}
    </>
  );
}
`;
}

function animationModule(route: string, js: string): string {
  return `/* eslint-disable */
// JS heredado de ${route}, migrado sin tocar desde el editor viejo.
//
// Queda en .js y no en .ts porque referencia globals que inyectan las librerías
// de CDN (gsap, ScrollTrigger, ...) y tiparlos uno por uno no aporta nada
// mientras el archivo siga siendo el original. Lo llama el componente cliente
// hermano, después de que las librerías cargaron.
export default function run() {
${indent(js.trim(), 2)}
}
`;
}

async function main() {
  console.log(`Repo destino: ${ROOT}`);
  if (!fs.existsSync(ROOT)) {
    throw new Error(`No existe ${ROOT}. Crealo antes de migrar.`);
  }

  await connectDB();

  const site = await MktSite.findOne({ slug: SITE_SLUG }).lean();
  if (!site) throw new Error(`No hay ningún sitio con slug "${SITE_SLUG}"`);

  const pages = await MktPage.find({ siteId: site.siteId }).sort({ path: 1 }).lean();
  console.log(`Sitio "${site.name}" (${site.slug}) con ${pages.length} página(s).\n`);

  // ---------- site.config.json ----------
  const { preconnect, stylesheets } = parseHeadLinks(site.headHtml ?? "");
  write(
    "site.config.json",
    JSON.stringify(
      {
        name: site.name,
        lang: site.defaultLanguage || "es",
        siteId: site.siteId,
        favicon: site.favicon ?? "",
        seo: {
          title: site.seo?.title ?? "",
          description: site.seo?.description ?? "",
          ogImage: site.seo?.ogImage ?? "",
          noindex: Boolean(site.seo?.noindex),
        },
        // El token de la CAPI no viaja: es server-side y se queda en Mongo.
        pixels: {
          metaPixelId: site.pixels?.metaPixelId ?? "",
          ga4MeasurementId: site.pixels?.ga4MeasurementId ?? "",
          googleAdsConversionId: site.pixels?.googleAdsConversionId ?? "",
          gtmContainerId: site.pixels?.gtmContainerId ?? "",
        },
        preconnect,
        stylesheets,
      },
      null,
      2,
    ) + "\n",
  );

  if (site.bodyEndHtml?.trim()) {
    console.log(
      "\n  ! `bodyEndHtml` tenía contenido y no se migra automáticamente.\n" +
        "    Pegalo donde corresponda en src/app/layout.tsx:\n" +
        site.bodyEndHtml
          .split("\n")
          .map((l) => "      " + l)
          .join("\n") +
        "\n",
    );
  }

  // ---------- Páginas ----------
  for (const page of pages) {
    const route = normalizeRoute(page.path);
    const pascal = pascalOf(route);
    const dir = route === "/" ? "src/app" : `src/app${route}`;
    console.log(`\n${route}  ->  ${dir}/page.tsx`);

    const converted = htmlToJsx(page.html ?? "");

    // El CSS de la home es global (toca html, body, :root) y ya lo importa el
    // layout. El de una página interna se queda al lado de su page.tsx.
    const css = [page.css ?? "", ...converted.inlineStyles].join("\n\n").trim();
    let cssImport: string | null = null;
    if (css) {
      if (route === "/") {
        write("src/app/globals.css", css + "\n");
      } else {
        write(`${dir}/page.css`, css + "\n");
        cssImport = "./page.css";
      }
    }

    // El JS de la pestaña + lo que estaba inline en el HTML.
    const js = [page.js ?? "", ...converted.inlineScripts].join("\n\n").trim();
    let scriptsComponent: string | null = null;
    if (js || converted.externalScripts.length) {
      scriptsComponent = `${pascal}Scripts`;
      const animationFile = `${camelOf(pascal)}.animation`;
      write(
        `src/components/${animationFile}.js`,
        animationModule(route, js || "// La página no tenía JS propio."),
      );
      write(
        `src/components/${scriptsComponent}.tsx`,
        scriptsModule({
          component: scriptsComponent,
          animationFile,
          externalScripts: converted.externalScripts,
        }),
      );
    }

    write(
      `${dir}/page.tsx`,
      pageModule({
        route,
        name: page.name,
        title: page.seo?.title || page.name || "",
        description: page.seo?.description ?? "",
        noindex: Boolean(page.seo?.noindex),
        ogImage: page.seo?.ogImage ?? "",
        jsx: converted.jsx,
        cssImport,
        scriptsComponent,
      }),
    );
  }

  console.log(
    `\n${DRY ? "Nada escrito (--dry)." : "Listo."} ` +
      "Mongo queda intacto: el sitio viejo sigue en /s/" +
      SITE_SLUG +
      " hasta que lo despubliques.",
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
