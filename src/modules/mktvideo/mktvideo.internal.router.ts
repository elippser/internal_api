import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router, type Response } from "express";
import Joi from "joi";
import multer from "multer";
import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { fail, ok } from "../../shared/utils/http";
import { env, PROJECT_DIR } from "../mktproject/mktproject.service";
import { MktVideoVoiceover, ensureVideoIndexes } from "./mktvideo.model";
import { LOCALES as LOCS, VIDEOS, montajeFilter, storedLocale, videoDef, videoPath } from "./mktvideo.catalog";
import { cancelExport, getJob, lastJob, publicJob, startExport } from "./mktvideo.export";

/**
 * El modulo Videos del panel: el montaje de la voz en off del video de portada,
 * uno por idioma.
 *
 * Esto es la cara INTERNA — JWT de operador, como el resto del panel. El otro
 * router del modulo (`mktvideo.router.ts`, en `/public/mkt/video-vo`) es la
 * cara que consume el renderer para servir el video ya montado, y va con
 * `X-Internal-Secret` porque quien pregunta es un servicio, no una persona.
 *
 * Los audios NO se guardan aca: se escriben en `public/audio/` del repo del
 * renderer, que es el mismo lugar del que salen los archivos del sitio (ver
 * `mktproject.service`). Asi el video publico los sirve como estaticos y ningun
 * visitante le pega a este API.
 */
export const mktvideoRouter = Router();

mktvideoRouter.use(authenticate);
// Una vez por proceso: el índice viejo de un solo video (`locale` único) no deja montar otro video en el mismo idioma.
mktvideoRouter.use((_req, _res, next) => void ensureVideoIndexes().then(() => next(), () => next()));

const LOCALES: string[] = [...LOCS];
/** Donde viven los audios, dentro del repo del renderer. */
const AUDIO_DIR = path.join(PROJECT_DIR, "public", "audio");
/** La ruta publica con la que el renderer los sirve. */
const AUDIO_BASE = "/audio";

function handleErr(res: Response, err: any) {
  const status = err?.status ?? 500;
  if (status >= 500) console.error("[mktvideo/internal]", err);
  return fail(res, status, err?.message ?? "Error interno", err?.code);
}

/** Sube un WAV de tres minutos sin chistar. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

const EXT: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
};

/**
 * El nombre con el que se guarda. Se conserva legible —en la pista se lee— pero
 * saneado: viene del disco de quien lo sube y termina siendo una ruta nuestra.
 */
function safeName(original: string, ext: string): string {
  const base = path
    .basename(original, path.extname(original))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return `${base || "audio"}${ext}`;
}

// ---------------------------------------------------------------------------
// La lista de videos
// ---------------------------------------------------------------------------

/**
 * Un renglon por idioma. Hoy hay UN video —el de portada— en cinco variantes;
 * la lista esta armada para que agregar otro sea agregar filas, no rehacerla.
 */
mktvideoRouter.get("/", authorize("analyst"), async (_req, res) => {
  try {
    const docs = await MktVideoVoiceover.find({}).lean();
    // La portada guarda el idioma pelado; los demás, `<video>:<idioma>` (ver storedLocale).
    const porClave = new Map(docs.map((d: any) => [String(d.locale).includes(":") ? d.locale : `portada:${d.locale}`, d]));
    const clave = (videoId: string, locale: string) => `${videoId}:${locale}`;

    // Un renglón por video y por idioma; el panel los agrupa por video.
    const data = VIDEOS.flatMap((v) =>
      LOCALES.map((locale) => {
        const d: any = porClave.get(clave(v.id, locale));
        const tracks = d?.tracks ?? [];
        const clips = tracks.reduce((a: number, t: any) => a + (t.clips?.length ?? 0), 0);
        const audios = tracks.reduce((a: number, t: any) => a + (t.clips ?? []).filter((c: any) => c.kind === "audio").length, 0);
        // El largo del montaje: la pista más larga.
        const montajeMs = tracks.reduce((max: number, t: any) => Math.max(max, (t.clips ?? []).reduce((a: number, c: any) => a + c.dur, 0)), 0);
        return {
          videoId: v.id,
          title: v.title,
          locale,
          path: videoPath(v.id, locale),
          tracks: tracks.length,
          clips,
          audios,
          montajeMs,
          videoMs: d?.videoMs ?? 0,
          scenes: d?.scenes ? Object.keys(d.scenes).length : 0,
          updatedAt: d ? d.updatedAt : null,
        };
      }),
    );

    return ok(res, { data, videos: VIDEOS.map(({ id, title }) => ({ id, title })), rendererUrl: env("MKT_RENDERER_URL", "http://localhost:6300") });
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Los audios disponibles
// ---------------------------------------------------------------------------

/**
 * Lo que hay en `public/audio/` del renderer, con su marca de tiempo.
 *
 * La marca importa: reemplazar un archivo por otro del mismo nombre no cambia
 * su ruta, asi que sin ella el navegador sigue sirviendo el viejo de su cache.
 * El editor se la pega a la URL (`?v=`).
 */
mktvideoRouter.get("/audio", authorize("analyst"), async (_req, res) => {
  try {
    await mkdir(AUDIO_DIR, { recursive: true });
    const nombres = await readdir(AUDIO_DIR);
    const data = (
      await Promise.all(
        nombres
          .filter((n) => Object.values(EXT).includes(path.extname(n).toLowerCase()))
          .map(async (name) => {
            const st = await stat(path.join(AUDIO_DIR, name));
            return { name, src: `${AUDIO_BASE}/${name}`, v: Math.round(st.mtimeMs), size: st.size };
          }),
      )
    ).sort((a, b) => a.name.localeCompare(b.name));
    return ok(res, { data, dir: AUDIO_DIR });
  } catch (err) {
    return handleErr(res, err);
  }
});

/** Sube un audio al repo del renderer. Pisa el del mismo nombre a proposito. */
mktvideoRouter.post("/audio", authorize("developer"), upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return fail(res, 400, "Falta el archivo", "missing_file");

  const ext = EXT[file.mimetype];
  if (!ext) return fail(res, 415, `Tipo no soportado: ${file.mimetype}`, "unsupported_type");

  const name = safeName(file.originalname || "audio", ext);
  try {
    await mkdir(AUDIO_DIR, { recursive: true });
    await writeFile(path.join(AUDIO_DIR, name), file.buffer);
    const st = await stat(path.join(AUDIO_DIR, name));
    return ok(
      res,
      { name, src: `${AUDIO_BASE}/${name}`, v: Math.round(st.mtimeMs), size: st.size },
      201,
    );
  } catch (err) {
    return handleErr(res, err);
  }
});

// ---------------------------------------------------------------------------
// Exportar a MP4
// ---------------------------------------------------------------------------

/**
 * Exportar el video de un idioma a un MP4 con su audio (ver `mktvideo.export.ts`).
 * Arrancar devuelve el trabajo enseguida; el editor lo consulta cada segundo y,
 * cuando termina, baja el archivo por `/exports/:id/file` con el mismo token.
 */
mktvideoRouter.get("/exports/:id", authorize("analyst"), (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) return fail(res, 404, "No existe esa exportación", "export_not_found");
  return ok(res, publicJob(job));
});

mktvideoRouter.get("/exports/:id/file", authorize("analyst"), async (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job?.file || job.phase !== "done") return fail(res, 404, "La exportación no tiene archivo", "export_not_ready");
  try {
    const st = await stat(job.file);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(job.file)}"`);
    res.setHeader("Cache-Control", "no-store");
    createReadStream(job.file).pipe(res);
  } catch (err) {
    return handleErr(res, err);
  }
});

mktvideoRouter.delete("/exports/:id", authorize("developer"), (req, res) => {
  const job = cancelExport(String(req.params.id));
  if (!job) return fail(res, 404, "No existe esa exportación", "export_not_found");
  return ok(res, publicJob(job));
});

/** Valida video + idioma. Devuelve el error ya respondido, o null. */
function params(req: any, res: Response): { video: string; locale: string } | null {
  const video = String(req.params.video ?? "portada");
  const locale = String(req.params.locale);
  if (!videoDef(video)) {
    fail(res, 404, "Video desconocido", "invalid_video");
    return null;
  }
  if (!LOCALES.includes(locale)) {
    fail(res, 400, "Idioma desconocido", "invalid_locale");
    return null;
  }
  return { video, locale };
}

// La exportación a MP4 es sólo del video de portada (pedido del usuario: los videos de producto no se exportan).
mktvideoRouter.get("/:locale/export", authorize("analyst"), (req, res) => {
  const locale = String(req.params.locale);
  if (!LOCALES.includes(locale)) return fail(res, 400, "Idioma desconocido", "invalid_locale");
  const job = lastJob(locale);
  return ok(res, { job: job ? publicJob(job) : null });
});

mktvideoRouter.post("/:locale/export", authorize("developer"), (req, res) => {
  const locale = String(req.params.locale);
  if (!LOCALES.includes(locale)) return fail(res, 400, "Idioma desconocido", "invalid_locale");
  // Sin opciones: siempre 1920 × 1080 a 60 cuadros (ver `EXPORT_FPS`).
  return ok(res, publicJob(startExport(locale)), 202);
});

// ---------------------------------------------------------------------------
// El montaje de un idioma
// ---------------------------------------------------------------------------

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
  scenes: Joi.object().pattern(/^[a-z]+$/, Joi.number().min(0.35).max(3)).default({}),
  videoMs: Joi.number().min(0).default(0),
  /**
   * El `updatedAt` que el editor leyo al abrir. Si no coincide, alguien escribio
   * mientras tanto y este guardado se rechaza en vez de pisarlo.
   */
  expectedUpdatedAt: Joi.string().isoDate().allow(null, ""),
});

const respuesta = (locale: string, doc: any) => ({
  locale,
  tracks: doc?.tracks ?? [],
  scenes: doc?.scenes ?? {},
  videoMs: doc?.videoMs ?? 0,
  updatedAt: doc ? doc.updatedAt : null,
});

const leer = async (req: any, res: Response) => {
  const p = params(req, res);
  if (!p) return;
  try {
    return ok(res, respuesta(p.locale, await MktVideoVoiceover.findOne(montajeFilter(p.video, p.locale)).lean()));
  } catch (err) {
    return handleErr(res, err);
  }
};

const guardar = async (req: any, res: Response) => {
  const p = params(req, res);
  if (!p) return;
  const { error, value } = bodySchema.validate(req.body, { stripUnknown: true });
  if (error) return fail(res, 400, error.message, "invalid_body");
  const filtro = montajeFilter(p.video, p.locale);
  try {
    if (value.expectedUpdatedAt) {
      const actual = await MktVideoVoiceover.findOne(filtro).lean();
      const sello = actual ? new Date((actual as any).updatedAt).toISOString() : null;
      if (sello && sello !== new Date(value.expectedUpdatedAt).toISOString()) {
        return fail(res, 409, "El montaje cambio desde que se abrio", "stale_write");
      }
    }
    const doc = await MktVideoVoiceover.findOneAndUpdate(
      filtro,
      { $set: { videoId: p.video, locale: storedLocale(p.video, p.locale), tracks: value.tracks, scenes: value.scenes, videoMs: value.videoMs } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return ok(res, respuesta(p.locale, doc));
  } catch (err) {
    return handleErr(res, err);
  }
};

mktvideoRouter.get("/:locale", authorize("analyst"), leer);
mktvideoRouter.put("/:locale", authorize("developer"), guardar);
mktvideoRouter.get("/:video/:locale", authorize("analyst"), leer);
mktvideoRouter.put("/:video/:locale", authorize("developer"), guardar);
