/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * EDICIÓN QUIRÚRGICA DE PÁGINAS DEL WEB BUILDER.
 *
 * El builder guarda cada página como un array de componentes
 * (`[{ name, type, priority, props }]`) donde `props` es un objeto anidado
 * arbitrario. El único endpoint de escritura que existe recibe el ARRAY ENTERO
 * (`PUT /site-data/update/:subSiteId/to-page/:pageId/from/:siteId`).
 *
 * Exponer eso tal cual al modelo es la forma segura de romper páginas: para
 * cambiar un título tendría que reproducir cientos de KB de árbol sin perder ni
 * una clave, y cualquier alucinación vacía la página. Por eso el agente NO ve
 * el endpoint crudo: ve estas operaciones, que hacen read-modify-write acá
 * dentro y sólo dejan tocar lo que no puede romper la estructura.
 *
 * Garantías de este módulo, en orden de importancia:
 *
 *   1. `edit_page_content` SÓLO reemplaza hojas escalares que YA existen. Un
 *      path que no existe, o que apunta a un objeto/array, se rechaza. Nunca
 *      crea, borra ni reordena nada.
 *   2. Las operaciones estructurales (mover, eliminar, duplicar un componente)
 *      van por tools aparte, trabajan por índice y validan contra el árbol real.
 *   3. Todo se escribe al BORRADOR (colección `SiteDraft`), nunca directo a lo
 *      publicado. Publicar es un paso explícito y aparte (`publish_site_changes`),
 *      igual que en el editor visual. Si una edición sale mal, `discard_site_draft`
 *      la deshace sin haber tocado el sitio en vivo.
 *   4. La lectura devuelve un ÍNDICE de hojas editables (path + valor + tipo),
 *      no el árbol: el modelo trabaja con paths cortos y el contexto no explota.
 */
import { pmsRequest } from "../../../shared/middleware/pmsProxy";

export const BUILDER_EDITOR_TOOLS = new Set([
  "get_page_content",
  "edit_page_content",
  "move_page_component",
  "remove_page_component",
  "duplicate_page_component",
  "get_site_global_content",
  "edit_site_global_content",
  "check_site_quality",
  "autofix_site_quality",
  "discard_site_draft",
]);

/** Tope de hojas devueltas por lectura: más que esto no le sirve al modelo. */
const MAX_LEAVES = 220;
/** Tope de ediciones por llamada: un cambio masivo tiene que ser deliberado. */
const MAX_EDITS = 60;
/** Tope de largo de un valor de texto (evita pegar un documento entero). */
const MAX_VALUE_LEN = 20000;

export type DraftScope = "page" | "top" | "bottom";

export class BuilderEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderEditError";
  }
}

// ── Acceso a pms-core ────────────────────────────────────────────────────────

interface Ctx {
  agentJwt?: string;
}

function req<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  ctx: Ctx,
  body?: unknown,
): Promise<T> {
  return pmsRequest<T>({
    service: "pms-core",
    method,
    path,
    body,
    agentJwt: ctx.agentJwt,
    timeoutMs: 20000,
  });
}

async function fetchSubSite(siteId: string, subSiteId: string, ctx: Ctx): Promise<any> {
  const sub = await req<any>(
    "GET",
    `/site-data/subsite/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}`,
    ctx,
  );
  if (!sub || typeof sub !== "object") {
    throw new BuilderEditError(
      `No se encontró el sitio ${subSiteId}. Usá list_site_projects / get_site_project para ver los sitios y sus variantes de idioma.`,
    );
  }
  return sub;
}

/** Borradores del editor para una página: `{ page, top, bottom }`, cada uno array o null. */
async function fetchDrafts(
  siteId: string,
  subSiteId: string,
  pageId: string,
  ctx: Ctx,
): Promise<{ page: any; top: any; bottom: any }> {
  try {
    const d = await req<any>(
      "GET",
      `/site-data/drafts/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}/page/${encodeURIComponent(pageId)}`,
      ctx,
    );
    return {
      page: d?.page?.components ?? d?.page ?? null,
      top: d?.top?.components ?? d?.top ?? null,
      bottom: d?.bottom?.components ?? d?.bottom ?? null,
    };
  } catch {
    // Sin borradores todavía: trabajamos sobre lo publicado.
    return { page: null, top: null, bottom: null };
  }
}

async function saveDraft(
  siteId: string,
  subSiteId: string,
  scope: DraftScope,
  pageId: string | null,
  components: any[],
  ctx: Ctx,
): Promise<void> {
  await req(
    "PUT",
    `/site-data/draft/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}`,
    ctx,
    { scope, pageId: scope === "page" ? pageId : undefined, components },
  );
}

// ── Navegación del árbol ─────────────────────────────────────────────────────

function findPage(subSite: any, pageId: string): any {
  const pages: any[] = Array.isArray(subSite?.pages) ? subSite.pages : [];
  const byId = pages.find((p) => String(p?._id) === String(pageId));
  if (byId) return byId;
  // Tolerancia: el modelo suele tener a mano el nombre o la URL, no el _id.
  const needle = String(pageId).toLowerCase().replace(/^\//, "");
  const byName = pages.find(
    (p) =>
      String(p?.name ?? "").toLowerCase() === needle ||
      String(p?.urlPage ?? "").toLowerCase().replace(/^\//, "") === needle,
  );
  if (byName) return byName;
  const available = pages
    .map((p) => `${p?.name ?? "(sin nombre)"} [${p?._id}]`)
    .join(", ");
  throw new BuilderEditError(
    `No existe la página "${pageId}" en este sitio. Páginas disponibles: ${available || "ninguna"}.`,
  );
}

const IMAGE_KEY = /(image|img|photo|picture|cover|logo|icon|avatar|background|bg|src|poster|thumbnail)$/i;
const IMAGE_VALUE = /^(https?:\/\/|\/)[^\s]*\.(jpe?g|png|webp|gif|avif|svg)(\?|$)/i;
const URL_VALUE = /^https?:\/\//i;

function leafKind(key: string, value: string): "image" | "url" | "text" {
  if (IMAGE_VALUE.test(value)) return "image";
  if (IMAGE_KEY.test(key) && URL_VALUE.test(value)) return "image";
  if (URL_VALUE.test(value)) return "url";
  return "text";
}

export interface Leaf {
  path: string;
  kind: "image" | "url" | "text" | "number" | "boolean";
  value: string | number | boolean;
  /** Componente al que pertenece, para que el modelo ubique el cambio. */
  component: string;
}

/**
 * Aplana el árbol a hojas escalares direccionables. El path arranca en el
 * índice del componente: `2.props.title`, `0.props.slides.1.image`.
 */
/** Exportada para el test de seguridad (test:builder-editor). */
export function flatten(components: any[], opts: { componentIndex?: number; contains?: string } = {}): {
  leaves: Leaf[];
  truncated: boolean;
} {
  const leaves: Leaf[] = [];
  let truncated = false;
  const needle = opts.contains?.toLowerCase();

  const visit = (node: any, path: string, componentLabel: string, key: string): void => {
    if (leaves.length >= MAX_LEAVES) {
      truncated = true;
      return;
    }
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${path}.${i}`, componentLabel, key));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`, componentLabel, k);
      return;
    }
    if (typeof node === "string") {
      if (!node.trim()) return;
      if (needle && !node.toLowerCase().includes(needle)) return;
      leaves.push({ path, kind: leafKind(key, node), value: node, component: componentLabel });
      return;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      if (needle) return;
      leaves.push({
        path,
        kind: typeof node === "number" ? "number" : "boolean",
        value: node,
        component: componentLabel,
      });
    }
  };

  components.forEach((comp, i) => {
    if (opts.componentIndex !== undefined && opts.componentIndex !== i) return;
    const label = `${i}:${comp?.name ?? comp?.type ?? "componente"}`;
    visit(comp?.props, `${i}.props`, label, "props");
  });

  return { leaves, truncated };
}

/** Resuelve un path a `{ parent, key }` exigiendo que la hoja YA exista. */
/** Exportada para el test de seguridad (test:builder-editor). */
export function resolveLeaf(components: any[], rawPath: string): { parent: any; key: string | number } {
  const parts = String(rawPath).split(".").filter((s) => s.length > 0);
  if (parts.length < 2) {
    throw new BuilderEditError(
      `Path inválido: "${rawPath}". Tiene que ser el que devolvió get_page_content (ej. "2.props.title").`,
    );
  }
  let node: any = components;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const key: string | number = /^\d+$/.test(seg) ? Number(seg) : seg;
    if (node === null || node === undefined || typeof node !== "object") {
      throw new BuilderEditError(
        `El path "${rawPath}" no existe: se cortó en "${parts.slice(0, i + 1).join(".")}".`,
      );
    }
    node = (node as any)[key as any];
  }
  const last = parts[parts.length - 1];
  const key: string | number = /^\d+$/.test(last) ? Number(last) : last;
  if (node === null || node === undefined || typeof node !== "object") {
    throw new BuilderEditError(`El path "${rawPath}" no existe en esta página.`);
  }
  const current = (node as any)[key as any];
  if (current === undefined) {
    throw new BuilderEditError(
      `El path "${rawPath}" no existe en esta página. Leé la página con get_page_content y usá un path de los que devuelve: esta herramienta sólo reemplaza valores existentes, no crea campos nuevos.`,
    );
  }
  if (current !== null && typeof current === "object") {
    throw new BuilderEditError(
      `El path "${rawPath}" apunta a ${Array.isArray(current) ? "una lista" : "un objeto"}, no a un valor editable. Bajá hasta la hoja concreta (ej. "${rawPath}.0.title").`,
    );
  }
  return { parent: node, key };
}

// ── Operaciones ──────────────────────────────────────────────────────────────

interface BuilderArgs {
  siteId?: unknown;
  subSiteId?: unknown;
  pageId?: unknown;
  scope?: unknown;
  edits?: unknown;
  componentIndex?: unknown;
  from?: unknown;
  to?: unknown;
  contains?: unknown;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new BuilderEditError(`Falta el parámetro "${name}".`);
  }
  return v.trim();
}

function scopeOf(v: unknown): DraftScope {
  const s = String(v ?? "top").toLowerCase();
  if (s === "top" || s === "bottom") return s;
  throw new BuilderEditError(`"scope" tiene que ser "top" (encabezado) o "bottom" (pie). Recibido: ${String(v)}.`);
}

/** Estado efectivo de una página: el borrador si existe, si no lo publicado. */
async function pageState(args: BuilderArgs, ctx: Ctx) {
  const siteId = str(args.siteId, "siteId");
  const subSiteId = str(args.subSiteId, "subSiteId");
  const pageIdArg = str(args.pageId, "pageId");
  const subSite = await fetchSubSite(siteId, subSiteId, ctx);
  const page = findPage(subSite, pageIdArg);
  const pageId = String(page._id);
  const drafts = await fetchDrafts(siteId, subSiteId, pageId, ctx);
  const published: any[] = Array.isArray(page.components) ? page.components : [];
  const components: any[] = Array.isArray(drafts.page) ? drafts.page : published;
  return {
    siteId,
    subSiteId,
    pageId,
    page,
    subSite,
    components,
    hasDraft: Array.isArray(drafts.page),
  };
}

async function globalState(args: BuilderArgs, ctx: Ctx) {
  const siteId = str(args.siteId, "siteId");
  const subSiteId = str(args.subSiteId, "subSiteId");
  const scope = scopeOf(args.scope);
  const subSite = await fetchSubSite(siteId, subSiteId, ctx);
  const globals = subSite?.siteGlobalPagesComponents ?? {};
  const published: any[] =
    scope === "top"
      ? (globals.topGlobalComponents ?? [])
      : (globals.bottomGlobalComponents ?? []);
  // Los borradores globales se leen por cualquier página; usamos la primera.
  const firstPage = Array.isArray(subSite?.pages) ? subSite.pages[0] : null;
  const drafts = firstPage
    ? await fetchDrafts(siteId, subSiteId, String(firstPage._id), ctx)
    : { page: null, top: null, bottom: null };
  const draft = scope === "top" ? drafts.top : drafts.bottom;
  return {
    siteId,
    subSiteId,
    scope,
    components: Array.isArray(draft) ? draft : (Array.isArray(published) ? published : []),
    hasDraft: Array.isArray(draft),
  };
}

function outline(components: any[]) {
  return components.map((c, i) => ({
    index: i,
    name: c?.name ?? c?.type ?? "componente",
    type: c?.type ?? null,
    priority: c?.priority ?? null,
  }));
}

/** Exportada para el test de seguridad (test:builder-editor). */
export function parseEdits(raw: unknown): Array<{ path: string; value: string | number | boolean }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BuilderEditError(
      `"edits" tiene que ser una lista de { path, value } con al menos un cambio.`,
    );
  }
  if (raw.length > MAX_EDITS) {
    throw new BuilderEditError(
      `Demasiados cambios de una vez (${raw.length}, máximo ${MAX_EDITS}). Partilo en varias ediciones.`,
    );
  }
  return raw.map((e: any, i) => {
    if (!e || typeof e !== "object") {
      throw new BuilderEditError(`El cambio #${i + 1} no es un objeto { path, value }.`);
    }
    const path = str(e.path, `edits[${i}].path`);
    const value = e.value;
    if (typeof value === "string") {
      if (value.length > MAX_VALUE_LEN) {
        throw new BuilderEditError(
          `El texto del cambio #${i + 1} es demasiado largo (${value.length} caracteres).`,
        );
      }
      return { path, value };
    }
    if (typeof value === "number" || typeof value === "boolean") return { path, value };
    throw new BuilderEditError(
      `El valor del cambio #${i + 1} tiene que ser texto, número o booleano (no ${value === null ? "null" : typeof value}).`,
    );
  });
}

// ── Calidad del sitio (panel "Calidad" del builder) ──────────────────────────
//
// Envuelven los dos POST del panel. El chequeo no escribe nada. "Arreglar todo"
// tampoco escribe del lado del API: devuelve los scopes corregidos y el editor
// los guarda. Acá se guarda igual que el editor (SiteQualityChip): de cada
// sección SOLO se reemplazan los `props` que corrigió el lint del servidor, y
// solo si la cantidad de secciones coincide. Nunca se agregan, quitan ni
// reordenan secciones, y las secciones van al BORRADOR. Título/descripción de
// la página y descripción del sitio se guardan directo, como en el editor.

const MAX_QUALITY_ISSUES = 60;

function compactQuality(report: any) {
  const issues: any[] = Array.isArray(report?.issues) ? report.issues : [];
  const byCategory: Record<string, number> = {};
  for (const i of issues) {
    const c = String(i?.category ?? "otros");
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }
  return {
    summary: report?.summary ?? {
      errors: issues.filter((i) => i?.severity === "error").length,
      warnings: issues.filter((i) => i?.severity === "warning").length,
    },
    byCategory,
    issues: issues.slice(0, MAX_QUALITY_ISSUES).map((i) => ({
      rule: i?.rule,
      severity: i?.severity,
      category: i?.category,
      scope: i?.scope,
      pageId: i?.pageId,
      sectionIndex: i?.sectionIndex,
      message: i?.message,
      autoFixable: Boolean(i?.fix),
    })),
    truncated: issues.length > MAX_QUALITY_ISSUES,
  };
}

/** Espejo de `mergeFixedProps` de SiteQualityChip. Exportada para test:guardrails. */
export function mergeFixedProps(current: unknown, fixed: unknown): any[] | null {
  if (!Array.isArray(current) || !Array.isArray(fixed) || current.length !== fixed.length) return null;
  let changed = false;
  const merged = current.map((section: any, index: number) => {
    const props = (fixed[index] as any)?.props;
    if (!props || typeof props !== "object") return section;
    if (JSON.stringify(props) === JSON.stringify(section?.props ?? {})) return section;
    changed = true;
    return { ...section, props };
  });
  return changed ? merged : null;
}

async function qualityInput(args: BuilderArgs, ctx: Ctx, requirePage: boolean) {
  const siteId = str(args.siteId, "siteId");
  const subSiteId = str(args.subSiteId, "subSiteId");
  const pageArg = requirePage
    ? str(args.pageId, "pageId")
    : typeof args.pageId === "string" ? args.pageId.trim() : "";
  if (!pageArg) {
    return { siteId, subSiteId, pageId: null, page: null as any, scopes: null, body: {} };
  }
  const subSite = await fetchSubSite(siteId, subSiteId, ctx);
  const page = findPage(subSite, pageArg);
  const pageId = String(page._id);
  const drafts = await fetchDrafts(siteId, subSiteId, pageId, ctx);
  const globals = subSite?.siteGlobalPagesComponents ?? {};
  const pick = (draft: any, published: any): any[] =>
    Array.isArray(draft) ? draft : Array.isArray(published) ? published : [];
  const scopes: Record<DraftScope, any[]> = {
    page: pick(drafts.page, page.components),
    top: pick(drafts.top, globals.topGlobalComponents),
    bottom: pick(drafts.bottom, globals.bottomGlobalComponents),
  };
  return { siteId, subSiteId, pageId, page, scopes, body: { pageId, scopes } };
}

const qualityPath = (siteId: string, subSiteId: string) =>
  `/site-data/quality/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}`;

/** Ejecuta una tool nativa del builder. Devuelve el resultado para el modelo. */
export async function runBuilderTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  ctx: Ctx,
): Promise<unknown> {
  const args = rawArgs as BuilderArgs;

  switch (toolName) {
    // ── Lectura de una página ────────────────────────────────────────────────
    case "get_page_content": {
      const st = await pageState(args, ctx);
      const componentIndex =
        typeof args.componentIndex === "number" ? args.componentIndex : undefined;
      const contains = typeof args.contains === "string" && args.contains.trim()
        ? args.contains.trim()
        : undefined;
      const { leaves, truncated } = flatten(st.components, { componentIndex, contains });
      return {
        siteId: st.siteId,
        subSiteId: st.subSiteId,
        pageId: st.pageId,
        pageName: st.page?.name ?? null,
        url: st.page?.urlPage ?? null,
        status: st.page?.status ?? null,
        editingDraft: st.hasDraft,
        componentCount: st.components.length,
        components: outline(st.components),
        editable: leaves,
        truncated,
        hint: truncated
          ? `Se listaron las primeras ${MAX_LEAVES} hojas. Volvé a llamar con componentIndex para ver un componente puntual, o con contains para filtrar por texto.`
          : "Para cambiar un valor, llamá edit_page_content con el mismo `path` tal cual aparece acá.",
      };
    }

    // ── Edición de valores de una página ─────────────────────────────────────
    case "edit_page_content": {
      const st = await pageState(args, ctx);
      const edits = parseEdits(args.edits);
      const next = JSON.parse(JSON.stringify(st.components));
      const applied: Array<{ path: string; before: unknown; after: unknown }> = [];
      for (const e of edits) {
        const { parent, key } = resolveLeaf(next, e.path);
        const before = (parent as any)[key as any];
        if (typeof before !== typeof e.value) {
          throw new BuilderEditError(
            `El path "${e.path}" contiene ${typeof before === "string" ? "texto" : typeof before} y le estás pasando ${typeof e.value === "string" ? "texto" : typeof e.value}. No se cambia el tipo de un campo desde el chat.`,
          );
        }
        (parent as any)[key as any] = e.value;
        applied.push({ path: e.path, before, after: e.value });
      }
      await saveDraft(st.siteId, st.subSiteId, "page", st.pageId, next, ctx);
      return {
        ok: true,
        pageId: st.pageId,
        pageName: st.page?.name ?? null,
        changed: applied,
        published: false,
        message:
          `Se guardaron ${applied.length} cambio(s) en el BORRADOR de "${st.page?.name ?? st.pageId}". ` +
          `Todavía no están en la web publicada: para que salgan al aire hay que publicar con publish_site_changes. ` +
          `Si algo quedó mal, discard_site_draft descarta el borrador y no se tocó nada del sitio en vivo.`,
      };
    }

    // ── Estructura de la página ──────────────────────────────────────────────
    case "move_page_component": {
      const st = await pageState(args, ctx);
      const from = Number(args.from);
      const to = Number(args.to);
      const n = st.components.length;
      if (!Number.isInteger(from) || from < 0 || from >= n) {
        throw new BuilderEditError(`"from" tiene que ser un índice entre 0 y ${n - 1}.`);
      }
      if (!Number.isInteger(to) || to < 0 || to >= n) {
        throw new BuilderEditError(`"to" tiene que ser un índice entre 0 y ${n - 1}.`);
      }
      const next = JSON.parse(JSON.stringify(st.components));
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      // `priority` es el orden con el que renderiza el sitio: reindexamos.
      next.forEach((c: any, i: number) => {
        if (c && typeof c === "object" && c.priority !== undefined) c.priority = i;
      });
      await saveDraft(st.siteId, st.subSiteId, "page", st.pageId, next, ctx);
      return {
        ok: true,
        moved: { name: moved?.name ?? moved?.type, from, to },
        components: outline(next),
        published: false,
        message: `Se movió "${moved?.name ?? moved?.type}" de la posición ${from} a la ${to} en el borrador. Falta publicar.`,
      };
    }

    case "remove_page_component": {
      const st = await pageState(args, ctx);
      const index = Number(args.componentIndex);
      const n = st.components.length;
      if (!Number.isInteger(index) || index < 0 || index >= n) {
        throw new BuilderEditError(
          `"componentIndex" tiene que ser un índice entre 0 y ${n - 1}. Leé la página con get_page_content para ver los componentes.`,
        );
      }
      const next = JSON.parse(JSON.stringify(st.components));
      const [removed] = next.splice(index, 1);
      next.forEach((c: any, i: number) => {
        if (c && typeof c === "object" && c.priority !== undefined) c.priority = i;
      });
      await saveDraft(st.siteId, st.subSiteId, "page", st.pageId, next, ctx);
      return {
        ok: true,
        removed: { index, name: removed?.name ?? removed?.type },
        remaining: outline(next),
        published: false,
        message:
          `Se quitó "${removed?.name ?? removed?.type}" del BORRADOR de "${st.page?.name ?? st.pageId}". ` +
          `La web publicada sigue igual; se revierte con discard_site_draft.`,
      };
    }

    case "duplicate_page_component": {
      const st = await pageState(args, ctx);
      const index = Number(args.componentIndex);
      const n = st.components.length;
      if (!Number.isInteger(index) || index < 0 || index >= n) {
        throw new BuilderEditError(`"componentIndex" tiene que ser un índice entre 0 y ${n - 1}.`);
      }
      const next = JSON.parse(JSON.stringify(st.components));
      const copy = JSON.parse(JSON.stringify(next[index]));
      next.splice(index + 1, 0, copy);
      next.forEach((c: any, i: number) => {
        if (c && typeof c === "object" && c.priority !== undefined) c.priority = i;
      });
      await saveDraft(st.siteId, st.subSiteId, "page", st.pageId, next, ctx);
      return {
        ok: true,
        duplicated: { source: index, newIndex: index + 1, name: copy?.name ?? copy?.type },
        components: outline(next),
        published: false,
        message: `Se duplicó "${copy?.name ?? copy?.type}" en el borrador (quedó en la posición ${index + 1}). Editá el nuevo con edit_page_content y publicá cuando esté listo.`,
      };
    }

    // ── Encabezado y pie (globales del sitio) ────────────────────────────────
    case "get_site_global_content": {
      const st = await globalState(args, ctx);
      const contains = typeof args.contains === "string" && args.contains.trim()
        ? args.contains.trim()
        : undefined;
      const { leaves, truncated } = flatten(st.components, { contains });
      return {
        siteId: st.siteId,
        subSiteId: st.subSiteId,
        scope: st.scope,
        scopeLabel: st.scope === "top" ? "encabezado (top global)" : "pie (bottom global)",
        editingDraft: st.hasDraft,
        componentCount: st.components.length,
        components: outline(st.components),
        editable: leaves,
        truncated,
      };
    }

    case "edit_site_global_content": {
      const st = await globalState(args, ctx);
      const edits = parseEdits(args.edits);
      const next = JSON.parse(JSON.stringify(st.components));
      const applied: Array<{ path: string; before: unknown; after: unknown }> = [];
      for (const e of edits) {
        const { parent, key } = resolveLeaf(next, e.path);
        const before = (parent as any)[key as any];
        if (typeof before !== typeof e.value) {
          throw new BuilderEditError(
            `El path "${e.path}" contiene ${typeof before} y le estás pasando ${typeof e.value}. No se cambia el tipo de un campo desde el chat.`,
          );
        }
        (parent as any)[key as any] = e.value;
        applied.push({ path: e.path, before, after: e.value });
      }
      await saveDraft(st.siteId, st.subSiteId, st.scope, null, next, ctx);
      return {
        ok: true,
        scope: st.scope,
        changed: applied,
        published: false,
        message:
          `Se guardaron ${applied.length} cambio(s) en el borrador del ${st.scope === "top" ? "encabezado" : "pie"}. ` +
          `Afecta a TODAS las páginas del sitio cuando se publique.`,
      };
    }

    // ── Descartar borradores ─────────────────────────────────────────────────
    // pms-core borra UN scope por request (page con pageId, top o bottom) y
    // responde 400 sin scope. Expuesto como passthrough, discard_site_draft no
    // funcionó nunca: la red de seguridad que prometen todas las ediciones
    // ("se revierte con discard_site_draft") no revertía nada (test:tools-e2e,
    // 13-09-2026). Acá se descarta cada scope que tenga borrador.
    case "discard_site_draft": {
      const siteId = str(args.siteId, "siteId");
      const subSiteId = str(args.subSiteId, "subSiteId");
      const scopeArg = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim().toLowerCase() : "all";
      if (!["all", "page", "top", "bottom"].includes(scopeArg)) {
        throw new BuilderEditError(`"scope" tiene que ser all, page, top o bottom. Recibido: ${String(args.scope)}.`);
      }
      const pageArg = typeof args.pageId === "string" ? args.pageId.trim() : "";
      if (scopeArg === "page" && !pageArg) {
        throw new BuilderEditError(`Para descartar solo una página falta "pageId".`);
      }
      const subSite = await fetchSubSite(siteId, subSiteId, ctx);
      const allPages: any[] = Array.isArray(subSite?.pages) ? subSite.pages : [];
      const pages = pageArg ? [findPage(subSite, pageArg)] : allPages;
      const draftPath = `/site-data/draft/${encodeURIComponent(subSiteId)}/from/${encodeURIComponent(siteId)}`;
      const discarded: string[] = [];

      if (scopeArg === "all" || scopeArg === "page") {
        for (const p of pages) {
          const pageId = String(p._id);
          const d = await fetchDrafts(siteId, subSiteId, pageId, ctx);
          if (!Array.isArray(d.page)) continue;
          await req("DELETE", draftPath, ctx, { scope: "page", pageId });
          discarded.push(`página "${p?.name ?? pageId}"`);
        }
      }
      const anyPage = pages[0] ?? allPages[0];
      if (anyPage && scopeArg !== "page") {
        const d = await fetchDrafts(siteId, subSiteId, String(anyPage._id), ctx);
        for (const scope of ["top", "bottom"] as const) {
          if (scopeArg !== "all" && scopeArg !== scope) continue;
          if (!Array.isArray(d[scope])) continue;
          await req("DELETE", draftPath, ctx, { scope });
          discarded.push(scope === "top" ? "encabezado" : "pie");
        }
      }
      return {
        ok: true,
        discarded,
        published: false,
        message: discarded.length
          ? `Se descartó el borrador de: ${discarded.join(", ")}. El sitio publicado no cambió.`
          : "No había cambios sin publicar: no se descartó nada.",
      };
    }

    // ── Calidad del sitio ────────────────────────────────────────────────────
    case "check_site_quality": {
      const q = await qualityInput(args, ctx, false);
      const report = await req<any>("POST", qualityPath(q.siteId, q.subSiteId), ctx, q.body);
      return {
        siteId: q.siteId,
        subSiteId: q.subSiteId,
        pageId: q.pageId,
        pageName: q.page?.name ?? null,
        checked: q.pageId
          ? "el borrador de la página (o lo publicado si no hay borrador), más encabezado y pie"
          : "el sitio guardado, todas las páginas",
        ...compactQuality(report),
        hint:
          "autofix_site_quality corrige los problemas con autoFixable: true (pide pageId). El resto va a mano: " +
          "edit_page_content para textos, imágenes y enlaces; update_site_page para título y descripción de una página; update_site_seo_geo para el sitio.",
      };
    }

    case "autofix_site_quality": {
      const q = await qualityInput(args, ctx, true);
      const pageId = q.pageId as string;
      const scopes = q.scopes as Record<DraftScope, any[]>;
      const result = await req<any>("POST", `${qualityPath(q.siteId, q.subSiteId)}/autofix`, ctx, q.body);

      const savedToDraft: DraftScope[] = [];
      for (const scope of ["page", "top", "bottom"] as DraftScope[]) {
        const merged = mergeFixedProps(scopes[scope], result?.scopes?.[scope]);
        if (!merged) continue;
        await saveDraft(q.siteId, q.subSiteId, scope, scope === "page" ? pageId : null, merged, ctx);
        savedToDraft.push(scope);
      }

      // Solo lo que cambia: el autofix devuelve la meta completa de la página.
      const metaSrc = result?.pageMeta && typeof result.pageMeta === "object" ? result.pageMeta : {};
      const pageMeta: Record<string, string> = {};
      for (const key of ["title", "description", "pageSocialPreview"]) {
        const v = metaSrc[key];
        if (typeof v === "string" && v !== (q.page?.[key] ?? "")) pageMeta[key] = v;
      }
      if (Object.keys(pageMeta).length) {
        await req(
          "PUT",
          `/site-data/page/${encodeURIComponent(pageId)}/data/from/${encodeURIComponent(q.subSiteId)}/from/${encodeURIComponent(q.siteId)}`,
          ctx,
          pageMeta,
        );
      }
      const siteDescription =
        typeof result?.siteDescription === "string" && result.siteDescription.trim()
          ? result.siteDescription
          : null;
      if (siteDescription) {
        await req(
          "PUT",
          `/site-data/subsite/${encodeURIComponent(q.subSiteId)}/from/${encodeURIComponent(q.siteId)}/seo-geo`,
          ctx,
          { description: siteDescription },
        );
      }

      const fixed = typeof result?.fixed === "number" ? result.fixed : 0;
      const scopeLabel: Record<DraftScope, string> = { page: "página", top: "encabezado", bottom: "pie" };
      const parts: string[] = [];
      if (savedToDraft.length) {
        parts.push(
          `Las secciones corregidas (${savedToDraft.map((s) => scopeLabel[s]).join(", ")}) quedaron en el BORRADOR: falta publicar con publish_site_changes.`,
        );
      }
      if (Object.keys(pageMeta).length) parts.push(`Se guardó directo en la página: ${Object.keys(pageMeta).join(", ")}.`);
      if (siteDescription) parts.push("Se guardó directo la descripción del sitio.");
      return {
        ok: true,
        fixed,
        savedToDraft,
        pageMetaUpdated: Object.keys(pageMeta),
        siteDescriptionUpdated: Boolean(siteDescription),
        remaining: compactQuality(result?.report),
        published: false,
        message: fixed > 0
          ? `Se corrigieron ${fixed} problema(s). ${parts.join(" ")}`.trim()
          : "No quedan problemas con arreglo automático.",
      };
    }

    default:
      throw new BuilderEditError(`Operación de builder desconocida: ${toolName}`);
  }
}
