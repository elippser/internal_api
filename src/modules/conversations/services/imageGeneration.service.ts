/**
 * Generación y edición de IMÁGENES para Roombir IA.
 *
 * El modelo del chat no dibuja: cuando el usuario pide una imagen, el chat
 * llama a la tool interna `generate_image` y esa tool le pide la imagen a un
 * modelo aparte por `chat/completions` de OpenRouter (la misma puerta que usa
 * mediaDigest.service para leer videos). La imagen vuelve en base64, se sube a
 * la librería de la empresa y la tarjeta del chat la dibuja desde Cloudinary.
 *
 * Por qué este modelo (medido el 24-09-2026, misma consigna, 4:3):
 *   recraft-v4.1-flash          USD 0,007   3 s  — flojo: dos camas donde se pidió una doble
 *   krea-2-medium-turbo         USD 0,015  16 s  — bueno, pero sólo cuadrado y por otro endpoint
 *   flux.2-klein-4b             USD 0,016   7 s  — bueno, pero un PNG de 4 MB por imagen
 *   gemini-3.1-flash-lite-image USD 0,034   5 s  — el mejor: entendió "Mendoza" (puso los Andes),
 *                                                  JPEG de ~200 KB y EDITA fotos adjuntas
 *   seedream-5-0-lite           USD 0,035  33 s
 * Cuesta el doble que flux, pero es el único barato que interpreta bien el
 * pedido y además acepta una foto del hotel para retocarla — que es la mitad de
 * los casos de uso reales ("sacale el cartel", "hacela de noche").
 */

import { attributionHeaders } from "../../../shared/llm/provider";

export const IMAGE_MODEL =
  process.env.LLM_MODEL_IMAGE ?? "google/gemini-3.1-flash-lite-image";

const BASE_URL = (
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
)
  .replace(/\/+$/, "")
  .replace(/\/v1$/, "") + "/v1";

const TIMEOUT_MS = Number(process.env.IMAGE_GENERATION_TIMEOUT_MS ?? 90_000);

/** Proporciones que el modelo respeta. Lo demás se rechaza en la validación. */
export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export function isImageAspectRatio(v: unknown): v is ImageAspectRatio {
  return typeof v === "string" && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(v);
}

export interface ReferenceImage {
  mediaType: string;
  /** base64 sin prefijo `data:`. */
  dataB64?: string;
  /** URL pública (una imagen de la librería, o una generada antes). */
  url?: string;
}

export interface GenerateImageInput {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  /** Fotos a retocar o a tomar de referencia. Vacío = imagen desde cero. */
  references?: ReferenceImage[];
}

export interface GenerateImageResult {
  dataB64: string;
  mediaType: string;
  model: string;
  ms: number;
  /** Lo que OpenRouter informa que costó. 0 si no lo informó. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    /** `refused`: el modelo contestó con texto en vez de imagen (política). */
    public readonly code: "not_configured" | "refused" | "timeout" | "upstream" = "upstream",
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

/**
 * El modelo de imagen también escribe texto, y sin instrucción tiende a
 * contestar "¡Claro! Acá tenés…" en vez de dibujar. Esto lo empuja a devolver
 * SOLO la imagen, y a no meter texto dentro de la imagen salvo que se pida.
 */
function buildInstruction(input: GenerateImageInput): string {
  const hasRefs = (input.references?.length ?? 0) > 0;
  return [
    hasRefs
      ? "Editá la imagen de referencia según este pedido, conservando todo lo que el pedido no menciona:"
      : "Generá una imagen según este pedido:",
    input.prompt.trim(),
    "",
    `Proporción ${input.aspectRatio}. Devolvé sólo la imagen.`,
    "No agregues texto, letras ni logos dentro de la imagen salvo que el pedido lo diga explícitamente.",
  ].join("\n");
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function generateImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ImageGenerationError("la generación de imágenes no está configurada", "not_configured");
  }

  const content: ContentPart[] = [];
  for (const ref of input.references ?? []) {
    const url = ref.dataB64 ? `data:${ref.mediaType};base64,${ref.dataB64}` : ref.url;
    if (url) content.push({ type: "image_url", image_url: { url } });
  }
  content.push({ type: "text", text: buildInstruction(input) });

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
        model: IMAGE_MODEL,
        modalities: ["image", "text"],
        image_config: { aspect_ratio: input.aspectRatio },
        messages: [{ role: "user", content }],
        usage: { include: true },
      }),
    });

    const json = (await res.json().catch(() => null)) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          images?: Array<{ image_url?: { url?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    } | null;

    if (!res.ok) {
      console.warn(`[imageGeneration] ${res.status}: ${json?.error?.message ?? "sin detalle"}`);
      throw new ImageGenerationError("el servicio de imágenes falló");
    }

    const msg = json?.choices?.[0]?.message;
    const dataUrl = msg?.images?.find((i) => i.image_url?.url?.startsWith("data:"))?.image_url?.url;
    const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      // Sin imagen y con texto: el modelo se negó (contenido que su política no
      // dibuja) o contestó en prosa. El texto sirve para explicarle al usuario.
      const said = (msg?.content ?? "").trim().slice(0, 300);
      console.warn(`[imageGeneration] sin imagen. texto: ${said || "(vacío)"}`);
      throw new ImageGenerationError(
        said ? `el modelo no generó la imagen: ${said}` : "el modelo no devolvió ninguna imagen",
        "refused",
      );
    }

    return {
      mediaType: match[1],
      dataB64: match[2],
      model: IMAGE_MODEL,
      ms: Date.now() - t0,
      costUsd: typeof json?.usage?.cost === "number" ? json.usage.cost : 0,
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new ImageGenerationError("la imagen tardó demasiado en generarse", "timeout");
    }
    console.warn("[imageGeneration] falló:", (err as Error)?.message);
    throw new ImageGenerationError("el servicio de imágenes falló");
  } finally {
    clearTimeout(timer);
  }
}
