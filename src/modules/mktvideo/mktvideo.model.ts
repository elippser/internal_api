import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * El montaje de la voz en off del video de portada (`/{lang}/video` del sitio
 * publico).
 *
 * El video no es un archivo: es una linea de tiempo en HTML que vive en
 * `public-side/mkt-renderer`. La locucion se graba aparte y se monta encima con
 * el editor de esa misma pagina (`?edit=1`), y lo que se guarda aca es el
 * MONTAJE: que pista, que clip, cuanto silencio entre uno y otro. Los bytes del
 * audio no: esos quedan como archivos estaticos en `public/video/vo/` del
 * renderer, y aca viaja nada mas que su `src`.
 *
 * Una fila por idioma. El video dura distinto en cada uno (el tipeo del chat se
 * mide del texto real), asi que los tiempos de una locucion no sirven para otra.
 */

const clipSchema = new Schema(
  {
    /** Estable entre guardados: es lo que el editor usa para seguir cada pieza. */
    clipId: { type: String, required: true },
    /**
     * `audio` suena; `gap` es silencio. El silencio es una pieza de verdad y no
     * un hueco calculado: asi se lo puede agarrar, estirar y correr, y todo lo
     * que viene detras se mueve con el.
     */
    kind: { type: String, enum: ["audio", "gap"], required: true },
    /** Ruta publica servida por el renderer. Vacia en los `gap`. */
    src: { type: String, default: "" },
    /** El nombre del archivo que se solto, para leerlo en la pista. */
    name: { type: String, default: "" },
    /** Lo que ocupa en la pista, en ms. */
    dur: { type: Number, required: true, min: 0 },
    /** Desde donde se empieza a leer el archivo, en ms (recorte de entrada). */
    trim: { type: Number, default: 0, min: 0 },
    /** Largo real del archivo, en ms. Topea el recorte y el estirado. */
    srcDur: { type: Number, default: 0, min: 0 },
    /**
     * A que velocidad se lee el archivo (1 = natural). Es lo que hace que
     * estirar un clip sea proporcional y no un recorte: el archivo que consume
     * es `dur x rate`.
     */
    rate: { type: Number, default: 1, min: 0.25, max: 4 },
  },
  { _id: false },
);

const envPointSchema = new Schema(
  {
    at: { type: Number, required: true, min: 0 },
    /** 0 a 2: el punto medio del carril es 1, o sea el fader sin tocar. */
    v: { type: Number, required: true, min: 0, max: 2 },
  },
  { _id: false },
);

const trackSchema = new Schema(
  {
    trackId: { type: String, required: true },
    name: { type: String, default: "" },
    muted: { type: Boolean, default: false },
    /** 0 a 1. */
    volume: { type: Number, default: 1, min: 0, max: 1 },
    /** En orden: cada clip arranca donde termina el anterior. */
    clips: { type: [clipSchema], default: [] },
    /**
     * La curva de volumen de la pista: puntos { at, v } en orden, con `at` en
     * ms desde el principio del VIDEO y `v` como multiplicador del fader.
     * Vacia = plana en 1. Es lo que permite agachar la musica debajo de la voz.
     */
    env: { type: [envPointSchema], default: [] },
  },
  { _id: false },
);

const voiceoverSchema = new Schema(
  {
    /** es · en · pt · fr · de. Uno por idioma del sitio. */
    locale: { type: String, required: true, unique: true, index: true },
    tracks: { type: [trackSchema], default: [] },
    /** Lo que duraba el video cuando se guardo, para avisar si despues cambio. */
    videoMs: { type: Number, default: 0 },
    /**
     * Cuanto se estiro o se achico cada escena, como FACTOR de su duracion
     * natural (1 = sin tocar). Va por idioma junto al montaje porque el motivo
     * es el idioma: una locucion no dura lo mismo en aleman que en castellano,
     * y la escena se ajusta a la voz que le toca.
     */
    scenes: { type: Map, of: Number, default: () => ({}) },
  },
  { timestamps: true, collection: "mkt_video_voiceovers" },
);

export type MktVideoVoiceoverDoc = InferSchemaType<typeof voiceoverSchema>;
export const MktVideoVoiceover = model("MktVideoVoiceover", voiceoverSchema);
