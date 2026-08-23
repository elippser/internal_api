/**
 * Validación del esquema de salida declarado en la versión del agente.
 *
 * Un agente puede declarar `outputSchema`: cuando lo hace, se COMPROMETE a
 * devolver JSON con esa forma, y quien lo consume (un webhook, un conector, un
 * agente padre) puede confiar en los campos sin defenderse. Si la salida no
 * cumple, la corrida FALLA con `failureReason: "output_schema"`.
 *
 * Fallar y no degradar es deliberado. El consumidor de una salida estructurada
 * la parsea y usa los campos directo; entregarle prosa donde esperaba un objeto
 * produce un `undefined` que se propaga silencioso hasta aparecer como un dato
 * vacío tres sistemas más allá. Es el mismo razonamiento por el que un agente
 * revisor de código sin esquema de salida es un error de configuración (§35.13):
 * sin estructura, la sección de hallazgos queda nula y el sistema informaría
 * "sin problemas" sobre un cambio con defectos reales.
 *
 * El validador cubre el subconjunto de JSON Schema que se usa en la práctica
 * para salidas de agente. No es un validador completo: para eso está el punto
 * de extensión al final.
 */

export interface ValidationOutcome {
  ok: boolean;
  error?: string;
  /** Valor parseado cuando hay esquema; el texto crudo cuando no lo hay. */
  value?: unknown;
}

export function validateOutputSchema(
  schema: Record<string, unknown> | null,
  rawText: string,
): ValidationOutcome {
  if (!schema || Object.keys(schema).length === 0) {
    return { ok: true, value: rawText };
  }

  const parsed = parseJsonLoose(rawText);
  if (parsed === undefined) {
    return {
      ok: false,
      error:
        "se declaró un esquema de salida pero la respuesta no es JSON válido " +
        "(revisá que el prompt le pida al modelo devolver sólo JSON)",
    };
  }

  const problem = checkNode(parsed, schema, "$");
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: parsed };
}

/**
 * Parseo tolerante: los modelos suelen envolver el JSON en un bloque de código
 * o precederlo con una frase. Rechazar por eso sería fallar por formato, no por
 * contenido — y el contenido es lo que el esquema promete.
 */
function parseJsonLoose(text: string): unknown {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (lastBrace > firstBrace) {
      const slice = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
      if (slice !== undefined) return slice;
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Devuelve el mensaje del primer problema, o null si el nodo cumple. */
function checkNode(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const type = schema.type as string | string[] | undefined;

  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(value, t))) {
      return `${path}: se esperaba ${types.join(" | ")} y llegó ${describe(value)}`;
    }
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (Array.isArray(enumValues) && !enumValues.includes(value as never)) {
    return `${path}: valor fuera del enum permitido (${enumValues.join(", ")})`;
  }

  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (obj[key] === undefined) return `${path}.${key}: campo requerido ausente`;
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    for (const [key, sub] of Object.entries(properties)) {
      if (obj[key] === undefined) continue;
      const problem = checkNode(obj[key], sub, `${path}.${key}`);
      if (problem) return problem;
    }
  }

  if (matchesType(value, "array") && schema.items) {
    const items = schema.items as Record<string, unknown>;
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const problem = checkNode(arr[i], items, `${path}[${i}]`);
      if (problem) return problem;
    }
  }

  return null;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * PUNTO DE EXTENSIÓN — validación completa de JSON Schema (`$ref`, `anyOf`,
 * `allOf`, formatos, restricciones numéricas). Reemplazar `checkNode` por un
 * validador compilado (ajv u otro) sin cambiar la firma de
 * `validateOutputSchema`.
 */
