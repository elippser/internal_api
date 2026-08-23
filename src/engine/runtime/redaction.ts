/**
 * Redactor de secretos aplicado a la salida (§29).
 *
 * Defensa en profundidad. La primera línea es estructural: los secretos viajan
 * por la configuración de ejecución y nunca entran al estado del grafo ni al
 * punto de control (§35.8), así que en principio no deberían poder salir. Este
 * módulo existe porque "en principio" no es una garantía: un resultado de
 * herramienta puede traer un token en un cuerpo de error, y el modelo puede
 * repetirlo textualmente en su respuesta.
 *
 * Redacta por dos vías, que atrapan cosas distintas:
 *   - POR VALOR: valores concretos conocidos (las claves del proceso). Preciso.
 *   - POR PATRÓN: formas de secreto reconocibles aunque no las conozcamos.
 *     Atrapa el token de un tercero que llegó en una respuesta de error.
 *
 * Se aplica a respuestas, bitácoras y trazas. El costo es un recorrido de la
 * cadena por cada patrón; sobre una respuesta de agente es despreciable.
 */

/**
 * Valores concretos a redactar. Se leen del entorno UNA vez y se filtran los
 * cortos: un valor de tres caracteres aparecería en cualquier texto y
 * convertiría la respuesta en un tachado ilegible.
 */
const VALUE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "JWT_SECRET",
  "AGENT_JWT_SECRET",
  "PMS_INTERNAL_SECRET",
  "MONGO_URI",
  "MONGODB_URI",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CLOUDINARY_API_SECRET",
  "RESEND_API_KEY",
];

const MIN_SECRET_LENGTH = 12;

let knownValues: string[] | null = null;

function secretValues(): string[] {
  if (knownValues) return knownValues;
  knownValues = VALUE_ENV_KEYS.map((k) => process.env[k])
    .filter((v): v is string => typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    // Los más largos primero: si un secreto es prefijo de otro, redactar el
    // largo antes evita dejar la cola del otro al descubierto.
    .sort((a, b) => b.length - a.length);
  return knownValues;
}

/** Patrones de secreto por FORMA. Cubren lo que no conocemos por valor. */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "ANTHROPIC_KEY" },
  { re: /\bsk-[A-Za-z0-9]{32,}/g, label: "API_KEY" },
  { re: /\bghp_[A-Za-z0-9]{30,}/g, label: "GITHUB_TOKEN" },
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g, label: "WEBHOOK_SECRET" },
  { re: /\bre_[A-Za-z0-9_]{20,}/g, label: "RESEND_KEY" },
  // JWT: tres segmentos base64url separados por puntos.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "JWT" },
  { re: /\bmongodb(\+srv)?:\/\/[^\s"']+/gi, label: "MONGO_URI" },
  // Contraseña embebida en cualquier URL.
  { re: /:\/\/[^\s/:@]+:[^\s/@]+@/g, label: "URL_CREDENTIALS" },
];

/** Redacta una cadena. Devuelve la misma referencia si no hubo cambios. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;

  for (const value of secretValues()) {
    if (out.includes(value)) {
      out = out.split(value).join("[REDACTADO]");
    }
  }

  for (const { re, label } of PATTERNS) {
    // El flag `g` hace que la regex tenga estado; se resetea antes de cada uso
    // porque estos objetos son de módulo y se reutilizan entre llamadas.
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTADO:${label}]`);
  }

  return out;
}

/**
 * Redacta recursivamente una estructura. Además del valor, tacha por NOMBRE DE
 * CLAVE: un campo llamado `apiKey` es un secreto aunque su valor no matchee
 * ningún patrón conocido.
 */
const SECRET_KEY_NAMES = /^(.*(secret|password|passwd|token|api_?key|authorization|credential).*)$/i;

export function redactDeep(value: unknown, depth = 0): unknown {
  // Tope de profundidad: una estructura cíclica o muy anidada no puede colgar
  // el camino de finalización.
  if (depth > 8) return "[PROFUNDIDAD MÁXIMA]";

  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_NAMES.test(key) ? "[REDACTADO]" : redactDeep(val, depth + 1);
    }
    return out;
  }

  return value;
}

/** Sólo para pruebas: fuerza la relectura del entorno. */
export function resetRedactionCache(): void {
  knownValues = null;
}
