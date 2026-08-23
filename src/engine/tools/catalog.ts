/**
 * Catálogo UNIFICADO de herramientas disponibles para un agente.
 *
 * El resolutor (`resolver.ts`) contesta "dado este nombre, ¿qué herramienta es?".
 * Este archivo contesta la pregunta inversa, que es la que necesita un humano
 * configurando un agente: "¿qué puedo poner acá?".
 *
 * Sin esto, la única forma de declarar herramientas era escribir los nombres a
 * mano y esperar que el resolutor los encontrara — con 165 herramientas en el
 * catálogo del PMS, eso es adivinar. Un nombre mal tipeado no falla al guardar:
 * falla en runtime, como una negación silenciosa dentro del prompt.
 *
 * Recorre los mismos cuatro niveles que la resolución y en el mismo orden de
 * precedencia, así que lo que se ve acá es exactamente lo que el grafo va a
 * construir.
 */
import { Tool } from "../../modules/tools/tools.model";
import type { ConcurrencyMode } from "../models/enums";
import { EngineTool } from "../models/tool.model";
import { capabilityMap, isPendingCapability, listCodeTools } from "./registry";
import type { RuntimeCapability } from "../models/enums";

export interface CatalogEntry {
  name: string;
  displayName: string;
  description: string;
  /** Nivel de resolución del que salió. */
  source: "registry" | "engine" | "pms";
  category: string;
  concurrency: ConcurrencyMode;
  isDestructive: boolean;
  requiresConfirmation: boolean;
  roleFloor: string | null;
  /** Sólo informativo: a qué microservicio pega (herramientas del PMS). */
  targetService?: string | null;
  method?: string | null;
}

export interface CatalogGroup {
  key: string;
  label: string;
  source: CatalogEntry["source"];
  tools: CatalogEntry[];
}

/** Categorías del PMS -> etiqueta legible y si escriben. */
const PMS_CATEGORY_LABEL: Record<string, string> = {
  reservations_read: "Reservas · lectura",
  reservations_write: "Reservas · escritura",
  rooms_read: "Habitaciones · lectura",
  rooms_write: "Habitaciones · escritura",
  guests_read: "Huéspedes · lectura",
  analytics_read: "Analítica · lectura",
  property_read: "Propiedad · lectura",
  property_write: "Propiedad · escritura",
  marketing_read: "Marketing · lectura",
  marketing_write: "Marketing · escritura",
  settings_read: "Ajustes · lectura",
  settings_write: "Ajustes · escritura",
  revenue_read: "Revenue · lectura",
  revenue_write: "Revenue · escritura",
  raw_read: "Acceso crudo · lectura",
  raw_write: "Acceso crudo · escritura",
  ui_action: "Acciones de interfaz",
};

const WRITE_CATEGORY = /(_write$|^raw_write$)/;

export async function listAvailableTools(opts: {
  tenantId: string | null;
  search?: string;
}): Promise<{ groups: CatalogGroup[]; total: number; capabilityTools: Record<string, string[]> }> {
  const groups: CatalogGroup[] = [];

  // --- Nivel 1: registro de código -------------------------------------
  // Se excluyen las gestionadas por capacidad: NO se pueden pedir por nombre
  // (§35.11). Ofrecerlas en el selector y que después el resolutor las niegue
  // sería una trampa.
  const capabilityManaged = new Set(Object.values(capabilityMap()).flat());
  const codeTools = listCodeTools()
    .filter((t) => !capabilityManaged.has(t.name))
    .map<CatalogEntry>((t) => ({
      name: t.name,
      displayName: t.name,
      description: t.description,
      source: "registry",
      category: "Del motor",
      concurrency: t.concurrency,
      isDestructive: false,
      requiresConfirmation: false,
      roleFloor: t.roleFloor ?? null,
    }));

  if (codeTools.length > 0) {
    groups.push({
      key: "registry",
      label: "Herramientas del motor",
      source: "registry",
      tools: codeTools,
    });
  }

  // --- Niveles 2 y 3: catálogo del motor --------------------------------
  const engineRows = await EngineTool.find({
    status: "active",
    deletedAt: null,
    $or: [{ tenantId: opts.tenantId }, { tenantId: null }],
  }).lean();

  if (engineRows.length > 0) {
    groups.push({
      key: "engine",
      label: "Catálogo del motor",
      source: "engine",
      tools: engineRows.map<CatalogEntry>((r) => ({
        name: String(r.name),
        displayName: String(r.displayName || r.name),
        description: String(r.description ?? ""),
        source: "engine",
        category: r.tenantId ? "Del inquilino" : "Global",
        concurrency:
          (r.concurrency as ConcurrencyMode) ??
          (r.permissions?.isDestructive ? "exclusive" : "read"),
        isDestructive: Boolean(r.permissions?.isDestructive),
        requiresConfirmation: Boolean(r.permissions?.requiresConfirmation),
        roleFloor: r.permissions?.roleFloor ?? null,
      })),
    });
  }

  // --- Nivel 4: catálogo del PMS ----------------------------------------
  const pmsRows = await Tool.find({ status: "active" })
    .select({
      name: 1,
      displayName: 1,
      description: 1,
      category: 1,
      permissions: 1,
      "execution.targetService": 1,
      "execution.method": 1,
    })
    .lean();

  const byCategory = new Map<string, CatalogEntry[]>();
  for (const r of pmsRows) {
    const category = String(r.category ?? "otros");
    const destructive = Boolean(r.permissions?.isDestructive);
    const entry: CatalogEntry = {
      name: String(r.name),
      displayName: String(r.displayName || r.name),
      description: String(r.description ?? ""),
      source: "pms",
      category,
      // Misma inferencia que hace el puente en runtime, para que lo que se ve
      // acá coincida con cómo se va a ejecutar.
      concurrency: destructive ? "exclusive" : WRITE_CATEGORY.test(category) ? "write" : "read",
      isDestructive: destructive,
      requiresConfirmation: Boolean(r.permissions?.requiresConfirmation),
      roleFloor: null,
      targetService: r.execution?.targetService ?? null,
      method: r.execution?.method ?? null,
    };
    const list = byCategory.get(category) ?? [];
    list.push(entry);
    byCategory.set(category, list);
  }

  for (const [category, tools] of [...byCategory.entries()].sort()) {
    groups.push({
      key: `pms:${category}`,
      label: PMS_CATEGORY_LABEL[category] ?? category,
      source: "pms",
      tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  // --- Filtro de búsqueda ------------------------------------------------
  const term = opts.search?.trim().toLowerCase();
  const filtered = term
    ? groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter(
            (t) =>
              t.name.toLowerCase().includes(term) ||
              t.displayName.toLowerCase().includes(term) ||
              t.description.toLowerCase().includes(term),
          ),
        }))
        .filter((g) => g.tools.length > 0)
    : groups;

  return {
    groups: filtered,
    total: filtered.reduce((a, g) => a + g.tools.length, 0),
    // Las de capacidad se publican aparte, para que la UI pueda explicar que
    // llegan por el interruptor y no por el selector.
    capabilityTools: Object.fromEntries(
      Object.entries(capabilityMap())
        .filter(([cap]) => !isPendingCapability(cap as RuntimeCapability))
        .map(([cap, names]) => [cap, [...names]]),
    ),
  };
}
