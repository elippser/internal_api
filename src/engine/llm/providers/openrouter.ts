/**
 * Cliente de OpenRouter: el "gateway agregador" del §11.3.
 *
 * Se instancia por un RAMAL ESPECIAL — URL base propia y cabeceras de
 * atribución — y no por el inicializador genérico, porque no es un proveedor
 * más: es un enrutador a decenas de proveedores detrás de un solo protocolo.
 *
 * Implementa la misma interfaz `LlmClient` que el cliente de Anthropic, así que
 * el bucle de razonamiento-acción no distingue uno de otro. Toda la diferencia
 * está en la traducción de protocolo (`openrouterProtocol.ts`) y en este
 * archivo, que hace el transporte SSE a mano: no hay SDK oficial y meter una
 * dependencia para hablar un protocolo que ya sabemos hablar sería peor.
 */
import { createLogger, errField } from "../../core/logger";
import type { AnthropicMessageLike, AnthropicStreamLike, LlmClient } from "../client";
import { openRouterModel } from "./openrouterCatalog";
import {
  applyChunk,
  newAccumulator,
  parseSseBuffer,
  toEngineMessage,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiRequest,
} from "./openrouterProtocol";

const log = createLogger("engine:openrouter");

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/**
 * Cabeceras de atribución. OpenRouter las usa para el ranking público de
 * aplicaciones y para el soporte: sin ellas, un problema de tasa o de facturación
 * es imposible de correlacionar del lado de ellos.
 */
function attributionHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://internal.laupser",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "internal-laupser · motor agéntico",
  };
}

export function createOpenRouterClient(apiKey: string): LlmClient {
  return {
    provider: "openrouter",
    stream: (body) => streamCompletion(apiKey, body),
  };
}

function streamCompletion(apiKey: string, body: Record<string, unknown>): AnthropicStreamLike {
  const model = String(body.model ?? "");
  const textListeners: Array<(delta: string) => void> = [];
  const controller = new AbortController();

  const request = buildRequest(body, model);

  // La promesa se dispara YA y se comparte: `finalMessage()` puede llamarse
  // después de registrar los escuchas sin perder los primeros deltas.
  const settled = run(apiKey, request, controller, (delta) => {
    for (const listener of textListeners) {
      try {
        listener(delta);
      } catch (err) {
        // Un espectador que revienta no puede llevarse la corrida puesta.
        log.warn("un escucha de texto falló", errField(err));
      }
    }
  });

  const stream: AnthropicStreamLike = {
    // La sobrecarga de `on` obliga a una firma compatible con las dos ramas
    // (`"text"` con delta tipado, y el caso genérico); se acepta la más ancha
    // y se estrecha adentro.
    on(event: string, cb: never) {
      if (event === "text") textListeners.push(cb as unknown as (delta: string) => void);
      return stream;
    },
    finalMessage: () => settled,
    abort: () => controller.abort(),
    [Symbol.asyncIterator]() {
      // El motor consume el stream por `on("text")` + `finalMessage()`. El
      // iterador existe para cumplir la interfaz; entregar el mensaje final
      // como único elemento es honesto y no promete deltas que no da.
      let done = false;
      return {
        async next() {
          if (done) return { done: true as const, value: undefined };
          done = true;
          return { done: false as const, value: await settled };
        },
      };
    },
  };

  return stream;
}

/** Traduce el cuerpo del motor al protocolo mayoritario. */
function buildRequest(body: Record<string, unknown>, model: string): OpenAiRequest {
  const caps = openRouterModel(model);

  const messages = toOpenAiMessages(
    (body.messages as Array<{ role: string; content: unknown }>) ?? [],
  );

  const system = body.system;
  const systemText =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? (system as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("\n\n")
        : "";

  const request: OpenAiRequest = {
    model,
    messages: systemText.trim()
      ? [{ role: "system", content: systemText }, ...messages]
      : messages,
    stream: true,
    // Sin esto el proveedor no manda el uso y toda la contabilidad de costo
    // queda en cero, que es peor que un costo aproximado.
    stream_options: { include_usage: true },
  };

  const tools = toOpenAiTools((body.tools as Array<Record<string, unknown>>) ?? []);
  if (tools && (!caps || caps.tools)) request.tools = tools;
  else if (tools && caps && !caps.tools) {
    log.warn("el modelo no acepta herramientas; se omiten del pedido", { model });
  }

  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;

  // El esfuerzo del motor se traduce al parámetro de razonamiento sólo si el
  // modelo lo acepta. Mandarlo a uno que no lo soporta es un 400.
  const outputConfig = body.output_config as { effort?: string } | undefined;
  if (outputConfig?.effort && caps?.reasoning) {
    request.reasoning = { effort: outputConfig.effort };
  }

  return request;
}

async function run(
  apiKey: string,
  request: OpenAiRequest,
  controller: AbortController,
  onText: (delta: string) => void,
): Promise<AnthropicMessageLike> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...attributionHeaders(),
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
    );
  }

  const acc = newAccumulator();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseBuffer(buffer);
    buffer = rest;

    for (const event of events) {
      // Un error a mitad del stream llega COMO EVENTO, no como status HTTP:
      // el 200 ya se mandó. Sin este chequeo, el turno termina "bien" con la
      // respuesta cortada y nadie se entera.
      const error = event.error as Record<string, unknown> | undefined;
      if (error) {
        throw new Error(`OpenRouter: ${String(error.message ?? JSON.stringify(error))}`);
      }
      const delta = applyChunk(acc, event);
      if (delta) onText(delta);
    }
  }

  const message = toEngineMessage(acc, request.model);

  return {
    content: message.content,
    stop_reason: message.stop_reason,
    /**
     * Se informa el modelo que PEDIMOS, no el que el gateway resolvió río
     * arriba.
     *
     * El gateway responde con el id concreto del proveedor final (por ejemplo
     * `deepseek-v4-flash-0731` en vez de `~deepseek/deepseek-v4-flash-latest`),
     * y ese id no existe en ningún catálogo nuestro: la tarificación no lo
     * encontraba y caía a la tarifa de reserva, cobrando decenas de veces de
     * más en el asiento. La clave de tarifa tiene que ser lo que el autor
     * eligió, que es lo que el catálogo del gateway sabe cotizar.
     *
     * El id resuelto no se pierde: queda en la carga cruda del paso, que es
     * donde se lo busca cuando importa.
     */
    model: request.model,
    usage: {
      input_tokens: message.usage.input_tokens ?? 0,
      output_tokens: message.usage.output_tokens ?? 0,
      // OpenRouter no expone métricas de caché de forma uniforme entre
      // proveedores: se informan en cero en vez de inventarlas.
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}
