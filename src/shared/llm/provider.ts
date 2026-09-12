/**
 * Punto unico donde el internal decide QUE modelo usa y CONTRA QUE proveedor
 * habla, para todo lo que vive FUERA del motor agentico: el chat de Roombir IA,
 * la memoria, el triage de tickets y la inteligencia competitiva.
 *
 * (El motor tiene su propio enrutado en `engine/llm/client.ts`, que ya sabia
 * hablar con OpenRouter; lo unico que le cambio son los ids por defecto de los
 * agentes. Ver `engineModelFor` mas abajo para la forma cualificada que espera.)
 *
 * Todo el consumo paso de la API de Anthropic a OpenRouter. El protocolo no
 * cambio: OpenRouter expone en `/api/v1/messages` el mismo formato Messages de
 * Anthropic -- system aparte, content blocks, tool_use/tool_result, SSE tipado,
 * e incluso la server tool `web_search` -- para TODO su catalogo, no solo para
 * los modelos de Anthropic. Por eso el SDK sigue sirviendo tal cual: solo se le
 * cambian la URL base, la key y el id del modelo.
 *
 * Los tres tiers y sus precios (USD por millon de tokens, entrada/salida), del
 * catalogo de OpenRouter medido el 2026-09-10:
 *
 *   cheap     deepseek/deepseek-v4-flash-0731   0.065 / 0.18   sin vision
 *   standard  z-ai/glm-5.3-flash                0.075 / 0.25   con vision
 *   premium   google/gemini-3.8-flash           0.75  / 3.75   con vision
 *
 * Contra lo que se dejo atras: claude-haiku-4-5 costaba 1 / 5, claude-sonnet-4-6
 * 3 / 15 y claude-opus-4-8 5 / 25. El tier `standard` puntua 51.2 en el indice
 * agentico de Artificial Analysis contra 33.1 de Sonnet 4.6 y 42.6 de Opus 4.8,
 * asi que el reemplazo mejora la capacidad de orquestar herramientas al mismo
 * tiempo que divide el costo por cuarenta. No es una concesion para ahorrar.
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * Base del SDK: el cliente de Anthropic le agrega `/v1/messages`, asi que aca
 * va SIN el `/v1`. El env `OPENROUTER_BASE_URL` suele venir con el `/v1` puesto
 * porque el ramal del motor lo necesita asi; se recorta para que no termine en
 * un `/v1/v1/` que devuelve el HTML del sitio en vez de JSON.
 */
export const OPENROUTER_SDK_BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api"
)
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "");

/** Tiers de costo/capacidad. El valor es el id desnudo que pide OpenRouter. */
export const LLM_MODELS = {
  /**
   * Clasificar, enrutar, extraer memoria, detectar menciones. Tareas cortas de
   * texto con salida chica. NO acepta imagenes: no mandarle nada que las lleve.
   */
  cheap: process.env.LLM_MODEL_CHEAP ?? "deepseek/deepseek-v4-flash-0731",
  /**
   * El caballo de batalla: el chat operativo con todas las herramientas, el
   * triage de tickets, el radar y la evidencia de inteligencia competitiva.
   * Acepta imagenes, herramientas y 1.3M de contexto.
   */
  standard: process.env.LLM_MODEL_STANDARD ?? "z-ai/glm-5.3-flash",
  /**
   * El tier de analisis, y el escalon de reintento cuando el standard no cierra.
   * Familia distinta a proposito: un fallback que falla por lo mismo que el
   * primario no es un fallback. Diez veces mas caro, asi que va solo donde el
   * razonamiento largo se paga solo.
   */
  premium: process.env.LLM_MODEL_PREMIUM ?? "google/gemini-3.8-flash",
} as const;

export type LlmTier = keyof typeof LLM_MODELS;

const TIERS = Object.keys(LLM_MODELS) as LlmTier[];

/** Id desnudo, que es lo que espera el ramal Messages de OpenRouter. */
export function modelFor(tier: LlmTier): string {
  return LLM_MODELS[tier].trim();
}

/**
 * Id CUALIFICADO para el motor agentico, que guarda los modelos como
 * `proveedor/modelo` y resuelve el cliente por ese prefijo. Un id de OpenRouter
 * ya trae adentro su proveedor de origen, asi que el resultado tiene tres
 * tramos: `openrouter/z-ai/glm-5.3-flash`.
 */
export function engineModelFor(tier: LlmTier): string {
  return `openrouter/${modelFor(tier)}`;
}

/** A que tier pertenece un id (con o sin el prefijo `openrouter/`). */
export function tierOf(model: string): LlmTier | null {
  const bare = (model || "").trim().replace(/^openrouter\//, "");
  return TIERS.find((t) => LLM_MODELS[t].trim() === bare) ?? null;
}

/**
 * Rango de capacidad. Lo usa el piso operativo del chat: un modelo del tier
 * barato no orquesta escrituras de forma confiable y hay que elevarlo.
 *
 * Un modelo que no esta en ningun tier se trata como capaz (rango alto) para no
 * degradar uno que el operador eligio a proposito desde la UI.
 */
export function modelRank(model: string): number {
  switch (tierOf(model)) {
    case "cheap":
      return 1;
    case "standard":
      return 2;
    case "premium":
      return 3;
    default:
      return 99;
  }
}

/**
 * Los modelos de razonamiento no se apagan todos igual, y equivocarse es un 400
 * que tumba el turno entero. Medido contra OpenRouter el 2026-09-10:
 *
 *   deepseek-v4-flash  `thinking:{type:"disabled"}` -> OK, cero tokens pensados
 *   glm-5.3-flash      `thinking:{type:"disabled"}` -> 400 "Reasoning is mandatory"
 *   gemini-3.8-flash   idem 400
 *
 * Para los que no se pueden apagar se omite el campo y piensan lo minimo que
 * quieran, que es mucho mejor que un 400 por pedirles algo que no pueden dar.
 */
export function canDisableThinking(model: string): boolean {
  return /^(openrouter\/)?deepseek\//.test((model || "").trim());
}

export function thinkingBlockFor(
  model: string,
  opts: { enabled: boolean; budgetTokens?: number },
): { type: "enabled"; budget_tokens: number } | { type: "disabled" } | undefined {
  if (opts.enabled) {
    return { type: "enabled", budget_tokens: Math.max(1024, opts.budgetTokens ?? 4096) };
  }
  return canDisableThinking(model) ? { type: "disabled" } : undefined;
}

/**
 * Presupuesto de salida minimo cuando el razonamiento no se puede apagar: esos
 * modelos gastan tokens pensando ANTES de emitir nada, y con un `max_tokens`
 * justo la respuesta nunca llega -- el turno vuelve sin bloque de texto y sin
 * error, que es la falla mas cara de diagnosticar.
 */
export const MIN_TOKENS_FOR_REASONING = 512;

export function withReasoningHeadroom(model: string, maxTokens: number): number {
  return canDisableThinking(model) ? maxTokens : Math.max(maxTokens, MIN_TOKENS_FOR_REASONING);
}

/**
 * Que server tools sobreviven el pasaje por OpenRouter.
 *
 * Las server tools de Anthropic corren del lado del proveedor, no nuestro, asi
 * que no basta con que el modelo "sepa" usarlas: tiene que haber alguien del
 * otro lado que las ejecute. Medido el 2026-09-10 contra los tres tiers:
 *
 *   web_search      SI en los tres, en las dos variantes (20250305 y 20260209).
 *                   Se cobra aparte de los tokens, ~0.0073 USD por llamada, que
 *                   con estos modelos es MAS que el turno entero: la busqueda
 *                   web pasa a ser el costo dominante, no el modelo.
 *   code_execution  NO en ninguno: OpenRouter contesta 400 "Invalid Anthropic
 *                   Messages API request". Mandarla tumba el turno completo,
 *                   no se degrada sola.
 *
 * Por eso el corte va aca y no por el nombre del modelo: el gate anterior
 * miraba si el id decia "haiku", y con un catalogo de varios proveedores esa
 * subcadena no existe nunca -- habria dejado pasar code_execution a todos.
 */
export function serverToolSupport(_model: string): {
  webSearch: boolean;
  codeExecution: boolean;
} {
  return {
    webSearch: true,
    // Override de escape por si OpenRouter lo habilita mas adelante: asi se
    // prueba sin tocar codigo.
    codeExecution: process.env.LLM_CODE_EXECUTION === "on",
  };
}

/**
 * Cabeceras de atribucion de OpenRouter: alimentan su ranking publico y son lo
 * unico que permite correlacionar de su lado un problema de tasa o facturacion.
 */
export function attributionHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://internal.roombir.com",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "internal-roombir",
  };
}

// Cliente compartido por todo el runtime fuera del motor. Cacheado: una sola
// instancia por proceso.
let cachedClient: Anthropic | null = null;

export function getLlmClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const key = process.env.OPENROUTER_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY no esta configurada");
  cachedClient = new Anthropic({
    apiKey: key.trim(),
    baseURL: OPENROUTER_SDK_BASE_URL,
    defaultHeaders: attributionHeaders(),
  });
  return cachedClient;
}

/** Solo para pruebas. */
export function resetLlmClient(): void {
  cachedClient = null;
}
