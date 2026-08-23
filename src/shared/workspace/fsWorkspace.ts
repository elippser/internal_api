import fs from "fs/promises";
import path from "path";

/**
 * Acceso a una carpeta del monorepo como si fuera un workspace de editor.
 *
 * Es la mecánica que ya usaba el workspace del sitio público
 * (`modules/mktproject`) sacada a un lugar compartido: leer un árbol, abrir un
 * archivo como texto y escribirlo, con los guardas puestos. Lo que cambia entre
 * un workspace y otro es la raíz y qué se deja tocar, no cómo se lee el disco.
 *
 * Implica que el API y lo que se edita comparten filesystem. En el monorepo
 * local eso es cierto por definición; si algún día se despliegan separados, hay
 * que montar un volumen y apuntar la raíz por variable de entorno.
 *
 * `mktproject` NO se migró a este helper: anda y está en producción, y
 * reescribirlo para ahorrar duplicación sería arriesgar una pantalla que
 * funciona por una mejora que no se ve. Si se toca, que sea con esto a mano.
 */

export interface WorkspaceRootConfig {
  /** Raíz absoluta. Todo lo demás se resuelve adentro y nada se escapa. */
  dir: string;
  /** Carpetas que ni se listan: ruido de build, dependencias, historial. */
  hiddenDirs?: Set<string>;
  /** Nombres que se listan pero nunca se escriben. */
  protectedFiles?: Set<string>;
  /** Extensiones que el editor abre como texto. */
  textExtensions?: Set<string>;
  /** Tope de tamaño al abrir. Un archivo de código nunca se acerca. */
  maxBytes?: number;
}

export interface TreeNode {
  name: string;
  /** Relativa a la raíz, siempre con `/`. */
  path: string;
  type: "file" | "dir";
  size?: number;
  /** `false` en binarios y en los archivos protegidos. */
  editable?: boolean;
  children?: TreeNode[];
}

export interface WorkspaceFile {
  path: string;
  binary: boolean;
  size: number;
  /** Id de lenguaje de Monaco. */
  language: string;
  content: string;
  updatedAt: string;
}

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

const DEFAULT_HIDDEN = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  "dist",
  ".vercel",
]);

const DEFAULT_TEXT = new Set([
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

/** 1 MB. Un componente legítimo nunca se acerca; un binario sí. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * `??` no alcanza: en los `.env` estas variables suelen estar declaradas
 * vacías, y una cadena vacía no es nullish. Sin esto un `X_DIR=` haría que la
 * raíz se resolviera contra el cwd del proceso.
 */
export function envDir(name: string, fallback: string): string {
  const value = process.env[name];
  return path.resolve(value && value.trim() ? value.trim() : fallback);
}

/** Lenguaje para Monaco a partir de la extensión. */
export function languageOf(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case ".tsx":
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

export class FsWorkspace {
  private readonly dir: string;
  private readonly hidden: Set<string>;
  private readonly protectedFiles: Set<string>;
  private readonly textExtensions: Set<string>;
  private readonly maxBytes: number;

  constructor(config: WorkspaceRootConfig) {
    this.dir = path.resolve(config.dir);
    this.hidden = config.hiddenDirs ?? DEFAULT_HIDDEN;
    this.protectedFiles = config.protectedFiles ?? new Set(["package-lock.json"]);
    this.textExtensions = config.textExtensions ?? DEFAULT_TEXT;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get root(): string {
    return this.dir;
  }

  async exists(): Promise<boolean> {
    try {
      const st = await fs.stat(this.dir);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Traduce una ruta relativa del panel a una absoluta dentro de la raíz.
   *
   * El chequeo va sobre la ruta ya resuelta y no sobre el texto de entrada: con
   * `..`, symlinks y separadores mezclados de Windows, cualquier validación por
   * substring se escapa tarde o temprano.
   */
  private resolve(relative: string): string {
    const clean = String(relative ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!clean) return this.dir;

    const full = path.resolve(this.dir, clean);
    const rel = path.relative(this.dir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw httpError(400, "Ruta fuera del workspace", "path_escape");
    }
    if (rel.split(path.sep).some((s) => this.hidden.has(s))) {
      throw httpError(
        403,
        "Esa carpeta no se puede tocar desde el panel",
        "hidden_path",
      );
    }
    return full;
  }

  private resolveWritable(relative: string): string {
    const full = this.resolve(relative);
    const name = path.basename(full);
    if (this.protectedFiles.has(name)) {
      throw httpError(403, `${name} no se edita desde el panel`, "protected_file");
    }
    if (name.startsWith(".env")) {
      throw httpError(403, "Los .env no se editan desde el panel", "protected_file");
    }
    return full;
  }

  private toRelative(full: string): string {
    return path.relative(this.dir, full).split(path.sep).join("/");
  }

  private isText(name: string): boolean {
    return this.textExtensions.has(path.extname(name).toLowerCase());
  }

  async tree(relative = ""): Promise<TreeNode[]> {
    const base = this.resolve(relative);
    const walk = async (dir: string): Promise<TreeNode[]> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const nodes: TreeNode[] = [];
      for (const entry of entries) {
        if (this.hidden.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: this.toRelative(full),
            type: "dir",
            children: await walk(full),
          });
        } else if (entry.isFile()) {
          const st = await fs.stat(full).catch(() => null);
          nodes.push({
            name: entry.name,
            path: this.toRelative(full),
            type: "file",
            size: st?.size ?? 0,
            editable:
              this.isText(entry.name) && !this.protectedFiles.has(entry.name),
          });
        }
      }
      // Carpetas primero y después alfabético: es como se lee un árbol.
      return nodes.sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "dir"
            ? -1
            : 1,
      );
    };
    return walk(base);
  }

  async readFile(relative: string): Promise<WorkspaceFile> {
    const full = this.resolve(relative);
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) {
      throw httpError(404, "Archivo no encontrado", "not_found");
    }
    const name = path.basename(full);
    const binary = !this.isText(name) || st.size > this.maxBytes;
    return {
      path: this.toRelative(full),
      binary,
      size: st.size,
      language: languageOf(name),
      content: binary ? "" : await fs.readFile(full, "utf8"),
      updatedAt: st.mtime.toISOString(),
    };
  }

  async writeFile(relative: string, content: string): Promise<WorkspaceFile> {
    const full = this.resolveWritable(relative);
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) {
      throw httpError(404, "Archivo no encontrado", "not_found");
    }
    await fs.writeFile(full, content, "utf8");
    return this.readFile(this.toRelative(full));
  }

  async createFile(relative: string, content = ""): Promise<WorkspaceFile> {
    const full = this.resolveWritable(relative);
    if (await fs.stat(full).catch(() => null)) {
      throw httpError(409, "Ya existe algo con ese nombre", "already_exists");
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return this.readFile(this.toRelative(full));
  }

  async createDir(relative: string): Promise<{ path: string }> {
    const full = this.resolveWritable(relative);
    await fs.mkdir(full, { recursive: true });
    return { path: this.toRelative(full) };
  }

  async rename(from: string, to: string): Promise<{ path: string }> {
    const src = this.resolveWritable(from);
    const dest = this.resolveWritable(to);
    if (await fs.stat(dest).catch(() => null)) {
      throw httpError(409, "Ya existe algo con ese nombre", "already_exists");
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    return { path: this.toRelative(dest) };
  }

  async remove(relative: string): Promise<{ deleted: true; path: string }> {
    const full = this.resolveWritable(relative);
    if (full === this.dir) {
      throw httpError(400, "No se puede borrar la raíz", "invalid_path");
    }
    await fs.rm(full, { recursive: true, force: true });
    return { deleted: true, path: this.toRelative(full) };
  }
}
