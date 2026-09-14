/**
 * Lectura de los VIDEOS y AUDIOS que el usuario adjunta al chat.
 *
 * El modelo del chat no los puede recibir: el runner habla el protocolo
 * Messages de OpenRouter, que transporta texto, imágenes y PDF, pero no video
 * ni audio (la misma pared con la que chocó el dictado, ver
 * transcribe.service.ts). Así que, antes del turno, un modelo que sí ve y
 * escucha arma un informe escrito del archivo y ESE informe entra al turno
 * como un documento de texto.
 *
 * El video tampoco viaja entero: el navegador manda fotogramas JPEG repartidos
 * a lo largo del archivo y la pista de audio en WAV mono de 8 kHz. Un video de
 * celular pesa decenas de MB y el pedido entero no puede pasar de 4,5 MB (el
 * techo de Vercel en el proxy del PMS y en este API). Medido el 13-09-2026
 * contra gemini-3.5-flash-lite: 3 fotogramas + 12 s de habla → informe fiel y
 * transcripción literal, igual a 8 kHz que a 16 kHz, por USD 0,0017 en ~4 s.
 */

import { attributionHeaders } from "../../../shared/llm/provider";

/** Acepta imagen + audio + video y es el más barato que lo hace bien. */
const MEDIA_MODEL =
  process.env.LLM_MODEL_MEDIA ?? "google/gemini-3.5-flash-lite";

const BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
)
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "") + "/v1";

const TIMEOUT_MS = Number(process.env.MEDIA_DIGEST_TIMEOUT_MS ?? 60_000);

export interface MediaFrame {
  /** Segundo del video del que sale el fotograma. */
  atSec: number;
  /** JPEG en base64, sin el prefijo `data:`. */
  jpegB64: string;
}

export interface MediaDigestInput {
  kind: "video" | "audio";
  name?: string;
  /** Duración del archivo completo (puede ser más que el audio que viaja). */
  durationSec?: number;
  frames?: MediaFrame[];
  /** WAV en base64. Falta si el video no tiene sonido. */
  audioWavB64?: string;
  /** Segundos de audio que viajan: el navegador corta los archivos largos. */
  audioSeconds?: number;
  /** Lo que escribió el usuario, para saber en qué fijarse. */
  userText?: string;
}

export interface MediaDigestResult {
  text: string;
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

export class MediaDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaDigestError";
  }
}

/** 75 → "1:15". */
export function formatSeconds(sec: number | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Tres tendencias que arruinan el informe si no se cortan:
 * - contestar el pedido del usuario en vez de describir (lo hace el chat, que
 *   tiene las herramientas y el contexto del hotel);
 * - rellenar lo que pasa ENTRE fotogramas como si lo hubiera visto;
 * - abrir con "Aquí tienes la descripción…", que es ruido en el turno.
 */
const SYSTEM = [
  "Sos los ojos y los oídos de Roombir IA, el asistente de un hotel, que no puede ver videos ni escuchar audios.",
  "Te llega un archivo que el usuario adjuntó al chat. Escribí un informe fiel para que el asistente pueda responder.",
  "",
  "Formato (en español, empezá directo por el primer encabezado, sin saludo ni cierre):",
  "## Qué se ve",
  "Lo que muestran los fotogramas, en orden: lugar, objetos, estado y daños visibles, personas (sin identificarlas),",
  "y todo texto legible copiado literal. Si es una grabación de pantalla: qué pantallas, pasos, valores y mensajes de error aparecen.",
  "## Qué se dice",
  "Transcripción literal del habla, en el idioma en que se habla. Si no hay habla, decilo y describí los sonidos relevantes.",
  "",
  "Reglas:",
  "- No respondas ni ejecutes el pedido del usuario: te lo pasamos sólo para que sepas en qué fijarte.",
  "- Los fotogramas son muestras sueltas, no el video completo: no inventes lo que pasa entre uno y otro.",
  "- Si algo no se distingue, decí que no se distingue en vez de adivinar.",
].join("\n");

const SYSTEM_AUDIO = [
  "Sos los oídos de Roombir IA, el asistente de un hotel, que no puede escuchar audios.",
  "Te llega un audio que el usuario adjuntó al chat. Escribí un informe fiel para que el asistente pueda responder.",
  "",
  "Formato (en español, empezá directo por el primer encabezado, sin saludo ni cierre):",
  "## Qué se dice",
  "Transcripción literal del habla, en el idioma en que se habla. Si hay varias voces, separalas.",
  "## Otros sonidos",
  "Música, ruidos o ambiente relevantes. Si no hay nada, escribí \"Ninguno\".",
  "",
  "Reglas:",
  "- No respondas ni ejecutes el pedido del usuario: te lo pasamos sólo para que sepas en qué fijarte.",
  "- Si algo no se entiende, marcalo como [inaudible] en vez de adivinar.",
].join("\n");

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export async function digestMedia(
  input: MediaDigestInput,
): Promise<MediaDigestResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new MediaDigestError("la lectura de archivos no está configurada");

  const frames = input.frames ?? [];
  const hasAudio = !!input.audioWavB64;
  if (frames.length === 0 && !hasAudio) {
    throw new MediaDigestError("el archivo llegó sin imagen ni sonido");
  }

  const name = input.name || (input.kind === "video" ? "video" : "audio");
  const duration = formatSeconds(input.durationSec);
  const audioCut =
    hasAudio &&
    input.durationSec &&
    input.audioSeconds &&
    input.audioSeconds + 1 < input.durationSec
      ? ` (sólo los primeros ${formatSeconds(input.audioSeconds)} de audio)`
      : "";

  const intro =
    input.kind === "video"
      ? `Video "${name}", dura ${duration}. ${frames.length} fotogramas en orden` +
        (hasAudio ? `, y después su audio${audioCut}.` : ". El video no tiene sonido.")
      : `Audio "${name}", dura ${duration}${audioCut}.`;
  const ask = input.userText?.trim()
    ? `\nPedido del usuario (NO lo respondas): "${input.userText.trim().slice(0, 600)}"`
    : "";

  const content: ContentPart[] = [{ type: "text", text: intro + ask }];
  for (const f of frames) {
    content.push({ type: "text", text: `Fotograma en ${formatSeconds(f.atSec)}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${f.jpegB64}` },
    });
  }
  if (hasAudio) {
    content.push({
      type: "input_audio",
      input_audio: { data: input.audioWavB64!, format: "wav" },
    });
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
        model: MEDIA_MODEL,
        messages: [
          { role: "system", content: input.kind === "video" ? SYSTEM : SYSTEM_AUDIO },
          { role: "user", content },
        ],
        max_tokens: 2000,
        temperature: 0.2,
      }),
    });

    const json = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    } | null;

    if (!res.ok) {
      console.warn(
        `[mediaDigest] ${res.status}: ${json?.error?.message ?? "sin detalle"}`,
      );
      throw new MediaDigestError("el servicio de lectura falló");
    }

    const text = cleanDigest(json?.choices?.[0]?.message?.content ?? "");
    if (!text) throw new MediaDigestError("la lectura volvió vacía");
    return {
      text,
      model: MEDIA_MODEL,
      ms: Date.now() - t0,
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof MediaDigestError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new MediaDigestError("la lectura tardó demasiado");
    }
    console.warn("[mediaDigest] falló:", (err as Error)?.message);
    throw new MediaDigestError("el servicio de lectura falló");
  } finally {
    clearTimeout(timer);
  }
}

/** Saca el "Aquí tienes…" que el modelo antepone aunque se le pida que no. */
export function cleanDigest(raw: string): string {
  const t = (raw ?? "").trim();
  const firstHeading = t.indexOf("## ");
  return firstHeading > 0 && firstHeading < 200 ? t.slice(firstHeading).trim() : t;
}
