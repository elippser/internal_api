/**
 * Controles de razonamiento: parámetros planos -> forma específica del modelo (§11.4).
 *
 * El autor del agente guarda TRES perillas planas y estables en `modelParams`
 * (`reasoningEffort`, `thinkingEnabled` + `thinkingBudgetTokens`,
 * `reasoningSummary`) y este módulo las traduce a lo que acepta el modelo con
 * el que se está corriendo hoy.
 *
 * La traducción incluye MIGRACIÓN CRUZADA, y ese es el punto entero del
 * archivo. Un agente guardado hace seis meses con un presupuesto fijo de
 * pensamiento, ejecutado hoy contra un modelo que sólo acepta el modo
 * adaptativo, se promueve solo; y al revés, un esfuerzo declarado contra un
 * modelo que sólo entiende presupuesto se convierte a tokens. Sin esto, cambiar
 * el modelo de un agente viejo es un 400 en producción, y el autor no tiene
 * forma de saber por qué: la perilla que tocó no es la que falla.
 *
 * Dos trampas del proveedor que este módulo también cubre:
 *   - Los modelos adaptativos OMITEN el texto del pensamiento por defecto. Si
 *     la interfaz lo muestra, hay que pedir la visualización resumida
 *     explícitamente o el usuario ve una pausa larga y ningún texto.
 *   - `temperature`/`top_p`/`top_k` fueron REMOVIDOS de la familia nueva: no se
 *     ignoran, devuelven 400. Se filtran acá y no en cada sitio de llamada.
 */
import { capabilitiesFor, clampEffort, type EffortLevel, type ModelCapabilities } from "./catalog";

/** Perillas planas tal como las guarda la versión del agente. */
export interface FlatReasoningParams {
  reasoningEffort?: EffortLevel | string | null;
  /** Modo heredado: encender pensamiento con presupuesto fijo. */
  thinkingEnabled?: boolean | null;
  thinkingBudgetTokens?: number | null;
  /** true / "summarized" muestra el resumen del razonamiento. */
  reasoningSummary?: boolean | string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  maxTokens?: number | null;
  [key: string]: unknown;
}

/** Parámetros de alambre listos para mezclar en el cuerpo de la petición. */
export interface WireReasoningParams {
  max_tokens: number;
  thinking?: { type: "adaptive" | "enabled" | "disabled"; budget_tokens?: number; display?: string };
  output_config?: { effort?: EffortLevel };
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface TranslationResult {
  params: WireReasoningParams;
  /**
   * Ajustes aplicados, para dejarlos en el paso y que el autor entienda por qué
   * su agente corrió distinto de lo que declaró. Una migración silenciosa es
   * casi tan mala como un 400.
   */
  adjustments: string[];
}

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Presupuesto equivalente a un nivel de esfuerzo, para modelos sólo-heredados. */
const EFFORT_TO_BUDGET: Record<EffortLevel, number> = {
  low: 2_048,
  medium: 6_144,
  high: 16_384,
  xhigh: 32_768,
  max: 49_152,
};

/** Nivel de esfuerzo equivalente a un presupuesto, para promover a adaptativo. */
function budgetToEffort(budget: number): EffortLevel {
  if (budget < 4_000) return "low";
  if (budget < 10_000) return "medium";
  if (budget < 24_000) return "high";
  if (budget < 40_000) return "xhigh";
  return "max";
}

function normalizeEffort(value: unknown): EffortLevel | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase().replace(/[\s_-]/g, "");
  const canonical = v === "xhigh" ? "xhigh" : v;
  return (EFFORT_ORDER as string[]).includes(canonical) ? (canonical as EffortLevel) : null;
}

function wantsSummary(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.toLowerCase() === "summarized";
  return false;
}

/**
 * Traduce las perillas planas a la forma del modelo. NUNCA lanza: cualquier
 * combinación imposible se degrada con una nota en `adjustments`. Un agente mal
 * configurado debe correr peor, no morir.
 */
export function translateReasoning(
  modelName: string,
  flat: FlatReasoningParams,
  opts: { defaultMaxTokens?: number } = {},
): TranslationResult {
  const caps: ModelCapabilities = capabilitiesFor(modelName);
  const adjustments: string[] = [];

  // --- Tope de salida ---------------------------------------------------
  const requestedMax = Number(flat.maxTokens ?? opts.defaultMaxTokens ?? 8_192);
  let maxTokens = Math.max(256, Math.min(requestedMax, caps.maxOutputTokens));
  if (maxTokens !== requestedMax) {
    adjustments.push(
      `maxTokens acotado de ${requestedMax} a ${maxTokens} (tope del modelo: ${caps.maxOutputTokens})`,
    );
  }

  const params: WireReasoningParams = { max_tokens: maxTokens };

  // --- ¿Se quiere pensamiento? -----------------------------------------
  const declaredBudget =
    typeof flat.thinkingBudgetTokens === "number" && flat.thinkingBudgetTokens > 0
      ? flat.thinkingBudgetTokens
      : null;
  const declaredEffort = normalizeEffort(flat.reasoningEffort);

  let wantThinking: boolean;
  if (flat.thinkingEnabled === false) {
    wantThinking = false;
  } else if (flat.thinkingEnabled === true || declaredBudget !== null || declaredEffort !== null) {
    wantThinking = true;
  } else {
    // Sin declaración: adaptativo es la recomendación vigente del proveedor
    // para toda la familia moderna. En los modelos sólo-heredados no se enciende
    // solo, porque ahí exige un presupuesto que el autor no eligió.
    wantThinking = caps.thinkingModes[0] === "adaptive";
  }

  const preferredMode = caps.thinkingModes[0];

  if (!wantThinking) {
    if (!caps.supportsDisabledThinking) {
      // Fable 5: el pensamiento está siempre encendido y pedir apagarlo es 400.
      adjustments.push(
        `${caps.label} piensa siempre: se omite el apagado que pedía la configuración`,
      );
    } else {
      params.thinking = { type: "disabled" };
    }
  } else if (preferredMode === "adaptive") {
    params.thinking = { type: "adaptive" };
    if (declaredBudget !== null) {
      // MIGRACIÓN CRUZADA hacia arriba: el presupuesto fijo ya no existe acá.
      adjustments.push(
        `presupuesto de pensamiento (${declaredBudget}) promovido a modo adaptativo: ${caps.label} no acepta budget_tokens`,
      );
    }
  } else if (preferredMode === "budget") {
    // MIGRACIÓN CRUZADA hacia abajo: el esfuerzo se convierte a tokens.
    let budget = declaredBudget ?? (declaredEffort ? EFFORT_TO_BUDGET[declaredEffort] : 4_096);
    if (declaredBudget === null && declaredEffort) {
      adjustments.push(
        `esfuerzo "${declaredEffort}" convertido a presupuesto de ${budget} tokens: ${caps.label} sólo acepta el modo heredado`,
      );
    }
    // El proveedor exige presupuesto < max_tokens y un mínimo de 1024. Antes de
    // recortar el pensamiento, se sube el tope de salida si hay margen: recortar
    // deja al modelo sin espacio para responder lo que pensó.
    const minBudget = 1_024;
    if (budget + 1_024 > maxTokens) {
      const grown = Math.min(caps.maxOutputTokens, budget + 4_096);
      if (grown > maxTokens) {
        adjustments.push(`maxTokens elevado a ${grown} para dejar lugar al pensamiento`);
        maxTokens = grown;
        params.max_tokens = grown;
      }
    }
    if (budget >= maxTokens) {
      budget = Math.max(minBudget, maxTokens - 1_024);
      adjustments.push(`presupuesto de pensamiento acotado a ${budget} (debe ser menor que maxTokens)`);
    }
    params.thinking = { type: "enabled", budget_tokens: Math.max(minBudget, budget) };
  }

  // --- Visualización del razonamiento -----------------------------------
  // Sólo aplica al modo adaptativo. Por defecto el proveedor OMITE el texto:
  // sin este opt-in la interfaz muestra una pausa larga y ningún contenido.
  if (params.thinking?.type === "adaptive" && wantsSummary(flat.reasoningSummary)) {
    params.thinking.display = "summarized";
  }

  // --- Esfuerzo ---------------------------------------------------------
  if (caps.effortLevels.length > 0) {
    let effort: EffortLevel | null = declaredEffort;
    if (!effort && declaredBudget !== null && preferredMode === "adaptive") {
      effort = budgetToEffort(declaredBudget);
      adjustments.push(`esfuerzo derivado del presupuesto declarado: "${effort}"`);
    }
    if (effort) {
      const clamped = clampEffort(caps, effort);
      if (clamped && clamped !== effort) {
        adjustments.push(`esfuerzo "${effort}" acotado a "${clamped}" (no soportado por ${caps.label})`);
      }
      if (clamped) params.output_config = { effort: clamped };
    }
  } else if (declaredEffort) {
    // En Haiku el esfuerzo no se ignora: es un error. Se descarta acá.
    adjustments.push(`esfuerzo "${declaredEffort}" descartado: ${caps.label} no acepta el parámetro`);
  }

  // --- Pensamiento apagado + esfuerzo alto ------------------------------
  // En Opus 5 la combinación por encima de `high` devuelve 400. Se baja el
  // esfuerzo en vez de encender el pensamiento: respetar la intención declarada
  // ("no pienses") importa más que el nivel exacto.
  if (
    params.thinking?.type === "disabled" &&
    params.output_config?.effort &&
    caps.maxEffortWithThinkingDisabled
  ) {
    const cap = caps.maxEffortWithThinkingDisabled;
    const current = params.output_config.effort;
    if (EFFORT_ORDER.indexOf(current) > EFFORT_ORDER.indexOf(cap)) {
      params.output_config.effort = cap;
      adjustments.push(
        `esfuerzo bajado de "${current}" a "${cap}": ${caps.label} rechaza el pensamiento deshabilitado por encima de "${cap}"`,
      );
    }
  }

  // --- Muestreo ---------------------------------------------------------
  if (caps.supportsSampling) {
    // El proveedor rechaza `temperature` y `top_p` juntos: se prioriza el primero.
    if (typeof flat.temperature === "number") {
      params.temperature = flat.temperature;
    } else if (typeof flat.topP === "number") {
      params.top_p = flat.topP;
    }
    if (typeof flat.topK === "number") params.top_k = flat.topK;
  } else {
    const dropped = ["temperature", "topP", "topK"].filter(
      (k) => typeof (flat as Record<string, unknown>)[k] === "number",
    );
    if (dropped.length > 0) {
      adjustments.push(
        `parámetros de muestreo descartados (${dropped.join(", ")}): ${caps.label} los rechaza con 400`,
      );
    }
  }

  return { params, adjustments };
}
