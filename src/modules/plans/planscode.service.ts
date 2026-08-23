import path from "path";
import { FsWorkspace, envDir } from "../../shared/workspace/fsWorkspace";

/**
 * El código de las pantallas de planes, editable desde el panel.
 *
 * Las tarjetas de planes se muestran en dos lugares distintos y comparten los
 * mismos datos, así que se editan desde el mismo workspace:
 *
 *   pms → la pantalla de elección del alta (`/planes` de pms-core). La ve el
 *         hotelero entre terminar el alta y entrar al escritorio.
 *   mkt → el módulo `<PlansMkt/>` del sitio público de bookfer. Es un
 *         componente suelto que se pone en cualquier página del sitio.
 *
 * Son dos repos y dos servidores de desarrollo, pero un solo editor: lo que
 * cambia entre uno y otro es la carpeta y a dónde apunta la vista previa.
 *
 * Como en el workspace del sitio, el puente es el filesystem: el API interno y
 * los renderers comparten disco. En el monorepo eso es cierto por definición;
 * en un deploy separado hay que montar un volumen y apuntar las variables de
 * abajo.
 */

export type PlansCodeTargetId = "pms" | "mkt";

interface TargetConfig {
  id: PlansCodeTargetId;
  label: string;
  description: string;
  workspace: FsWorkspace;
  /** Dev server donde se ve el resultado. */
  previewBase: string;
  /** Ruta de la vista previa dentro de ese server. */
  previewPath: string;
  /**
   * Archivos que el editor abre primero, en orden. El resto del árbol sigue
   * estando: esto es sólo qué pestañas aparecen sin buscar.
   */
  entryFiles: string[];
}

// src/modules/plans -> api -> internal-laupser -> raíz del monorepo.
// Compilado queda en dist/modules/plans: misma profundidad.
const MONOREPO = path.join(__dirname, "..", "..", "..", "..", "..");

const TARGETS: Record<PlansCodeTargetId, TargetConfig> = {
  pms: {
    id: "pms",
    label: "Pantalla del PMS",
    description:
      "La elección de plan que ve el hotelero al terminar el alta (/planes).",
    workspace: new FsWorkspace({
      dir: envDir(
        "PLANS_PMS_DIR",
        path.join(MONOREPO, "pms-core", "app", "src", "components", "planComponents"),
      ),
    }),
    previewBase: process.env.PLANS_PMS_URL?.trim() || "http://localhost:9000",
    // Ruta sin sesión: el operador del panel interno no tiene login del PMS, y
    // pedirle uno para ver un cambio de diseño sería absurdo.
    previewPath: "/plan-preview",
    entryFiles: ["PlanSelectionScreen.tsx", "PlanSelection.module.css"],
  },
  mkt: {
    id: "mkt",
    label: "Módulo del sitio",
    description:
      "El componente <PlansMkt/> que se inserta en las páginas del sitio público.",
    workspace: new FsWorkspace({
      dir: envDir(
        "PLANS_MKT_DIR",
        path.join(MONOREPO, "public-side", "mkt-renderer", "src", "components", "plans"),
      ),
    }),
    previewBase: process.env.MKT_RENDERER_URL?.trim() || "http://localhost:6300",
    previewPath: "/preview/plans",
    entryFiles: ["PlansMkt.tsx", "PlansMkt.module.css"],
  },
};

function targetOf(id: string): TargetConfig {
  const target = TARGETS[id as PlansCodeTargetId];
  if (!target) {
    const err = new Error(`Destino desconocido: ${id}`) as Error & {
      status: number;
      code: string;
    };
    err.status = 400;
    err.code = "unknown_target";
    throw err;
  }
  return target;
}

/** Idiomas que ofrece el selector de la vista previa. */
export const PREVIEW_LOCALES = ["es", "en", "fr", "de", "pt"] as const;

export const plansCodeService = {
  /** Estado de los dos destinos: dónde están y dónde se ven. */
  async targets() {
    const out = [];
    for (const target of Object.values(TARGETS)) {
      out.push({
        id: target.id,
        label: target.label,
        description: target.description,
        root: target.workspace.root,
        exists: await target.workspace.exists(),
        previewUrl: `${target.previewBase.replace(/\/$/, "")}${target.previewPath}`,
        entryFiles: target.entryFiles,
      });
    }
    return out;
  },

  tree(id: string) {
    return targetOf(id).workspace.tree();
  },

  readFile(id: string, relative: string) {
    return targetOf(id).workspace.readFile(relative);
  },

  writeFile(id: string, relative: string, content: string) {
    return targetOf(id).workspace.writeFile(relative, content);
  },

  createFile(id: string, relative: string, content = "") {
    return targetOf(id).workspace.createFile(relative, content);
  },

  rename(id: string, from: string, to: string) {
    return targetOf(id).workspace.rename(from, to);
  },

  remove(id: string, relative: string) {
    return targetOf(id).workspace.remove(relative);
  },
};
