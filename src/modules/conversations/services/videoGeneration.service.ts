/**
 * Generación de VIDEOS cortos para Roombir IA.
 *
 * Mismo esquema que imageGeneration.service: el modelo del chat no filma, llama
 * a la tool interna `generate_video` y esta le pide el clip a un modelo aparte.
 * La diferencia es que el video es ASÍNCRONO en OpenRouter: se encola un job en
 * `POST /videos`, se consulta hasta que termina y se descarga con la key. Tarda
 * 30-90 s; el turno espera (el SSE tiene heartbeat cada 15 s).
 *
 * Por qué este modelo (medido el 16-10-2026, misma consigna, 9:16, 720p, 6 s):
 *   grok-imagine-video-1.5-lite  USD 0,18  37 s — correcto pero genérico (no hizo
 *                                                  una cabaña) y el audio sale MUDO
 *   veo-3.1-lite + audio         USD 0,30  39 s — el mejor por precio: cabaña,
 *                                                  luz y cortinas como se pidió,
 *                                                  con sonido ambiente real
 *   hailuo-3-max (480p)          USD 0,30  26 s — lindo pero 480p y un reflejo raro
 *   seedance-1-5-pro + audio     USD 0,31  74 s — bueno, el doble de lento
 *   wan-2.6 (5 s)                USD 0,40  57 s
 *   seedance-2.0-mini            USD 0,46  88 s
 * Veo 3.1 Lite sin audio cuesta lo mismo que Grok Lite (0,03/s) y es mejor; con
 * audio 0,05/s. Animando una foto del alojamiento (primer cuadro) conserva la
 * habitación tal cual, que es el caso de uso real: "dale vida a esta foto".
 * Sólo hace 16:9 y 9:16, de 4, 6 u 8 segundos — justo lo que piden web y reels.
 */

import { createHash } from "crypto";
import { attributionHeaders } from "../../../shared/llm/provider";

export const VIDEO_MODEL = process.env.LLM_MODEL_VIDEO ?? "google/veo-3.1-lite";

const BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
)
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "") + "/v1";

/**
 * Tope de espera del job entero. Lo normal son 40-60 s. internal-api corre en
 * Vercel con funciones de 300 s: el video no puede comerse el turno entero.
 */
const TIMEOUT_MS = Number(process.env.VIDEO_GENERATION_TIMEOUT_MS ?? 150_000);
const POLL_MS = 5_000;

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export const VIDEO_DURATIONS = [4, 6, 8] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export function isVideoAspectRatio(v: unknown): v is VideoAspectRatio {
  return typeof v === "string" && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(v);
}

/** La duración más cercana que el modelo acepta (6 si no vino nada usable). */
export function normalizeVideoDuration(v: unknown): VideoDuration {
  const n = Number(v);
  if (!Number.isFinite(n)) return 6;
  return VIDEO_DURATIONS.reduce((best, d) => (Math.abs(d - n) < Math.abs(best - n) ? d : best));
}

export interface FirstFrame {
  mediaType: string;
  /** base64 sin prefijo `data:`. */
  dataB64?: string;
  /** URL pública (una imagen de la librería, o una generada antes). */
  url?: string;
}

export interface GenerateVideoInput {
  prompt: string;
  aspectRatio: VideoAspectRatio;
  durationSeconds: VideoDuration;
  withAudio: boolean;
  /** Foto a animar. Sin esto, el video se genera desde cero. */
  firstFrame?: FirstFrame;
}

export interface GenerateVideoResult {
  bytes: Buffer;
  mediaType: string;
  model: string;
  ms: number;
  /** Lo que OpenRouter informa que costó. 0 si no lo informó. */
  costUsd: number;
}

export class VideoGenerationError extends Error {
  constructor(
    message: string,
    /** `refused`: el job falló por política de contenido del proveedor. */
    public readonly code: "not_configured" | "refused" | "timeout" | "upstream" = "upstream",
  ) {
    super(message);
    this.name = "VideoGenerationError";
  }
}

/** Sin esto Veo tiende a meter subtítulos y carteles inventados. */
function buildPrompt(input: GenerateVideoInput): string {
  const lines = [input.prompt.trim(), ""];
  if (input.firstFrame) {
    lines.push("Animá esta imagen conservando el lugar, los objetos y los colores tal cual.");
  }
  lines.push("Sin texto, subtítulos, letras ni logos en pantalla salvo que el pedido lo diga explícitamente.");
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new VideoGenerationError("la generación de videos no está configurada", "not_configured");
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...attributionHeaders(),
  };

  const body: Record<string, unknown> = {
    model: VIDEO_MODEL,
    prompt: buildPrompt(input),
    duration: input.durationSeconds,
    resolution: "720p",
    aspect_ratio: input.aspectRatio,
    generate_audio: input.withAudio,
  };
  const frame = input.firstFrame;
  const frameUrl = frame?.dataB64 ? `data:${frame.mediaType};base64,${frame.dataB64}` : frame?.url;
  if (frameUrl) {
    body.frame_images = [{ type: "image_url", image_url: { url: frameUrl }, frame_type: "first_frame" }];
  }

  const t0 = Date.now();
  try {
    const submit = await fetch(`${BASE_URL}/videos`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const job = (await submit.json().catch(() => null)) as {
      id?: string;
      error?: { message?: string };
    } | null;
    if (!submit.ok || !job?.id) {
      console.warn(`[videoGeneration] submit ${submit.status}: ${job?.error?.message ?? "sin detalle"}`);
      throw new VideoGenerationError("el servicio de videos no aceptó el pedido");
    }

    for (;;) {
      if (Date.now() - t0 > TIMEOUT_MS) {
        throw new VideoGenerationError("el video tardó demasiado en generarse", "timeout");
      }
      await sleep(POLL_MS);
      const poll = await fetch(`${BASE_URL}/videos/${encodeURIComponent(job.id)}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      // Un poll que falla por red no mata el job: se reintenta en la próxima vuelta.
      if (!poll?.ok) continue;
      const st = (await poll.json().catch(() => null)) as {
        status?: string;
        unsigned_urls?: string[];
        usage?: { cost?: number };
        error?: unknown;
      } | null;
      if (!st) continue;

      if (st.status === "failed" || st.status === "cancelled" || st.status === "expired") {
        const detail = typeof st.error === "string" ? st.error : JSON.stringify(st.error ?? "");
        console.warn(`[videoGeneration] job ${st.status}: ${detail.slice(0, 300)}`);
        const refused = /safety|policy|moderat|blocked|celebrit|prohibit/i.test(detail);
        throw new VideoGenerationError(
          refused ? "el pedido no pasó el filtro de contenido del modelo" : "el modelo no pudo generar el video",
          refused ? "refused" : "upstream",
        );
      }
      if (st.status !== "completed") continue;

      const src = st.unsigned_urls?.[0];
      if (!src) throw new VideoGenerationError("el modelo no devolvió ningún video");
      const dl = await fetch(src, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!dl.ok) {
        console.warn(`[videoGeneration] descarga ${dl.status}`);
        throw new VideoGenerationError("no se pudo descargar el video generado");
      }
      return {
        bytes: Buffer.from(await dl.arrayBuffer()),
        mediaType: (dl.headers.get("content-type") ?? "video/mp4").split(";")[0],
        model: VIDEO_MODEL,
        ms: Date.now() - t0,
        costUsd: typeof st.usage?.cost === "number" ? st.usage.cost : 0,
      };
    }
  } catch (err) {
    if (err instanceof VideoGenerationError) throw err;
    if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
      throw new VideoGenerationError("el servicio de videos no respondió a tiempo", "timeout");
    }
    console.warn("[videoGeneration] falló:", (err as Error)?.message);
    throw new VideoGenerationError("el servicio de videos falló");
  }
}

export interface UploadedVideo {
  url: string;
  posterUrl: string;
  width: number;
  height: number;
  duration: number;
  bytes: number;
  format: string;
}

/**
 * Sube el video a Cloudinary con subida FIRMADA (la cuenta no tiene preset
 * unsigned). Va directo desde acá y no por `upload-base64` del PMS porque un
 * clip de 3-5 MB en base64 pasa el tope de 4,5 MB del body en Vercel; al PMS
 * sólo se le manda el registro con la URL (`POST /asset-library/files`).
 */
export async function uploadVideoToCloudinary(
  bytes: Buffer,
  mediaType: string,
  folder: string,
): Promise<UploadedVideo> {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const secret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloud || !apiKey || !secret) {
    throw new Error("Cloudinary no está configurado en el servidor");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("sha1")
    .update(`folder=${folder}&timestamp=${timestamp}${secret}`)
    .digest("hex");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), "video.mp4");
  form.append("folder", folder);
  form.append("timestamp", String(timestamp));
  form.append("api_key", apiKey);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/video/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await res.json().catch(() => null)) as {
    secure_url?: string;
    width?: number;
    height?: number;
    duration?: number;
    bytes?: number;
    format?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !json?.secure_url) {
    throw new Error(json?.error?.message ?? `Cloudinary respondió ${res.status}`);
  }
  return {
    url: json.secure_url,
    // Cloudinary sirve un cuadro del video cambiando la extensión.
    posterUrl: json.secure_url.replace(/\.[a-z0-9]+$/i, ".jpg"),
    width: json.width ?? 0,
    height: json.height ?? 0,
    duration: json.duration ?? 0,
    bytes: json.bytes ?? bytes.length,
    format: json.format ?? "mp4",
  };
}
