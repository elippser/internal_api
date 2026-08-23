/**
 * Catálogo de modelos (§11.3).
 *
 * Publica, por modelo: ventana de contexto, tope de salida, soporte de visión,
 * qué modos de pensamiento acepta, qué niveles de esfuerzo, qué variante de las
 * herramientas de servidor usar y el mínimo cacheable del prefijo.
 *
 * Existe porque estos hechos fallan TARDE y de forma OPACA si se equivocan:
 *   - Mandar `budget_tokens` a un modelo que ya no lo acepta es un 400 a mitad
 *     de una corrida de producción, no un error de configuración al guardar.
 *   - Mandar `temperature` a la familia que la removió es otro 400.
 *   - Declarar la variante vieja de búsqueda web contra un modelo nuevo
 *     desactiva el filtrado dinámico sin avisar.
 *   - Un prefijo por debajo del mínimo cacheable NO cachea y no hay error:
 *     simplemente `cache_read_input_tokens` viene en cero para siempre.
 *
 * Es una tabla estática con reserva por familia. Deliberado: un catálogo
 * remoto agrega un modo de falla (arranque degradado si el proveedor no
 * responde) a cambio de frescura que sólo importa el día que sale un modelo.
 * `capabilitiesFor` nunca lanza: un modelo desconocido cae a un perfil
 * conservador y la corrida sigue.
 */

import { openRouterCatalog, openRouterModel } from "./providers/openrouterCatalog";

export type ThinkingMode = "adaptive" | "budget" | "none";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCapabilities {
  /** Id canónico tal como lo espera el proveedor. */
  id: string;
  label: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  vision: boolean;

  /** Modos de pensamiento aceptados. El primero es el preferido. */
  thinkingModes: ThinkingMode[];
  /**
   * Pensar es el comportamiento por defecto si se OMITE el parámetro. Cambia
   * el dimensionamiento de `maxTokens`: si piensa por defecto, el tope cubre
   * pensamiento + respuesta y una configuración ajustada trunca.
   */
  thinksByDefault: boolean;
  /** `thinking: {type:"disabled"}` es aceptado. Fable 5 lo rechaza con 400. */
  supportsDisabledThinking: boolean;
  /**
   * Esfuerzo máximo con el que se puede combinar el pensamiento deshabilitado.
   * En Opus 5 deshabilitar por encima de `high` es un 400.
   */
  maxEffortWithThinkingDisabled?: EffortLevel | null;

  effortLevels: EffortLevel[];
  /** `temperature`/`top_p`/`top_k` aceptados. La familia nueva los rechaza. */
  supportsSampling: boolean;
  /** El prefill del último turno del asistente devuelve 400 en toda la familia 4.6+. */
  supportsAssistantPrefill: boolean;

  /** Variante de las herramientas de servidor que acepta este modelo. */
  webSearchToolType: string;
  webFetchToolType: string | null;
  codeExecutionToolType: string;
  /**
   * La variante nueva de búsqueda/recuperación web trae filtrado dinámico, que
   * corre ejecución de código por debajo. Declarar ADEMÁS `code_execution`
   * crea un segundo entorno de ejecución y confunde al modelo.
   */
  webToolsBundleCodeExecution: boolean;

  /** Prefijo mínimo para que el caché de prompt tenga efecto. */
  cacheMinimumTokens: number;
}

const OPUS_5: ModelCapabilities = {
  id: "claude-opus-5",
  label: "Claude Opus 5",
  provider: "anthropic",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 128_000,
  vision: true,
  thinkingModes: ["adaptive", "none"],
  thinksByDefault: true,
  supportsDisabledThinking: true,
  maxEffortWithThinkingDisabled: "high",
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  supportsSampling: false,
  supportsAssistantPrefill: false,
  webSearchToolType: "web_search_20260209",
  webFetchToolType: "web_fetch_20260209",
  codeExecutionToolType: "code_execution_20260521",
  webToolsBundleCodeExecution: true,
  cacheMinimumTokens: 512,
};

const CATALOG: Record<string, ModelCapabilities> = {
  "claude-opus-5": OPUS_5,

  "claude-fable-5": {
    ...OPUS_5,
    id: "claude-fable-5",
    label: "Claude Fable 5",
    // El pensamiento está SIEMPRE encendido: cualquier configuración explícita
    // distinta de adaptativo devuelve 400. Se omite el parámetro y listo.
    thinkingModes: ["adaptive"],
    supportsDisabledThinking: false,
    maxEffortWithThinkingDisabled: null,
  },

  "claude-opus-4-8": {
    ...OPUS_5,
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    // Omitir `thinking` acá significa NO pensar (a diferencia de Opus 5).
    thinksByDefault: false,
    maxEffortWithThinkingDisabled: "max",
    cacheMinimumTokens: 1024,
  },

  "claude-opus-4-7": {
    ...OPUS_5,
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    thinksByDefault: false,
    maxEffortWithThinkingDisabled: "max",
    cacheMinimumTokens: 2048,
  },

  "claude-opus-4-6": {
    ...OPUS_5,
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    thinksByDefault: false,
    maxEffortWithThinkingDisabled: "max",
    // Última familia que todavía acepta el presupuesto fijo y el muestreo.
    thinkingModes: ["adaptive", "budget", "none"],
    supportsSampling: true,
    effortLevels: ["low", "medium", "high", "max"],
    cacheMinimumTokens: 4096,
  },

  "claude-sonnet-5": {
    ...OPUS_5,
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    maxEffortWithThinkingDisabled: "max",
    cacheMinimumTokens: 1024,
  },

  "claude-sonnet-4-6": {
    ...OPUS_5,
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    thinksByDefault: false,
    maxEffortWithThinkingDisabled: "max",
    thinkingModes: ["adaptive", "budget", "none"],
    supportsSampling: true,
    effortLevels: ["low", "medium", "high", "max"],
    cacheMinimumTokens: 1024,
  },

  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    // Sólo el modo heredado con presupuesto explícito.
    thinkingModes: ["budget", "none"],
    thinksByDefault: false,
    supportsDisabledThinking: true,
    maxEffortWithThinkingDisabled: null,
    // El esfuerzo es un error acá, no un no-op: se omite siempre.
    effortLevels: [],
    supportsSampling: true,
    supportsAssistantPrefill: true,
    webSearchToolType: "web_search_20250305",
    webFetchToolType: null,
    codeExecutionToolType: "code_execution_20260120",
    webToolsBundleCodeExecution: false,
    cacheMinimumTokens: 4096,
  },
};

/** Alias que resuelven al mismo perfil (ids con sufijo de fecha, renombres). */
const ALIASES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "claude-mythos-5": "claude-fable-5",
};

/**
 * Perfil conservador para un modelo desconocido. Asume la forma NUEVA de la
 * API a propósito: si aparece un modelo que no conocemos, casi seguro es más
 * nuevo que el último que sí, y mandarle `temperature` sería un 400 seguro.
 * Prefiero perder una capacidad opcional a romper la corrida.
 */
const CONSERVATIVE_FALLBACK: Omit<ModelCapabilities, "id" | "label"> = {
  provider: "anthropic",
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  vision: true,
  thinkingModes: ["adaptive", "none"],
  thinksByDefault: false,
  supportsDisabledThinking: true,
  maxEffortWithThinkingDisabled: "high",
  effortLevels: ["low", "medium", "high"],
  supportsSampling: false,
  supportsAssistantPrefill: false,
  webSearchToolType: "web_search_20250305",
  webFetchToolType: null,
  codeExecutionToolType: "code_execution_20260120",
  webToolsBundleCodeExecution: false,
  cacheMinimumTokens: 4096,
};

const warned = new Set<string>();

/** Quita el prefijo de proveedor: `anthropic/claude-opus-5` -> `claude-opus-5`. */
export function stripProvider(qualified: string): string {
  const idx = qualified.indexOf("/");
  return idx === -1 ? qualified : qualified.slice(idx + 1);
}

/** Proveedor declarado, o `anthropic` cuando el nombre viene sin cualificar. */
export function providerOf(qualified: string): string {
  const idx = qualified.indexOf("/");
  return idx === -1 ? "anthropic" : qualified.slice(0, idx);
}

/**
 * Perfil de un modelo del gateway agregador, derivado de su catálogo dinámico.
 *
 * Los modelos de OpenRouter hablan el protocolo mayoritario: NO aceptan
 * pensamiento adaptativo ni `output_config`, y SÍ aceptan muestreo. Devolver el
 * perfil de Anthropic para ellos produciría 400 en cada turno.
 */
function openRouterCapabilities(bareId: string): ModelCapabilities | null {
  const model = openRouterModel(bareId);
  if (!model) return null;

  return {
    id: bareId,
    label: model.name,
    provider: "openrouter",
    contextWindowTokens: model.contextLength,
    maxOutputTokens: model.maxOutputTokens ?? Math.min(16_384, model.contextLength),
    vision: model.vision,
    // El razonamiento del protocolo mayoritario se pide con su propio
    // parámetro, no con `thinking`: se declara "none" y el ramal de OpenRouter
    // traduce el esfuerzo por su cuenta.
    thinkingModes: ["none"],
    thinksByDefault: false,
    supportsDisabledThinking: false,
    maxEffortWithThinkingDisabled: null,
    // El esfuerzo se declara sólo si el modelo lo acepta; el traductor lo
    // convierte y el cliente decide si mandarlo.
    effortLevels: model.reasoning ? ["low", "medium", "high"] : [],
    supportsSampling: true,
    supportsAssistantPrefill: false,
    // Las herramientas de servidor de Anthropic no existen del otro lado.
    webSearchToolType: "",
    webFetchToolType: null,
    codeExecutionToolType: "",
    webToolsBundleCodeExecution: false,
    // El caché de prefijo no es uniforme entre proveedores del gateway.
    cacheMinimumTokens: Number.MAX_SAFE_INTEGER,
  };
}

/** NUNCA lanza. Un modelo desconocido devuelve el perfil conservador. */
export function capabilitiesFor(modelName: string): ModelCapabilities {
  const bare = stripProvider(modelName);

  // Ramal del gateway agregador: se consulta su catálogo dinámico antes que la
  // tabla estática, porque un id como `openrouter/anthropic/claude-opus-5`
  // desnuda a `anthropic/claude-opus-5`, que NO es el id de primera parte.
  if (providerOf(modelName) === "openrouter") {
    const fromGateway = openRouterCapabilities(bare);
    if (fromGateway) return fromGateway;
    // Catálogo todavía frío: perfil conservador del protocolo mayoritario.
    return {
      ...CONSERVATIVE_FALLBACK,
      id: bare,
      label: bare,
      provider: "openrouter",
      thinkingModes: ["none"],
      supportsSampling: true,
      effortLevels: [],
      cacheMinimumTokens: Number.MAX_SAFE_INTEGER,
    };
  }

  const resolved = ALIASES[bare] ?? bare;
  const hit = CATALOG[resolved];
  if (hit) return hit;

  if (!warned.has(bare)) {
    warned.add(bare);
    console.warn(
      `[engine:catalog] modelo sin perfil: "${bare}" — uso el perfil conservador. ` +
        `Agregalo en engine/llm/catalog.ts para habilitar esfuerzo, visión y las variantes nuevas de tools.`,
    );
  }
  return { ...CONSERVATIVE_FALLBACK, id: bare, label: bare };
}

/**
 * Catálogo completo para el selector de la consola: los de primera parte más
 * los del gateway agregador, ya cualificados con su prefijo de proveedor.
 *
 * Se filtran los del gateway que NO aceptan herramientas. Un agente del motor
 * sin herramientas es un caso válido, pero elegir un modelo sin saber que las
 * ignora y descubrirlo cuando el agente no ejecuta nada es el peor modo de
 * falla: no hay error, sólo un agente que "no hace caso".
 */
export function listCatalog(): ModelCapabilities[] {
  const firstParty = Object.values(CATALOG);

  const gateway = openRouterCatalog()
    .filter((m) => m.tools)
    .map((m) => openRouterCapabilities(m.id))
    .filter((c): c is ModelCapabilities => c !== null);

  return [...firstParty, ...gateway];
}

/** Nombre cualificado tal como se guarda en la versión del agente. */
export function qualifiedName(caps: ModelCapabilities): string {
  return `${caps.provider}/${caps.id}`;
}

export function supportsEffort(caps: ModelCapabilities, level: string): boolean {
  return caps.effortLevels.includes(level as EffortLevel);
}

/** Acota un nivel de esfuerzo al máximo que el modelo soporta. */
export function clampEffort(caps: ModelCapabilities, level: EffortLevel): EffortLevel | null {
  if (caps.effortLevels.length === 0) return null;
  if (caps.effortLevels.includes(level)) return level;
  const order: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const wanted = order.indexOf(level);
  for (let i = wanted; i >= 0; i--) {
    const candidate = order[i];
    if (caps.effortLevels.includes(candidate)) return candidate;
  }
  return caps.effortLevels[0];
}
