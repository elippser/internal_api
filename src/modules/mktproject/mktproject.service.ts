import fs from "fs/promises";
import path from "path";

/**
 * Acceso al repo del sitio público (`public-side/mkt-renderer`) como si fuera
 * un workspace de editor.
 *
 * El contenido del sitio dejó de vivir en Mongo (`mkt_pages`, tres campos de
 * texto html/css/js) y pasó a ser un proyecto Next de verdad: una página es una
 * carpeta con su `page.tsx`. Este módulo es lo único que el panel usa para
 * leerlo y escribirlo, así que acá está TODO el control de qué se puede tocar.
 *
 * Implica que el API y el renderer comparten filesystem. En el monorepo local
 * eso es cierto por definición; si algún día se despliegan separados, hay que
 * montar el repo en un volumen compartido y apuntar `MKT_PROJECT_DIR`.
 */

/**
 * `??` no alcanza: en el .env estas variables están declaradas vacías, y una
 * cadena vacía no es nullish, así que sin este helper `MKT_PROJECT_DIR=` haría
 * que el repo se resolviera contra el cwd del proceso.
 */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** Raíz del repo. `MKT_PROJECT_DIR` la pisa (útil si se despliega aparte). */
const PROJECT_DIR = path.resolve(
  env(
    "MKT_PROJECT_DIR",
    // src/modules/mktproject -> api -> internal-laupser -> raíz del monorepo.
    // Compilado queda en dist/modules/mktproject: misma profundidad.
    path.join(__dirname, "..", "..", "..", "..", "..", "public-side", "mkt-renderer"),
  ),
);

/** Dev server del renderer. Es lo que se embebe en la vista previa. */
const RENDERER_URL = env("MKT_RENDERER_URL", "http://localhost:6300");

/** Carpeta del App Router, relativa a la raíz del repo. */
const APP_DIR = "src/app";

/** No se listan ni se tocan: ruido de build, dependencias e historial. */
const HIDDEN_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  "dist",
  ".vercel",
]);

/** Nunca se escriben, aunque se listen. */
const PROTECTED_FILES = new Set(["package-lock.json"]);

/** Extensiones que el editor abre como texto. */
const TEXT_EXTENSIONS = new Set([
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".svg",
  ".html",
  ".yml",
  ".yaml",
]);

/** 1 MB. Un `page.tsx` legítimo nunca se acerca; un binario sí. */
const MAX_FILE_BYTES = 1024 * 1024;

/** Archivos que marcan una ruta en el App Router. */
const PAGE_FILES = ["page.tsx", "page.jsx", "page.ts", "page.js"];

interface HttpError extends Error {
  status: number;
  code?: string;
}
function httpError(status: number, message: string, code?: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

export interface TreeNode {
  name: string;
  /** Ruta relativa a la raíz del repo, siempre con `/`. */
  path: string;
  type: "file" | "dir";
  size?: number;
  editable?: boolean;
  children?: TreeNode[];
}

export interface PageEntry {
  /** Ruta pública: `/`, `/precios`, `/legal/terminos`. */
  route: string;
  /** Archivo que la define, relativo a la raíz del repo. */
  file: string;
  /** Carpeta de la página. Para la home es la de `src/app`. */
  dir: string;
  /** `title` del `metadata` exportado, si se puede leer sin evaluar el módulo. */
  title: string;
  /** Otros archivos de la carpeta (css, componentes sueltos). */
  siblings: string[];
  updatedAt: string;
  /** Las rutas con `[param]` no se pueden previsualizar sin inventar un valor. */
  dynamic: boolean;
}

// ---------------------------------------------------------------------------
// Rutas seguras
// ---------------------------------------------------------------------------

/**
 * Traduce una ruta relativa del panel a una absoluta dentro del repo.
 *
 * El chequeo va sobre la ruta ya resuelta y no sobre el texto de entrada: con
 * `..`, symlinks y separadores mezclados de Windows, cualquier validación por
 * substring se escapa tarde o temprano.
 */
function resolveInProject(relative: string): string {
  const clean = String(relative ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return PROJECT_DIR;

  const full = path.resolve(PROJECT_DIR, clean);
  const rel = path.relative(PROJECT_DIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw httpError(400, "Ruta fuera del proyecto", "path_escape");
  }

  const segments = rel.split(path.sep);
  if (segments.some((s) => HIDDEN_DIRS.has(s))) {
    throw httpError(403, "Esa carpeta no se puede tocar desde el panel", "hidden_path");
  }
  return full;
}

/** Igual que `resolveInProject`, pero además exige que se pueda escribir. */
function resolveWritable(relative: string): string {
  const full = resolveInProject(relative);
  const name = path.basename(full);
  if (PROTECTED_FILES.has(name)) {
    throw httpError(403, `${name} no se edita desde el panel`, "protected_file");
  }
  if (name.startsWith(".env")) {
    throw httpError(403, "Los .env no se editan desde el panel", "protected_file");
  }
  return full;
}

function toRelative(full: string): string {
  return path.relative(PROJECT_DIR, full).split(path.sep).join("/");
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Lenguaje para Monaco. */
export function languageOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".tsx":
      return "typescript";
    case ".ts":
      return "typescript";
    case ".jsx":
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".html":
      return "html";
    case ".svg":
      return "xml";
    case ".yml":
    case ".yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

async function exists(full: string): Promise<boolean> {
  try {
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export const mktprojectService = {
  root: PROJECT_DIR,
  rendererUrl: RENDERER_URL,

  /**
   * Estado del workspace. El panel lo usa para explicar por qué no se ve nada
   * en vez de mostrar un árbol vacío sin más.
   */
  async status() {
    const ready = await exists(PROJECT_DIR);
    const installed = ready && (await exists(path.join(PROJECT_DIR, "node_modules")));
    let pages = 0;
    if (ready) {
      try {
        pages = (await this.listPages()).length;
      } catch {
        pages = 0;
      }
    }
    return {
      root: PROJECT_DIR,
      rendererUrl: RENDERER_URL,
      exists: ready,
      dependenciesInstalled: installed,
      pages,
    };
  },

  /** Árbol completo del repo, sin las carpetas ocultas. */
  async tree(): Promise<TreeNode[]> {
    if (!(await exists(PROJECT_DIR))) {
      throw httpError(
        404,
        `No existe el repo del sitio en ${PROJECT_DIR}`,
        "project_missing",
      );
    }
    return readDir(PROJECT_DIR);
  },

  async readFile(relative: string) {
    const full = resolveInProject(relative);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw httpError(404, "Archivo no encontrado", "not_found");
    }

    const name = path.basename(full);
    if (!isTextFile(name) || stat.size > MAX_FILE_BYTES) {
      return {
        path: toRelative(full),
        binary: true,
        size: stat.size,
        language: languageOf(name),
        content: "",
        updatedAt: stat.mtime.toISOString(),
      };
    }

    return {
      path: toRelative(full),
      binary: false,
      size: stat.size,
      language: languageOf(name),
      content: await fs.readFile(full, "utf8"),
      updatedAt: stat.mtime.toISOString(),
    };
  },

  async writeFile(relative: string, content: string) {
    const full = resolveWritable(relative);
    if (!isTextFile(path.basename(full))) {
      throw httpError(400, "Ese tipo de archivo no se edita como texto", "not_text");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw httpError(413, "El archivo es demasiado grande", "too_large");
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    const stat = await fs.stat(full);
    return {
      path: toRelative(full),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  },

  async createFile(relative: string, content = "") {
    const full = resolveWritable(relative);
    if (await exists(full)) {
      throw httpError(409, "Ya existe un archivo con ese nombre", "duplicate");
    }
    return this.writeFile(relative, content);
  },

  async createDir(relative: string) {
    const full = resolveWritable(relative);
    if (await exists(full)) {
      throw httpError(409, "Ya existe una carpeta con ese nombre", "duplicate");
    }
    await fs.mkdir(full, { recursive: true });
    return { path: toRelative(full), type: "dir" as const };
  },

  async rename(from: string, to: string) {
    const source = resolveWritable(from);
    const target = resolveWritable(to);
    if (!(await exists(source))) throw httpError(404, "No existe el origen", "not_found");
    if (await exists(target)) {
      throw httpError(409, "El destino ya existe", "duplicate");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    return { from: toRelative(source), to: toRelative(target) };
  },

  async remove(relative: string) {
    const full = resolveWritable(relative);
    if (full === PROJECT_DIR) {
      throw httpError(400, "No se puede borrar la raíz del proyecto", "invalid_target");
    }
    if (!(await exists(full))) throw httpError(404, "No existe", "not_found");
    await fs.rm(full, { recursive: true, force: true });
    return { deleted: toRelative(full) };
  },

  // ---------- Páginas ----------

  /** Recorre `src/app` y arma la lista de rutas reales del App Router. */
  async listPages(): Promise<PageEntry[]> {
    const appDir = path.join(PROJECT_DIR, APP_DIR);
    if (!(await exists(appDir))) return [];

    const found: PageEntry[] = [];

    const walk = async (dir: string, segments: string[]) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const pageFile = PAGE_FILES.find((f) =>
        entries.some((e) => e.isFile() && e.name === f),
      );
      if (pageFile) {
        const file = path.join(dir, pageFile);
        const stat = await fs.stat(file);
        const source = await fs.readFile(file, "utf8").catch(() => "");
        found.push({
          route: "/" + segments.join("/"),
          file: toRelative(file),
          dir: toRelative(dir),
          title: extractMetadataTitle(source),
          siblings: entries
            .filter((e) => e.isFile() && e.name !== pageFile)
            .map((e) => e.name),
          updatedAt: stat.mtime.toISOString(),
          dynamic: segments.some((s) => s.includes("[")),
        });
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (HIDDEN_DIRS.has(entry.name)) continue;
        // `_carpeta` queda fuera del ruteo de Next; `(grupo)` agrupa sin
        // aportar segmento a la URL.
        if (entry.name.startsWith("_")) continue;
        const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        await walk(
          path.join(dir, entry.name),
          isGroup ? segments : [...segments, entry.name],
        );
      }
    };

    await walk(appDir, []);

    // La home primero, después alfabético: es el orden en el que alguien busca.
    found.sort((a, b) => {
      if (a.route === "/") return -1;
      if (b.route === "/") return 1;
      return a.route.localeCompare(b.route);
    });
    return found;
  },

  /**
   * Crea una página: la carpeta con el nombre de la ruta y su `page.tsx`.
   * Es exactamente lo que haría alguien a mano en el repo.
   */
  async createPage(input: { name: string; route: string }) {
    const route = normalizeRoute(input.route);
    if (route === "/") {
      throw httpError(409, "La home ya existe", "duplicate");
    }

    const segments = route.slice(1).split("/");
    for (const segment of segments) {
      if (!/^[a-z0-9\-_[\]().]+$/i.test(segment)) {
        throw httpError(
          400,
          `El segmento "${segment}" tiene caracteres que no van en una carpeta`,
          "invalid_route",
        );
      }
    }

    const dir = path.join(PROJECT_DIR, APP_DIR, ...segments);
    const file = path.join(dir, "page.tsx");
    if (await exists(file)) {
      throw httpError(409, "Ya existe una página en esa ruta", "duplicate");
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, pageTemplate(input.name, route, segments), "utf8");

    return {
      route,
      file: toRelative(file),
      dir: toRelative(dir),
    };
  },

  /** Borra la carpeta entera de la ruta. La home no se puede borrar. */
  async deletePage(route: string) {
    const normalized = normalizeRoute(route);
    if (normalized === "/") {
      throw httpError(400, "La home no se puede borrar", "invalid_target");
    }
    const pages = await this.listPages();
    const page = pages.find((p) => p.route === normalized);
    if (!page) throw httpError(404, "Página no encontrada", "not_found");

    await fs.rm(path.join(PROJECT_DIR, page.dir), { recursive: true, force: true });
    return { deleted: page.route };
  },

  // ---------- site.config.json ----------

  async readConfig(): Promise<Record<string, unknown>> {
    const full = path.join(PROJECT_DIR, "site.config.json");
    if (!(await exists(full))) {
      throw httpError(404, "El proyecto no tiene site.config.json", "not_found");
    }
    return JSON.parse(await fs.readFile(full, "utf8"));
  },

  /**
   * Reescribe el config entero. El panel manda el objeto completo (lo leyó
   * antes), así que un merge parcial acá solo escondería campos perdidos.
   */
  async writeConfig(config: Record<string, unknown>) {
    const full = path.join(PROJECT_DIR, "site.config.json");
    await fs.writeFile(full, JSON.stringify(config, null, 2) + "\n", "utf8");
    return config;
  },
};

// ---------------------------------------------------------------------------

async function readDir(dir: string): Promise<TreeNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (HIDDEN_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: toRelative(full),
        type: "dir",
        children: await readDir(full),
      });
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = await fs.stat(full).catch(() => null);
    nodes.push({
      name: entry.name,
      path: toRelative(full),
      type: "file",
      size: stat?.size ?? 0,
      editable: isTextFile(entry.name) && !PROTECTED_FILES.has(entry.name),
    });
  }

  // Carpetas primero: es como se lee un árbol de proyecto.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export function normalizeRoute(route: string): string {
  const trimmed = String(route ?? "/").trim().replace(/\\/g, "/");
  const withSlash = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : "/";
}

/**
 * Saca el `title` del `metadata` exportado con una regex, sin evaluar el
 * módulo. Es solo una etiqueta para la lista: si la página lo arma con una
 * variable, queda vacío y no pasa nada.
 */
function extractMetadataTitle(source: string): string {
  const match = /title\s*:\s*["'`]([^"'`]{1,120})["'`]/.exec(source);
  return match ? match[1] : "";
}

/** `precios` -> `PreciosPage`; `[slug]` -> `SlugPage`. */
function componentName(segments: string[]): string {
  const base = segments
    .map((s) => s.replace(/[[\]().]/g, ""))
    .join("-")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
  return (base || "Nueva") + "Page";
}

function pageTemplate(name: string, route: string, segments: string[]): string {
  const safeName = name.replace(/"/g, '\\"');
  return `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "${safeName}",
};

export default function ${componentName(segments)}() {
  return (
    <main style={{ maxWidth: 720, margin: "80px auto", padding: "0 24px" }}>
      <h1>${escapeJsxText(name)}</h1>
      <p>
        Página nueva en <code>${route}</code>. El archivo es{" "}
        <code>src/app${route}/page.tsx</code>.
      </p>
    </main>
  );
}
`;
}

function escapeJsxText(text: string): string {
  return text.replace(/[{}<]/g, (ch) => '{"' + ch + '"}');
}
