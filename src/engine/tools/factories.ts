/**
 * Fábricas: fila del catálogo -> herramienta estructurada (§12.2).
 *
 * Cada tipo de herramienta tiene una fábrica. La fábrica es la que enlaza el
 * esquema de entrada como esquema de argumentos de la llamada del modelo, sanea
 * el nombre al patrón que aceptan los proveedores, decide la clase de
 * concurrencia y adjunta el ejecutor.
 *
 * Regla explícita del documento y respetada acá: los tipos que NO PUEDEN nacer
 * de una fila (`function`, `sub_agent`) fallan de forma explícita si se intenta
 * resolverlos por esta vía. Una `function` vive en el registro de código; un
 * `sub_agent` se cablea desde la lista `subAgents` de la versión, donde se
 * valida la propiedad del agente destino. Dejar que naciera de una fila del
 * catálogo permitiría a cualquiera con permiso de crear herramientas cablear un
 * agente ajeno como sub-agente y ejecutarlo.
 */
import { NotImplementedError, ValidationError } from "../core/errors";
import { getEngineConfig } from "../core/config";
import { createLogger, errField } from "../core/logger";
import type { ConcurrencyMode } from "../models/enums";
import type { EngineToolDoc } from "../models/tool.model";
import { capabilitiesFor } from "../llm/catalog";
import { capToolResult, sanitizeToolName, type JsonSchemaObject, type ResolvedTool } from "./types";

const log = createLogger("engine:tools:factory");

function schemaOf(row: EngineToolDoc): JsonSchemaObject {
  return {
    type: "object",
    properties: (row.inputSchema?.properties ?? {}) as Record<string, unknown>,
    required: row.inputSchema?.required ?? [],
  };
}

/**
 * Clase de concurrencia efectiva. El override explícito manda; si no hay,
 * se infiere de forma CONSERVADORA: ante la duda, algo que puede escribir se
 * serializa. Paralelizar dos escrituras sobre el mismo recurso del PMS produce
 * carreras que aparecen una vez cada mil turnos y son imposibles de reproducir.
 */
export function inferConcurrency(row: {
  concurrency?: ConcurrencyMode | null;
  permissions?: { isDestructive?: boolean };
  type?: string;
}): ConcurrencyMode {
  if (row.concurrency) return row.concurrency;
  if (row.permissions?.isDestructive) return "exclusive";
  if (row.type === "think" || row.type === "search") return "read";
  return "read";
}

type Factory = (row: EngineToolDoc, origin: ResolvedTool["origin"]) => ResolvedTool;

/** `http` — llamada HTTP declarativa con URL, cabeceras y cuerpo por plantilla. */
const httpFactory: Factory = (row, origin) => {
  const cfg = row.config as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyTemplate?: Record<string, unknown>;
    timeoutMs?: number;
  };

  if (!cfg.url) {
    throw new ValidationError(`La herramienta http "${row.name}" no declara "config.url"`);
  }

  const method = (cfg.method ?? "GET").toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  return {
    name: sanitizeToolName(row.name),
    description: row.description,
    inputSchema: schemaOf(row),
    type: "http",
    scope: row.scope,
    origin,
    concurrency: row.concurrency ?? (isRead ? "read" : "write"),
    roleFloor: row.permissions?.roleFloor ?? null,
    requiresConfirmation: row.permissions?.requiresConfirmation ?? false,
    execute: async (args) => {
      const url = renderTemplate(cfg.url!, args);
      // Defensa anti-falsificación de peticiones del lado del servidor (§29):
      // toda URL saliente configurable exige esquema seguro y anfitrión público
      // fuera de desarrollo. Sin esto, una herramienta creada por API puede
      // pedirle al motor que golpee la red interna del clúster.
      assertSafeOutboundUrl(url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15_000);
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json", ...(cfg.headers ?? {}) },
          body: isRead ? undefined : JSON.stringify(renderObject(cfg.bodyTemplate ?? {}, args)),
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* respuesta no-JSON: se devuelve el texto */
        }
        if (!res.ok) {
          return { ok: false, status: res.status, body: parsed };
        }
        return capToolResult(parsed, getEngineConfig().execution.maxToolResultChars);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};

/** `think` — paso de cadena de pensamiento: devuelve su propia entrada. */
const thinkFactory: Factory = (row, origin) => ({
  name: sanitizeToolName(row.name),
  description:
    row.description ||
    "Registra un paso de razonamiento explícito antes de actuar. No tiene efectos.",
  inputSchema: {
    type: "object",
    properties: {
      thought: { type: "string", description: "El razonamiento a registrar." },
    },
    required: ["thought"],
  },
  type: "think",
  scope: row.scope,
  origin,
  concurrency: "read",
  roleFloor: row.permissions?.roleFloor ?? null,
  execute: async (args) => ({ thought: args.thought }),
});

/**
 * `search` — búsqueda web. Se declara al PROVEEDOR, no se ejecuta localmente.
 * La variante correcta depende del modelo: la nueva trae filtrado dinámico y
 * la vieja no, y declarar la nueva contra un modelo que no la soporta es un
 * error de petición.
 */
const searchFactory: Factory = (row, origin) => {
  const cfg = row.config as { maxUses?: number; allowedDomains?: string[]; blockedDomains?: string[] };
  return {
    name: sanitizeToolName(row.name || "web_search"),
    description: row.description || "Busca información actual en la web.",
    inputSchema: { type: "object", properties: {} },
    type: "search",
    scope: row.scope,
    origin,
    concurrency: "read",
    roleFloor: row.permissions?.roleFloor ?? null,
    // El tipo real se resuelve contra el modelo en `bindServerTools`.
    serverTool: {
      __serverToolKind: "web_search",
      name: "web_search",
      ...(cfg.maxUses ? { max_uses: cfg.maxUses } : {}),
      ...(cfg.allowedDomains?.length ? { allowed_domains: cfg.allowedDomains } : {}),
      ...(cfg.blockedDomains?.length ? { blocked_domains: cfg.blockedDomains } : {}),
    },
  };
};

/** `code_execution` — sandbox del proveedor. También se declara, no se ejecuta. */
const codeExecutionFactory: Factory = (row, origin) => ({
  name: sanitizeToolName(row.name || "code_execution"),
  description: row.description || "Ejecuta código en un sandbox para analizar datos o generar archivos.",
  inputSchema: { type: "object", properties: {} },
  type: "code_execution",
  scope: row.scope,
  origin,
  concurrency: "exclusive",
  roleFloor: row.permissions?.roleFloor ?? null,
  serverTool: { __serverToolKind: "code_execution", name: "code_execution" },
});

const FACTORIES: Partial<Record<EngineToolDoc["type"], Factory>> = {
  http: httpFactory,
  think: thinkFactory,
  search: searchFactory,
  code_execution: codeExecutionFactory,
};

export function rowToTool(row: EngineToolDoc, origin: ResolvedTool["origin"]): ResolvedTool {
  // Tipos que no pueden nacer de una fila. Fallar explícito, no devolver null.
  if (row.type === "function") {
    throw new ValidationError(
      `"${row.name}" es de tipo function: vive en el registro de código, no en el catálogo. ` +
        `Registrala con registerCodeTool() al arrancar.`,
    );
  }
  if (row.type === "sub_agent") {
    throw new ValidationError(
      `"${row.name}" es de tipo sub_agent: se cablea desde la lista subAgents de la versión del ` +
        `agente, donde se valida la propiedad del agente destino. Una fila del catálogo saltearía esa validación.`,
    );
  }

  const factory = FACTORIES[row.type];
  if (!factory) {
    throw new NotImplementedError(
      `El tipo de herramienta "${row.type}"`,
      "engine/tools/factories.ts -> FACTORIES (fábrica + esquema de configuración)",
    );
  }

  return factory(row, origin);
}

/**
 * Resuelve las declaraciones de herramientas de servidor contra el modelo que
 * va a correr. Se hace en el último momento, y no al construir la herramienta,
 * porque el modelo puede cambiar por turno (menú por complejidad, modelo
 * alternativo para visión) y la variante correcta depende de él.
 *
 * Además aplica la regla del proveedor: la variante nueva de búsqueda web trae
 * ejecución de código adentro, así que declarar ADEMÁS `code_execution` crea un
 * segundo entorno y confunde al modelo. Se descarta la redundante.
 */
export function bindServerTools(tools: ResolvedTool[], modelName: string): Record<string, unknown>[] {
  const caps = capabilitiesFor(modelName);
  const out: Record<string, unknown>[] = [];

  const hasBundlingWebSearch =
    caps.webToolsBundleCodeExecution &&
    tools.some((t) => t.serverTool?.__serverToolKind === "web_search");

  for (const tool of tools) {
    const kind = tool.serverTool?.__serverToolKind as string | undefined;
    if (!kind) continue;

    if (kind === "web_search") {
      const { __serverToolKind, ...rest } = tool.serverTool!;
      void __serverToolKind;
      out.push({ type: caps.webSearchToolType, ...rest });
      continue;
    }

    if (kind === "web_fetch") {
      if (!caps.webFetchToolType) {
        log.warn("recuperación web omitida: el modelo no la soporta", { model: modelName });
        continue;
      }
      const { __serverToolKind, ...rest } = tool.serverTool!;
      void __serverToolKind;
      out.push({ type: caps.webFetchToolType, ...rest });
      continue;
    }

    if (kind === "code_execution") {
      if (hasBundlingWebSearch) {
        log.debug("ejecución de código omitida: ya viene incluida en la búsqueda web del modelo", {
          model: modelName,
        });
        continue;
      }
      out.push({ type: caps.codeExecutionToolType, name: "code_execution" });
      continue;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Utilidades de plantilla y defensa de salida
// ---------------------------------------------------------------------------

function renderTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = args[key];
    return value === undefined ? match : encodeURIComponent(String(value));
  });
}

function renderObject(
  template: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === "string") {
      const match = /^\{(\w+)\}$/.exec(value);
      // Un placeholder solo preserva el TIPO del argumento (número, booleano,
      // objeto); interpolado dentro de un string lo aplana a texto.
      out[key] = match ? args[match[1]] : renderTemplate(value, args);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = renderObject(value as Record<string, unknown>, args);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.internal|.*\.local)$/i;

function assertSafeOutboundUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`URL saliente inválida: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError(`Esquema no permitido en la URL saliente: ${url.protocol}`);
  }
  if (getEngineConfig().environment === "production") {
    if (url.protocol !== "https:") {
      throw new ValidationError("En producción las URLs salientes deben usar https");
    }
    if (PRIVATE_HOST.test(url.hostname)) {
      throw new ValidationError(
        `Anfitrión no público bloqueado en la URL saliente: ${url.hostname}`,
      );
    }
  }
}

export const __testables = { renderTemplate, renderObject, assertSafeOutboundUrl };
export { errField };
