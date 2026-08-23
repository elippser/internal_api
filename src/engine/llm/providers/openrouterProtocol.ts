/**
 * Traducción de protocolo: forma interna del motor <-> protocolo mayoritario.
 *
 * El motor habla internamente en BLOQUES DE CONTENIDO (text / tool_use /
 * tool_result), que es la forma de Anthropic. OpenRouter expone el protocolo
 * de completado de chat mayoritario, que usa `tool_calls` en el mensaje del
 * asistente y mensajes de rol `tool` para los resultados.
 *
 * Toda la traducción vive acá y NO se filtra al resto del motor. Es deliberado:
 * el bucle de razonamiento-acción, el nodo particionado de herramientas y el
 * grabador de pasos no tienen por qué saber contra qué proveedor están
 * corriendo. Si la conversión se hiciera en el grafo, agregar un proveedor
 * sería tocar el motor en vez de sumar un archivo.
 *
 * Las funciones son PURAS y están exportadas para poder probarlas sin red:
 * esta capa es donde viven los errores caros (un `tool_call_id` desemparejado
 * rompe el turno con un 400 que no dice cuál), y una capa así sin pruebas es
 * una bomba de tiempo.
 */

// ---------------------------------------------------------------------------
// Tipos del protocolo mayoritario (los mínimos que usamos)
// ---------------------------------------------------------------------------

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  reasoning?: { effort?: string; max_tokens?: number };
}

// ---------------------------------------------------------------------------
// Motor -> protocolo mayoritario
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

/** Aplana los bloques de sistema a un único mensaje `system`. */
function systemToMessage(system: unknown): OpenAiMessage | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.trim() ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    // Se pierden los `cache_control`: el caché de prefijo es una propiedad del
    // proveedor y OpenRouter no lo expone de forma uniforme. Perderlo encarece,
    // no rompe — y el motor ya lo mide, así que el impacto se ve en el tablero.
    const text = (system as Block[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");
    return text.trim() ? { role: "system", content: text } : null;
  }
  return null;
}

/**
 * Convierte un mensaje del motor a uno o VARIOS del protocolo mayoritario.
 *
 * Un turno de usuario con tres `tool_result` se convierte en TRES mensajes de
 * rol `tool`, uno por resultado. Ese fan-out es la diferencia estructural entre
 * los dos protocolos y la fuente más común de turnos rotos: agrupar los tres en
 * un solo mensaje deja dos llamadas sin respuesta y el proveedor rechaza.
 */
export function toOpenAiMessages(messages: Array<{ role: string; content: unknown }>): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];

  for (const msg of messages) {
    const content = msg.content;

    if (typeof content === "string") {
      out.push({ role: msg.role === "assistant" ? "assistant" : "user", content });
      continue;
    }

    if (!Array.isArray(content)) {
      out.push({ role: msg.role === "assistant" ? "assistant" : "user", content: String(content ?? "") });
      continue;
    }

    const blocks = content as Block[];

    if (msg.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");

      const toolCalls: OpenAiToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id ?? ""),
          type: "function" as const,
          function: {
            name: String(b.name ?? ""),
            // El protocolo mayoritario manda los argumentos SERIALIZADOS.
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));

      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // Turno de usuario: los resultados de herramienta se separan en mensajes
    // propios; el resto (texto e imágenes) queda en un mensaje de usuario.
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    for (const result of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: String(result.tool_use_id ?? ""),
        content:
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content ?? ""),
      });
    }

    const rest = blocks.filter((b) => b.type !== "tool_result");
    if (rest.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of rest) {
        if (b.type === "text") {
          parts.push({ type: "text", text: String(b.text ?? "") });
        } else if (b.type === "image") {
          const source = (b.source ?? {}) as Record<string, unknown>;
          const url =
            source.type === "base64"
              ? `data:${String(source.media_type ?? "image/png")};base64,${String(source.data ?? "")}`
              : String(source.url ?? "");
          if (url) parts.push({ type: "image_url", image_url: { url } });
        }
        // Los documentos (PDF/CSV inline) no tienen equivalente uniforme en el
        // protocolo mayoritario: se omiten en vez de mandar algo que el
        // proveedor rechace con un 400 sin explicar cuál bloque fue.
      }

      if (parts.length === 1 && parts[0].type === "text") {
        out.push({ role: "user", content: String(parts[0].text) });
      } else if (parts.length > 0) {
        out.push({ role: "user", content: parts });
      }
    }
  }

  return out;
}

/** Herramientas del motor -> funciones del protocolo mayoritario. */
export function toOpenAiTools(
  tools: Array<Record<string, unknown>>,
): OpenAiRequest["tools"] {
  const converted = tools
    // Las de SERVIDOR (búsqueda web, ejecución de código de Anthropic) no
    // existen del otro lado: se descartan en vez de mandarlas y provocar un 400.
    .filter((t) => typeof t.name === "string" && t.input_schema)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: String(t.name),
        description: String(t.description ?? ""),
        parameters: (t.input_schema ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
      },
    }));

  return converted.length > 0 ? converted : undefined;
}

// ---------------------------------------------------------------------------
// Protocolo mayoritario -> motor
// ---------------------------------------------------------------------------

/** `finish_reason` del protocolo mayoritario -> `stop_reason` del motor. */
export function toStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      // Se mapea a `refusal` para que el bucle lo trate como un desenlace de
      // contenido y no como una falla del sistema: el corredor ya sabe cerrar
      // limpio en ese caso.
      return "refusal";
    default:
      return "end_turn";
  }
}

export interface StreamAccumulator {
  text: string;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: { input_tokens?: number; output_tokens?: number };
  model: string | null;
}

export function newAccumulator(): StreamAccumulator {
  return { text: "", toolCalls: new Map(), finishReason: null, usage: {}, model: null };
}

/**
 * Aplica un fragmento del stream al acumulador. Devuelve el delta de texto (o
 * cadena vacía) para que el llamador lo publique al bus.
 *
 * Los argumentos de las herramientas llegan FRAGMENTADOS y hay que concatenarlos
 * por índice antes de parsear: intentar `JSON.parse` en cada delta falla en
 * todos menos el último.
 */
export function applyChunk(acc: StreamAccumulator, chunk: Record<string, unknown>): string {
  if (typeof chunk.model === "string" && !acc.model) acc.model = chunk.model;

  const usage = chunk.usage as Record<string, number> | undefined;
  if (usage) {
    acc.usage.input_tokens = usage.prompt_tokens ?? acc.usage.input_tokens;
    acc.usage.output_tokens = usage.completion_tokens ?? acc.usage.output_tokens;
  }

  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (!choice) return "";

  if (typeof choice.finish_reason === "string") acc.finishReason = choice.finish_reason;

  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return "";

  let textDelta = "";
  if (typeof delta.content === "string" && delta.content) {
    textDelta = delta.content;
    acc.text += delta.content;
  }

  const calls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const index = Number(call.index ?? 0);
      const current = acc.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string" && call.id) current.id = call.id;
      const fn = call.function as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn.name === "string" && fn.name) current.name = fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
      }
      acc.toolCalls.set(index, current);
    }
  }

  return textDelta;
}

/** Cierra el acumulador y produce el mensaje en la forma interna del motor. */
export function toEngineMessage(
  acc: StreamAccumulator,
  fallbackModel: string,
): {
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  model: string;
  usage: { input_tokens?: number; output_tokens?: number };
} {
  const content: Array<Record<string, unknown>> = [];

  if (acc.text) content.push({ type: "text", text: acc.text });

  for (const [index, call] of [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    let input: Record<string, unknown> = {};
    try {
      input = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
    } catch {
      // Argumentos malformados: se pasan crudos en vez de descartar la llamada.
      // El ejecutor va a fallar con un mensaje que el modelo puede leer y
      // corregir, que es mejor que una llamada que desaparece sin rastro.
      input = { __rawArguments: call.arguments };
    }
    content.push({
      type: "tool_use",
      // Si el proveedor no mandó id, se sintetiza uno estable por índice: sin
      // id no hay forma de emparejar el resultado y el turno siguiente rompe.
      id: call.id || `call_${index}`,
      name: call.name,
      input,
    });
  }

  // Un turno que pidió herramientas SIEMPRE termina en `tool_use`, aunque el
  // proveedor haya informado otra cosa: es lo que el bucle mira para decidir si
  // hay que ejecutar y volver.
  const hasToolCalls = acc.toolCalls.size > 0;
  const stopReason = hasToolCalls ? "tool_use" : toStopReason(acc.finishReason);

  return {
    content,
    stop_reason: stopReason,
    model: acc.model ?? fallbackModel,
    usage: acc.usage,
  };
}

/**
 * Parte un buffer SSE en objetos JSON. Devuelve lo consumido y el resto, porque
 * un chunk de red puede cortar una línea por la mitad y parsear a medias
 * descarta datos en silencio.
 */
export function parseSseBuffer(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const events: Record<string, unknown>[] = [];
  const lines = buffer.split("\n");
  // La última línea puede estar incompleta: se devuelve para el próximo chunk.
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // Fragmento no parseable: se descarta este evento, no el stream.
    }
  }

  return { events, rest };
}
