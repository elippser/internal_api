/**
 * Contratos de petición del motor (§5, paquete `schemas/`).
 *
 * `agentVersionSchema` es el más denso a propósito: valida la configuración de
 * interrupciones, de contexto y de sub-agentes AL GUARDAR, no al ejecutar. Es
 * la diferencia entre un 422 inmediato con el campo exacto y una sorpresa a
 * mitad de una corrida de producción — o peor, una compuerta de aprobación que
 * el operador cree activa y que nunca frena nada (§15.3).
 */
import Joi from "joi";
import {
  AUTHORABLE_GRAPH_TYPES,
  COMPLEXITY_TIERS,
  CONCURRENCY_MODES,
  EXECUTION_STATUSES,
  RESPONSE_MODES,
  RUNTIME_CAPABILITIES,
  SUB_AGENT_MODES,
  TOOL_SCOPES,
  TOOL_TYPES,
} from "../../engine/models/enums";

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export const createAgentSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  slug: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/)
    .max(60),
  description: Joi.string().allow("").max(2000),
  imageUrl: Joi.string().uri().allow(null, ""),
  tenantId: Joi.string().allow(null),
  availableInCopilot: Joi.boolean(),
}).required();

export const updateAgentSchema = Joi.object({
  name: Joi.string().min(1).max(120),
  description: Joi.string().allow("").max(2000),
  imageUrl: Joi.string().uri().allow(null, ""),
  availableInCopilot: Joi.boolean(),
  status: Joi.string().valid("draft", "active", "paused", "archived"),
})
  .min(1)
  .required();

const interruptionSchema = Joi.object({
  trigger: Joi.string()
    .valid("tool_call", "turn_count")
    // El umbral de costo se rechaza EXPLÍCITAMENTE y con motivo: no tiene
    // implementación en runtime, y aceptarlo sería prometer una compuerta que
    // nunca frena nada.
    .messages({
      "any.only":
        'Disparador no soportado. Sólo "tool_call" y "turn_count". ' +
        'El umbral de costo se rechaza a propósito: no tiene implementación en runtime y ' +
        "aceptarlo prometería una compuerta que nunca frena nada.",
    })
    .required(),
  toolName: Joi.string().when("trigger", {
    is: "tool_call",
    // El emparejamiento es por nombre exacto: sin nombre la regla nunca dispara.
    then: Joi.required().messages({
      "any.required":
        'Una interrupción por llamada a herramienta exige "toolName": el emparejamiento es por nombre exacto.',
    }),
    otherwise: Joi.forbidden(),
  }),
  everyNTurns: Joi.number()
    .integer()
    .min(1)
    .when("trigger", {
      is: "turn_count",
      // El cero apagaría el límite en vez de interrumpir siempre.
      then: Joi.required().messages({
        "number.min": '"everyNTurns" debe ser ≥ 1: el 0 apagaría el límite en vez de interrumpir.',
        "any.required": 'Una interrupción por conteo de turnos exige "everyNTurns" entero ≥ 1.',
      }),
      otherwise: Joi.forbidden(),
    }),
  message: Joi.string().max(500),
});

const subAgentSchema = Joi.object({
  name: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,64}$/)
    .required()
    // OJO con las llaves en los mensajes de Joi: `{...}` es sintaxis de
    // interpolación de plantilla y se parsea AL CONSTRUIR el esquema, o sea al
    // cargar el módulo. Escribir el regex literal acá (con su `{1,64}`) hace
    // que Joi intente resolver "1,64" como referencia y tire abajo el arranque
    // de la API entera. Se describe la regla en palabras.
    .messages({
      "string.pattern.base":
        "El nombre del sub-agente sólo admite letras, números, guion y guion bajo, " +
        "hasta 64 caracteres: es lo que acepta el proveedor como nombre de herramienta.",
    }),
  agentId: Joi.string().required(),
  description: Joi.string().allow("").max(1000),
  mode: Joi.string().valid(...SUB_AGENT_MODES),
  models: Joi.array().items(
    Joi.object({
      tier: Joi.string()
        .valid(...COMPLEXITY_TIERS)
        .required(),
      model: Joi.string().required(),
    }),
  ),
  maxDepth: Joi.number().integer().min(1).max(10).allow(null),
  timeoutSeconds: Joi.number().integer().min(5).max(3600).allow(null),
  toolAllowlist: Joi.array().items(Joi.string()),
});

export const agentVersionSchema = Joi.object({
  graphType: Joi.string()
    .valid(...AUTHORABLE_GRAPH_TYPES)
    .messages({
      "any.only":
        `Sólo se puede crear "${AUTHORABLE_GRAPH_TYPES.join('", "')}". Los otros tipos siguen en la ` +
        "enumeración con su constructor intacto, pero la autoría está desactivada.",
    }),
  systemPrompt: Joi.string().allow("").max(120_000),
  tools: Joi.array().items(Joi.string()),
  skills: Joi.array().items(Joi.string()),
  subAgents: Joi.array().items(subAgentSchema),
  modelName: Joi.string().required(),
  modelParams: Joi.object({
    reasoningEffort: Joi.string().valid("low", "medium", "high", "xhigh", "max"),
    thinkingEnabled: Joi.boolean(),
    thinkingBudgetTokens: Joi.number().integer().min(1024),
    reasoningSummary: Joi.alternatives(Joi.boolean(), Joi.string().valid("summarized", "omitted")),
    temperature: Joi.number().min(0).max(1),
    topP: Joi.number().min(0).max(1),
    topK: Joi.number().integer().min(0),
    maxTokens: Joi.number().integer().min(256),
  }).unknown(true),
  outputSchema: Joi.object().allow(null).unknown(true),
  contextSchema: Joi.object().allow(null).unknown(true),
  contextProviders: Joi.array().items(
    Joi.object({ type: Joi.string().required(), config: Joi.object().unknown(true) }),
  ),
  credentials: Joi.array().items(Joi.string()),
  graphConfig: Joi.object({ maxIterations: Joi.number().integer().min(1).max(50) }).unknown(true),
  config: Joi.object({
    capabilities: Joi.object(
      Object.fromEntries(RUNTIME_CAPABILITIES.map((c) => [c, Joi.boolean()])),
    ),
    interruptions: Joi.array().items(interruptionSchema),
    guardrails: Joi.object({
      input: Joi.array().items(Joi.string()),
      output: Joi.array().items(Joi.string()),
      tool: Joi.array().items(Joi.string()),
    }),
    hooks: Joi.object().unknown(true),
    context: Joi.object({
      historyWindowMessages: Joi.number().integer().min(2).max(200),
      maxHistoryTokens: Joi.number().integer().min(1000),
      cacheTtl: Joi.string().valid("5m", "1h"),
    }),
    visionModel: Joi.string().allow(null, ""),
    toolConcurrency: Joi.object().pattern(
      Joi.string(),
      Joi.string().valid(...CONCURRENCY_MODES),
    ),
  }).unknown(true),
  timeoutSeconds: Joi.number().integer().min(5).max(3600),
  maxDurationSeconds: Joi.number().integer().min(5).max(7200),
  maxRetries: Joi.number().integer().min(0).max(5),
  changeNote: Joi.string().allow("", null).max(500),
}).required();

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

export const createToolSchema = Joi.object({
  name: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,64}$/)
    .required(),
  displayName: Joi.string().allow("").max(120),
  description: Joi.string().allow("").max(4000),
  type: Joi.string()
    .valid(...TOOL_TYPES)
    // Los tipos que no pueden nacer de una fila se rechazan acá también, con el
    // motivo, en vez de dejar que la fábrica falle al construir el grafo.
    .invalid("function", "sub_agent")
    .required()
    .messages({
      "any.invalid":
        'Los tipos "function" y "sub_agent" no pueden nacer de una fila del catálogo: ' +
        "el primero vive en el registro de código y el segundo se cablea desde la lista " +
        "subAgents de la versión, donde se valida la propiedad del agente destino.",
    }),
  scope: Joi.string().valid(...TOOL_SCOPES),
  tenantId: Joi.string().allow(null),
  inputSchema: Joi.object({
    type: Joi.string().valid("object"),
    properties: Joi.object().unknown(true),
    required: Joi.array().items(Joi.string()),
  }),
  config: Joi.object().unknown(true),
  permissions: Joi.object({
    roleFloor: Joi.string()
      .valid("support", "analyst", "developer", "admin", "super_admin")
      .allow(null),
    requiresConfirmation: Joi.boolean(),
    isDestructive: Joi.boolean(),
  }),
  concurrency: Joi.string()
    .valid(...CONCURRENCY_MODES)
    .allow(null),
}).required();

// ---------------------------------------------------------------------------
// Ejecuciones
// ---------------------------------------------------------------------------

export const createExecutionSchema = Joi.object({
  agentId: Joi.string().required(),
  input: Joi.object().unknown(true),
  inputText: Joi.string().allow("").max(200_000),
  sessionId: Joi.string().allow(null),
  // Clave del hilo externo: agrupa eventos del mismo hilo en una sesión.
  externalKey: Joi.string().max(200).allow(null),
  responseMode: Joi.string().valid(...RESPONSE_MODES),
  callbackUrl: Joi.string().uri({ scheme: ["https", "http"] }).allow(null),
  idempotencyKey: Joi.string().max(200).allow(null),
  priority: Joi.number().integer().min(-100).max(100),
  versionId: Joi.string().allow(null),
  // `sourceScheduledTaskId` NO figura: es un enlace confiable que sólo estampa
  // el planificador. Aceptarlo desde el cuerpo permitiría falsificar la
  // atribución de autoría y ver tareas de otro cliente.
})
  .required()
  .unknown(false);

export const resumeExecutionSchema = Joi.object({
  payload: Joi.any(),
}).required();

export const listExecutionsSchema = Joi.object({
  agentId: Joi.string(),
  status: Joi.string().valid(...EXECUTION_STATUSES),
  sessionId: Joi.string(),
  userId: Joi.string(),
  parentExecutionId: Joi.string(),
  trigger: Joi.string(),
  dateFrom: Joi.date().iso(),
  dateTo: Joi.date().iso(),
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
}).unknown(true);

/** Valida y devuelve el valor limpio, o lanza el error de dominio del motor. */
export async function validate<T>(schema: Joi.Schema, payload: unknown): Promise<T> {
  const { ValidationError } = await import("../../engine/core/errors");
  const { error, value } = schema.validate(payload, {
    abortEarly: false,
    stripUnknown: false,
    convert: true,
  });
  if (error) {
    throw new ValidationError(error.details.map((d) => d.message).join("; "), {
      fields: error.details.map((d) => ({ path: d.path.join("."), message: d.message })),
    });
  }
  return value as T;
}
