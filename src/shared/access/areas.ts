/**
 * Areas del panel interno para los permisos por usuario.
 *
 * Un area = una seccion del menu del panel (web/src/components/layout/
 * navigation.ts) + los prefijos de la API que la sirven. El rol sigue siendo
 * el techo (`authorize(minRole)` en cada ruta); el nivel por area solo RESTA:
 *
 *   none  → la API responde 403 a todo lo del area y el menu la esconde.
 *   read  → solo GET/HEAD/OPTIONS; cualquier escritura es 403.
 *   write → lo que el rol permita (default si el area no esta en el mapa).
 *
 * ESPEJO: web/src/lib/areas.ts tiene la misma lista de claves y nombres. Si
 * agregas un area o un prefijo de API nuevo, toca los dos. Un prefijo que no
 * cae en ningun area queda sin restriccion por area (solo rol), asi que un
 * modulo nuevo de la API tiene que sumarse aca.
 */

export const AREA_LEVELS = ["none", "read", "write"] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

export const AREAS = [
  { key: "usage", label: "Consumo IA", prefixes: ["/usage"] },
  { key: "metrics", label: "Metricas", prefixes: ["/metrics", "/analytics"] },
  // Modulo Usabilidad (USABILIDAD-SPEC.md): mapas, trabas, recorridos y analisis de la IA.
  { key: "usability", label: "Usabilidad", prefixes: ["/usability"] },
  { key: "engine", label: "Motor", prefixes: ["/engine"] },
  {
    key: "ia",
    label: "IA",
    prefixes: ["/agents", "/tools", "/knowledge", "/conversations", "/memory", "/growth", "/tourism"],
  },
  // Asistencia 24/7: el chat en vivo con los usuarios del PMS. Las rutas
  // /support-chat/runtime/* las llama el PMS con el secret y no pasan por acá.
  { key: "support", label: "Soporte", prefixes: ["/support-chat"] },
  { key: "feedback", label: "Feedback", prefixes: ["/feedback", "/tickets"] },
  { key: "platform", label: "Plataforma", prefixes: ["/hotels", "/access", "/plans"] },
  { key: "leads", label: "Leads", prefixes: ["/leads"] },
  { key: "prospects", label: "Prospeccion", prefixes: ["/prospects"] },
  {
    key: "marketing",
    label: "Marketing",
    prefixes: ["/crm", "/campaigns", "/mkt", "/reputation", "/loyalty"],
  },
  { key: "competitors", label: "Competencia", prefixes: ["/competitors"] },
  { key: "intelligence", label: "Inteligencia", prefixes: ["/intelligence"] },
  // "/users" es el padron interno: sin area, un admin en solo lectura igual podia
  // crear o editar usuarios.
  { key: "system", label: "Sistema", prefixes: ["/infra", "/architecture", "/system", "/users"] },
  // Academia interna (ROOMBIR-ACADEMY-SPEC.md): induccion del equipo propio.
  { key: "academy", label: "Academia", prefixes: ["/academy"] },
] as const;

export type AreaKey = (typeof AREAS)[number]["key"];
export const AREA_KEYS = AREAS.map((a) => a.key) as AreaKey[];

export type AreaAccess = Partial<Record<AreaKey, AreaLevel>>;

const API_BASE = "/api/v1";

/**
 * Lecturas compartidas que se permiten aunque el area este en `none`: el
 * selector de compañia de los tableros lee /hotels, y sin esto un analista de
 * Metricas sin acceso a Plataforma veria los filtros rotos. Solo GET y solo
 * el listado, nunca el detalle.
 */
const SHARED_READS = [`${API_BASE}/hotels`];

/** Area a la que pertenece una URL de la API, o null si no cae en ninguna. */
export function areaForPath(url: string): AreaKey | null {
  const path = url.split("?")[0];
  if (!path.startsWith(`${API_BASE}/`)) return null;
  const rest = path.slice(API_BASE.length);
  for (const area of AREAS) {
    for (const p of area.prefixes) {
      if (rest === p || rest.startsWith(`${p}/`)) return area.key;
    }
  }
  return null;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type AreaDecision =
  | { ok: true }
  | { ok: false; code: "area_forbidden" | "area_read_only"; area: AreaKey; message: string };

export function checkArea(
  access: AreaAccess | undefined,
  method: string,
  url: string,
): AreaDecision {
  const area = areaForPath(url);
  if (!area || !access) return { ok: true };
  const level = access[area] ?? "write";
  const label = AREAS.find((a) => a.key === area)!.label;
  const isRead = READ_METHODS.has(method.toUpperCase());
  if (level === "none") {
    if (isRead && SHARED_READS.includes(url.split("?")[0])) return { ok: true };
    return { ok: false, code: "area_forbidden", area, message: `No tenes acceso a ${label}` };
  }
  if (level === "read" && !isRead) {
    return {
      ok: false,
      code: "area_read_only",
      area,
      message: `Tu acceso a ${label} es de solo lectura`,
    };
  }
  return { ok: true };
}

/** Deja solo claves y niveles validos (lo que venga de la DB o del body). */
export function cleanAreaAccess(raw: unknown): AreaAccess {
  const out: AreaAccess = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of AREA_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string" && (AREA_LEVELS as readonly string[]).includes(v) && v !== "write") {
      out[key] = v as AreaLevel;
    }
  }
  return out;
}
