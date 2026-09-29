import { Router, type Response } from "express";
import Joi from "joi";
import { requireInternalSecret } from "../../shared/middleware/internalSecret";
import { fail, ok } from "../../shared/utils/http";
import { MktVideoVoiceover } from "./mktvideo.model";
// El GET y el PUT de un segmento son del video de PORTADA; el GET de dos segmentos (video/idioma) lee los demás.
import { montajeFilter, videoDef } from "./mktvideo.catalog";

/**
 * El montaje de la voz en off del video de portada.
 *
 * Lo consume el editor de `/{lang}/video?edit=1` del sitio publico, pero NUNCA
 * desde el navegador: las API routes de `mkt-renderer` hacen el rodeo del lado
 * del servidor y ponen el `X-Internal-Secret`. Por eso esto no lleva JWT de
 * operador —el renderer no tiene sesion de nadie— y tampoco queda abierto: sin
 * el secreto no se lee ni se escribe.
 *
 * Se monta fuera de `/api/v1`, con el resto de la superficie que consume el
 * sitio (`/public/mkt/...`).
 */
export const publicVideoVoRouter = Router();

publicVideoVoRouter.use(requireInternalSecret);

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[mktvideo]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

const LOCALES = ["es", "en", "pt", "fr", "de"];

const clipSchema = Joi.object({
  clipId: Joi.string().max(60).required(),
  kind: Joi.string().valid("audio", "gap").required(),
  src: Joi.string().max(400).allow("").default(""),
  name: Joi.string().max(300).allow("").default(""),
  dur: Joi.number().min(0).max(30 * 60_000).required(),
  trim: Joi.number().min(0).max(30 * 60_000).default(0),
  srcDur: Joi.number().min(0).max(30 * 60_000).default(0),
  rate: Joi.number().min(0.25).max(4).default(1),
});

const bodySchema = Joi.object({
  tracks: Joi.array()
    .max(24)
    .items(
      Joi.object({
        trackId: Joi.string().max(60).required(),
        name: Joi.string().max(120).allow("").default(""),
        muted: Joi.boolean().default(false),
        volume: Joi.number().min(0).max(1).default(1),
        clips: Joi.array().max(500).items(clipSchema).default([]),
        env: Joi.array()
          .max(400)
          .items(
            Joi.object({
              at: Joi.number().min(0).max(30 * 60_000).required(),
              v: Joi.number().min(0).max(2).required(),
            }),
          )
          .default([]),
      }),
    )
    .required(),
  videoMs: Joi.number().min(0).default(0),
  /** Factor por escena. Los topes son los mismos que aplica el editor. */
  scenes: Joi.object().pattern(/^[a-z]+$/, Joi.number().min(0.35).max(3)).default({}),
  /**
   * El `updatedAt` que el editor leyó al abrir. Si no coincide con el de la
   * base, alguien escribió mientras tanto y este guardado se rechaza.
   */
  expectedUpdatedAt: Joi.string().isoDate().allow(null, ""),
});

/** El montaje de un idioma. Si todavia no hay ninguno devuelve la estructura vacia. */
publicVideoVoRouter.get("/:locale", async (req, res) => {
  const locale = String(req.params.locale);
  if (!LOCALES.includes(locale)) {
    return fail(res, 400, "Idioma desconocido", "invalid_locale");
  }
  try {
    const doc = await MktVideoVoiceover.findOne(montajeFilter("portada", locale)).lean();
    return ok(res, {
      locale,
      tracks: doc?.tracks ?? [],
      videoMs: doc?.videoMs ?? 0,
      scenes: doc?.scenes ?? {},
      updatedAt: doc ? (doc as any).updatedAt : null,
    });
  } catch (err) {
    return handleErr(res, err);
  }
});

/**
 * El montaje de los OTROS videos (ia, propiedades, habitaciones, motor…), para su reproductor público.
 * Sólo lectura: se escriben desde el panel (`mktvideo.internal.router.ts`), nunca desde el sitio.
 */
publicVideoVoRouter.get("/:video/:locale", async (req, res) => {
  const video = String(req.params.video);
  const locale = String(req.params.locale);
  if (!videoDef(video) || video === "portada") return fail(res, 404, "Video desconocido", "invalid_video");
  if (!LOCALES.includes(locale)) return fail(res, 400, "Idioma desconocido", "invalid_locale");
  try {
    const doc = await MktVideoVoiceover.findOne(montajeFilter(video, locale)).lean();
    return ok(res, {
      video,
      locale,
      tracks: doc?.tracks ?? [],
      videoMs: doc?.videoMs ?? 0,
      scenes: doc?.scenes ?? {},
      updatedAt: doc ? (doc as any).updatedAt : null,
    });
  } catch (err) {
    return handleErr(res, err);
  }
});

/**
 * Guarda el montaje entero de un idioma. Es un reemplazo, no un parche: el
 * editor tiene el estado completo en la mano y mandar diffs de una linea de
 * tiempo que se arrastra con el mouse solo agrega formas de quedar a medias.
 *
 * Que sea un reemplazo obliga a lo otro: `expectedUpdatedAt`. El editor lee la
 * base UNA vez, al abrir, y despues guarda lo que tiene en la mano; una pestana
 * que quedo abierta desde antes de un cambio pisaba en silencio todo lo
 * escrito mientras tanto (paso: una pestana vieja borro el montaje de `es`
 * entero). Con el sello, ese guardado se rechaza con 409 y se devuelve lo que
 * hay, para que el editor se ponga al dia en vez de destruirlo.
 */
publicVideoVoRouter.put("/:locale", async (req, res) => {
  const locale = String(req.params.locale);
  if (!LOCALES.includes(locale)) {
    return fail(res, 400, "Idioma desconocido", "invalid_locale");
  }
  const { error, value } = bodySchema.validate(req.body, { stripUnknown: true });
  if (error) return fail(res, 400, error.message, "invalid_body");

  try {
    if (value.expectedUpdatedAt) {
      const actual = await MktVideoVoiceover.findOne(montajeFilter("portada", locale)).lean();
      const sello = actual ? new Date((actual as any).updatedAt).toISOString() : null;
      if (sello && sello !== new Date(value.expectedUpdatedAt).toISOString()) {
        return fail(res, 409, "El montaje cambio desde que se abrio", "stale_write");
      }
    }

    const doc = await MktVideoVoiceover.findOneAndUpdate(
      montajeFilter("portada", locale),
      { $set: { tracks: value.tracks, videoMs: value.videoMs, scenes: value.scenes } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return ok(res, {
      locale,
      tracks: doc?.tracks ?? [],
      videoMs: doc?.videoMs ?? 0,
      scenes: doc?.scenes ?? {},
      updatedAt: doc ? (doc as any).updatedAt : null,
    });
  } catch (err) {
    return handleErr(res, err);
  }
});
