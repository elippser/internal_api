import { execFile } from "child_process";
import { promisify } from "util";
import { env, PROJECT_DIR } from "./mktproject.service";

/**
 * Publicar el sitio público.
 *
 * El resto del módulo escribe el repo con `fs` y ahí termina. Eso alcanzaba
 * cuando `bookfer.com` se servía desde otro lado, pero desde el 30-08-2026 el
 * sitio se deploya en Coolify **desde GitHub**: un archivo guardado en
 * Marketing › Sitio no llega a producción hasta que alguien commitea, pushea y
 * dispara el build. Este archivo es esos tres pasos.
 *
 * No hay webhook en el repo (la app de Coolify se creó como "repo público", sin
 * GitHub App enlazada), así que el push por sí solo no construye nada: el
 * deploy se pide explícitamente por la API de Coolify.
 *
 * OJO: esto necesita filesystem de escritura y un `git` con credenciales. En
 * local se cumple; con el API en Vercel no, igual que el resto del módulo.
 */

const run = promisify(execFile);

/** Rama que Coolify tiene configurada. Publicar desde otra no deploya nada. */
const DEPLOY_BRANCH = env("MKT_DEPLOY_BRANCH", "master");

const COOLIFY_URL = env("COOLIFY_API_URL", "");
const COOLIFY_TOKEN = env("COOLIFY_API_TOKEN", "");
const COOLIFY_APP = env("MKT_COOLIFY_APP_UUID", "");

/**
 * La base de la API. El `.env.example` pide la raiz SIN `/api/v1` pero el
 * `.env` real la trae CON, asi que se aceptan las dos formas — misma
 * normalizacion que `infra/coolify.client.ts`.
 */
function coolifyApi(path: string): string {
  const base = COOLIFY_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base}/api/v1${path}`;
}

/** Host público, sólo para el texto de la UI. */
const PUBLIC_HOST = env("MKT_PUBLIC_HOST", "bookfer.com");

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

export type ChangeState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface ChangedFile {
  path: string;
  state: ChangeState;
}

export interface PublishStatus {
  /** `false` si la carpeta no es un repo git: no se puede publicar. */
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
  deployBranch: string;
  /** Commits locales que todavía no están en `origin`. */
  ahead: number;
  changes: ChangedFile[];
  lastCommit: { sha: string; message: string; date: string } | null;
  /** `false` si faltan las variables de Coolify: se puede pushear, no deployar. */
  deployConfigured: boolean;
  publicHost: string;
}

export interface PublishResult {
  committed: boolean;
  sha: string | null;
  files: number;
  pushed: boolean;
  deploymentUuid: string | null;
}

export interface DeploymentState {
  uuid: string;
  status: string;
  finished: boolean;
  ok: boolean;
}

/**
 * `git` a secas, sin shell (nada de lo que viene del panel se interpola en una
 * línea de comandos) y sin prompt interactivo: si las credenciales no están
 * guardadas queremos un error, no un proceso colgado esperando una contraseña.
 */
async function git(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: PROJECT_DIR,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.toString();
}

async function gitOrNull(args: string[]): Promise<string | null> {
  try {
    return (await git(args)).trim();
  } catch {
    return null;
  }
}

const STATE_BY_CODE: Record<string, ChangeState> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/**
 * `--porcelain -z` en vez de la salida legible: los nombres con espacios (o con
 * acentos, que git escaparía) llegan enteros, y los renombrados vienen como dos
 * entradas seguidas — la nueva ruta primero y la vieja después.
 */
function parseStatus(raw: string): ChangedFile[] {
  const parts = raw.split("\0");
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    if (code === "??") {
      out.push({ path: filePath, state: "untracked" });
      continue;
    }
    const letter = code.trim()[0] ?? "M";
    if (letter === "R" || letter === "C") {
      // La ruta original va en la entrada siguiente: se consume y se descarta.
      i++;
    }
    out.push({ path: filePath, state: STATE_BY_CODE[letter] ?? "modified" });
  }
  return out;
}

/**
 * `-uall` no es opcional: sin eso git colapsa una carpeta nueva entera en una
 * sola linea (`?? src/app/precios/`), que es exactamente lo que deja "Nueva
 * pagina". Stagear esa linea agrega N archivos, el conteo de control no
 * coincidiria y el publish abortaria en el caso mas comun de todos.
 */
async function readStatus(): Promise<ChangedFile[]> {
  return parseStatus(await git(["status", "--porcelain", "-z", "-uall"]));
}

export async function publishStatus(): Promise<PublishStatus> {
  const isRepo = (await gitOrNull(["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!isRepo) {
    return {
      isRepo: false,
      remote: null,
      branch: null,
      deployBranch: DEPLOY_BRANCH,
      ahead: 0,
      changes: [],
      lastCommit: null,
      deployConfigured: deployConfigured(),
      publicHost: PUBLIC_HOST,
    };
  }

  const branch = await gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = await gitOrNull(["remote", "get-url", "origin"]);
  const changes = await readStatus();

  // Contra `origin/<rama>` local: no se hace fetch acá para que abrir la
  // pantalla no dispare red cada vez. Basta para saber si falta pushear.
  const counts = await gitOrNull([
    "rev-list",
    "--count",
    `origin/${DEPLOY_BRANCH}..HEAD`,
  ]);

  const head = await gitOrNull([
    "log",
    "-1",
    "--format=%H%x1f%s%x1f%cI",
  ]);
  let lastCommit: PublishStatus["lastCommit"] = null;
  if (head) {
    const [sha, message, date] = head.split("\x1f");
    lastCommit = { sha: sha ?? "", message: message ?? "", date: date ?? "" };
  }

  return {
    isRepo: true,
    remote,
    branch,
    deployBranch: DEPLOY_BRANCH,
    ahead: Number(counts ?? "0") || 0,
    changes,
    lastCommit,
    deployConfigured: deployConfigured(),
    publicHost: PUBLIC_HOST,
  };
}

function deployConfigured(): boolean {
  return Boolean(COOLIFY_URL && COOLIFY_TOKEN && COOLIFY_APP);
}

/** Dispara el build en Coolify. Devuelve el uuid del deployment. */
async function triggerDeploy(): Promise<string | null> {
  if (!deployConfigured()) return null;
  const res = await fetch(
    coolifyApi(`/deploy?uuid=${encodeURIComponent(COOLIFY_APP)}&force=false`),
    { method: "POST", headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` } },
  );
  if (!res.ok) {
    throw httpError(
      502,
      `Coolify rechazó el deploy (HTTP ${res.status})`,
      "deploy_failed",
    );
  }
  const body = (await res.json()) as {
    deployments?: { deployment_uuid?: string }[];
  };
  return body.deployments?.[0]?.deployment_uuid ?? null;
}

export async function deploymentState(uuid: string): Promise<DeploymentState> {
  if (!deployConfigured()) {
    throw httpError(400, "Coolify no está configurado", "deploy_not_configured");
  }
  const res = await fetch(
    coolifyApi(`/deployments/${encodeURIComponent(uuid)}`),
    { headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` } },
  );
  if (!res.ok) {
    throw httpError(502, `Coolify respondió ${res.status}`, "deploy_status_failed");
  }
  const body = (await res.json()) as { status?: string };
  const status = body.status ?? "unknown";
  const finished = status !== "in_progress" && status !== "queued";
  return { uuid, status, finished, ok: status === "finished" };
}

export interface PublishInput {
  message: string;
  /** Email del usuario del panel: queda como autor del commit. */
  authorEmail: string;
  /** Sin cambios ni commits pendientes, redeploya el último commit igual. */
  force?: boolean;
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const status = await publishStatus();

  if (!status.isRepo) {
    throw httpError(
      409,
      "La carpeta del sitio no es un repo git: no hay nada que publicar",
      "not_a_repo",
    );
  }
  if (!status.remote) {
    throw httpError(
      409,
      "El repo no tiene remoto `origin` configurado",
      "no_remote",
    );
  }
  if (status.branch !== DEPLOY_BRANCH) {
    throw httpError(
      409,
      `El repo está en la rama "${status.branch}" y Coolify deploya "${DEPLOY_BRANCH}": publicar desde acá no cambiaría el sitio`,
      "wrong_branch",
    );
  }

  const pending = status.changes.length;
  if (pending === 0 && status.ahead === 0 && !input.force) {
    throw httpError(409, "No hay cambios para publicar", "nothing_to_publish");
  }

  let sha: string | null = status.lastCommit?.sha ?? null;
  let committed = false;

  if (pending > 0) {
    // Rutas explícitas, nunca `git add -A`: si el working tree quedó a medias
    // (un clone incompleto en Windows, por ejemplo) `-A` interpreta lo que
    // falta como borrado y publica una limpieza que nadie pidió.
    //
    // De a 50 porque la linea de comandos de Windows corta en 8191 caracteres:
    // un sitio con muchas paginas tocadas de golpe pasaria ese limite.
    const paths = status.changes.map((c) => c.path);
    for (let i = 0; i < paths.length; i += 50) {
      await git(["add", "--", ...paths.slice(i, i + 50)]);
    }

    const staged = (await git(["diff", "--cached", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean).length;
    if (staged !== pending) {
      await git(["reset"]);
      throw httpError(
        500,
        `Se iban a commitear ${staged} archivos y los cambios eran ${pending}: se abortó sin tocar el repo`,
        "stage_mismatch",
      );
    }

    const author = input.authorEmail || "panel@bookfer.com";
    await git([
      "-c",
      `user.name=${author.split("@")[0]}`,
      "-c",
      `user.email=${author}`,
      "commit",
      "-m",
      input.message,
      "-m",
      `Publicado desde Marketing > Sitio por ${author}.`,
    ]);
    committed = true;
    sha = (await gitOrNull(["rev-parse", "HEAD"])) ?? null;
  }

  await git(["push", "origin", `HEAD:${DEPLOY_BRANCH}`], 180_000);

  const deploymentUuid = await triggerDeploy();

  return {
    committed,
    sha,
    files: pending,
    pushed: true,
    deploymentUuid,
  };
}
