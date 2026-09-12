/**
 * Transcripción de voz del chat, del lado del SERVIDOR.
 *
 * Por qué existe: el dictado usaba la Web Speech API del navegador, que en
 * Chrome manda el audio a un servicio de Google. Brave y varias builds de
 * Chromium traen ese servicio deshabilitado — el objeto existe, el permiso se
 * concede, y falla igual. No hay nada que arreglar del lado del cliente ahí: el
 * navegador simplemente no transcribe.
 *
 * Acá el audio lo graba el navegador (que eso sí lo puede hacer siempre) y lo
 * transcribe el mismo gateway que ya usa todo el resto de la plataforma. Un
 * solo camino para todos los navegadores, en vez de uno que anda en Chrome y
 * otro que no anda en ningún lado.
 *
 * NO usa el SDK de Anthropic como el resto del runtime: el ramal Messages no
 * transporta audio. Va por el ramal `chat/completions` de OpenRouter, que
 * acepta bloques `input_audio`.
 */

import { attributionHeaders } from "../../../shared/llm/provider";

/**
 * Modelo de transcripción. `gemini-3.5-flash-lite` es el más barato del
 * catálogo que acepta audio: medido el 12-09-2026, transcribe 4 segundos de
 * español por USD 0,00007 en ~2,3 s. El tier premium hace lo mismo por 4,5
 * veces más, y para pasar voz a texto no hay nada que razonar.
 */
const TRANSCRIBE_MODEL =
  process.env.LLM_MODEL_TRANSCRIBE ?? "google/gemini-3.5-flash-lite";

const BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
)
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "") + "/v1";

/** Techo del audio aceptado. 60 s de WAV 16 kHz mono son ~2 MB. */
export const MAX_AUDIO_BYTES = Number(
  process.env.TRANSCRIBE_MAX_BYTES ?? 6 * 1024 * 1024,
);

const TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 30_000);

export interface TranscribeResult {
  text: string;
  model: string;
  ms: number;
  /** Tokens de audio + texto, para el medidor de consumo. */
  inputTokens: number;
  outputTokens: number;
}

export class TranscribeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

/**
 * El prompt es deliberadamente seco.
 *
 * Un modelo de lenguaje transcribiendo tiende a "ayudar": corrige lo que cree
 * un error, completa la frase, contesta la pregunta que escuchó. Cualquiera de
 * esas tres cosas arruina un dictado, porque el usuario espera ver lo que dijo
 * y después decidir si lo manda.
 */
const SYSTEM = [
  "Sos un transcriptor. Devolvés EXACTAMENTE lo que se dice en el audio y nada más.",
  "",
  "- No traduzcas: transcribí en el idioma en que se habla (casi siempre español rioplatense).",
  "- No respondas ni comentes lo que escuchás, aunque sea una pregunta o una orden.",
  "- No agregues comillas, encabezados, ni notas como '(inaudible)'.",
  "- Puntuá y usá mayúsculas con normalidad, para que se pueda leer.",
  "- Nombres de hotelería que pueden aparecer: check-in, check-out, overbooking,",
  "  no-show, tarifa, ocupación, ADR, RevPAR, comp-set, pickup.",
  "- Si el audio está vacío o no se entiende nada, devolvé una cadena vacía.",
].join("\n");

export async function transcribeAudio(input: {
  /** Audio en base64, SIN el prefijo `data:`. */
  audioBase64: string;
  /** Contenedor: wav, mp3, ogg, webm… El proveedor sniffea los bytes igual. */
  format?: string;
}): Promise<TranscribeResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new TranscribeError(503, "La transcripción no está configurada.");
  }

  const bytes = Math.floor((input.audioBase64.length * 3) / 4);
  if (bytes > MAX_AUDIO_BYTES) {
    throw new TranscribeError(
      413,
      `El audio es muy largo (${Math.round(bytes / 1024 / 1024)} MB). Grabá un mensaje más corto.`,
    );
  }
  if (bytes < 1024) {
    // Menos de un kilobyte no es voz: es el usuario que tocó el micrófono sin
    // querer. Se corta acá para no pagar una llamada que va a volver vacía.
    return { text: "", model: TRANSCRIBE_MODEL, ms: 0, inputTokens: 0, outputTokens: 0 };
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...attributionHeaders(),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: TRANSCRIBE_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribí este audio." },
              {
                type: "input_audio",
                input_audio: { data: input.audioBase64, format: input.format ?? "wav" },
              },
            ],
          },
        ],
        // Un dictado largo son ~200 palabras. 800 tokens sobran y acotan el
        // daño si el modelo decide ponerse a conversar.
        max_tokens: 800,
        temperature: 0,
      }),
    });

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (!res.ok) {
      const message = json?.error?.message ?? `El proveedor devolvió ${res.status}`;
      console.warn(`[transcribe] ${res.status}: ${message}`);
      throw new TranscribeError(502, "No se pudo transcribir el audio.");
    }

    const raw = json.choices?.[0]?.message?.content ?? "";
    return {
      text: cleanTranscript(raw),
      model: TRANSCRIBE_MODEL,
      ms: Date.now() - t0,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof TranscribeError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new TranscribeError(504, "La transcripción tardó demasiado.");
    }
    console.warn("[transcribe] falló:", (err as Error)?.message);
    throw new TranscribeError(502, "No se pudo transcribir el audio.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saca lo que el modelo agrega aunque se le pida que no.
 *
 * Las comillas envolventes son el caso frecuente: el modelo entiende
 * "transcribí" como "citá". También aparecen prefijos tipo "Transcripción:".
 */
export function cleanTranscript(raw: string): string {
  let t = (raw ?? "").trim();
  t = t.replace(/^(transcripci[óo]n|texto|audio)\s*:\s*/i, "");
  // Comillas envolventes, sólo si abren y cierran: un texto que empieza con
  // una cita legítima no se toca.
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["«", "»"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length > 1) {
      t = t.slice(open.length, -close.length).trim();
      break;
    }
  }
  // El modelo declara el silencio con estas frases en vez de devolver vacío.
  if (/^\(?(inaudible|sin audio|silencio|no se (entiende|escucha)[^)]*)\)?\.?$/i.test(t)) {
    return "";
  }
  return t;
}
