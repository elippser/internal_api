import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { env, PROJECT_DIR } from "../mktproject/mktproject.service";
import { MktVideoVoiceover } from "./mktvideo.model";
import { montajeFilter } from "./mktvideo.catalog";

/**
 * Exportar el video de portada a un MP4, con su voz y su música.
 *
 * Por qué existe: el editor y el sitio reproducen el video EN VIVO —24 escenas
 * de HTML y CSS dibujadas por el navegador a medida que corre el reloj—, y
 * cuando una escena pesa más de lo que el navegador dibuja en 16 ms se traba
 * la imagen y el audio se corre. Acá el reloj no corre solo: se abre el video
 * embebido en un Chromium sin ventana, se lo lleva a cada instante, se espera a
 * que esté dibujado del todo y recién ahí se saca la foto. Una escena pesada
 * tarda más en exportarse, pero en el archivo sale perfecta.
 *
 * Tres pasos, y cada uno tiene su fase en el trabajo:
 * 1. **Cuadros**: la página `/{lang}/video?embed=1` del renderer, las escalas
 *    de escena del montaje, y una captura PNG por cuadro que va directo a
 *    ffmpeg por stdin (no se guarda ningún PNG en disco).
 * 2. **Audio**: el montaje de la base traducido a un grafo de ffmpeg con la
 *    MISMA lógica que el editor (`videoModel.ts` del panel): piezas pegadas en
 *    orden, `trim`, velocidad (`atempo`, que no cambia el tono, como
 *    `preservesPitch`), la cola muda cuando el archivo se acaba, el fader de la
 *    pista y la curva de volumen.
 * 3. **Unión**: video copiado tal cual + audio en AAC.
 *
 * Sólo LEE el montaje. No escribe nada en la base.
 *
 * Los trabajos viven en memoria y se hacen de a uno: dos exportaciones a la vez
 * se pelearían la CPU y tardarían lo mismo que en fila. Si el API se reinicia,
 * el trabajo en curso se pierde (el archivo terminado queda en disco).
 */

// ---------------------------------------------------------------------------
// El montaje, tal como lo guarda el editor
// ---------------------------------------------------------------------------

type Clip = {
  clipId: string;
  kind: "audio" | "gap";
  src: string;
  dur: number;
  trim: number;
  srcDur: number;
  rate?: number;
};
type Track = { trackId: string; name: string; muted: boolean; volume: number; clips: Clip[]; env?: { at: number; v: number }[] };

const rateOf = (c: Clip) => (c.rate && c.rate > 0 ? c.rate : 1);

// ---------------------------------------------------------------------------
// Los trabajos
// ---------------------------------------------------------------------------

export type ExportPhase = "queued" | "opening" | "warming" | "frames" | "audio" | "done" | "error" | "cancelled";

export type ExportJob = {
  id: string;
  locale: string;
  fps: number;
  height: number;
  phase: ExportPhase;
  /** Cuadros capturados / cuadros totales. */
  done: number;
  total: number;
  videoMs: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Lo que no impidió exportar pero conviene saber (un audio que no está en disco). */
  warnings: string[];
  size: number;
  /** El nombre del archivo, para descargarlo. */
  file: string | null;
  /** Dónde quedó en el disco de la máquina del API. */
  ruta: string | null;
};

type Interno = ExportJob & { cancelado: boolean; hijo: ChildProcess | null; browser: Browser | null };

const jobs = new Map<string, Interno>();
let cola: Promise<void> = Promise.resolve();

/** Donde se trabaja: el video sin audio y el grafo. Se borra al terminar. */
const OUT_DIR = path.join(os.tmpdir(), "roombir-video-exports");
/**
 * Donde queda el MP4 terminado, a la vista: un archivo por idioma
 * (`roombir-video-de.mp4`) que cada exportación nueva reemplaza. Fuera del repo
 * del renderer porque pesa decenas de MB y no es del sitio. Se cambia con
 * `VIDEO_EXPORT_DIR`.
 */
const DEST_DIR = () => env("VIDEO_EXPORT_DIR", path.join(os.homedir(), "Videos", "Roombir"));
const AUDIO_DIR = path.join(PROJECT_DIR, "public", "audio");

export function publicJob(j: Interno | ExportJob): ExportJob {
  const { id, locale, fps, height, phase, done, total, videoMs, startedAt, finishedAt, error, warnings, size, file } = j;
  return { id, locale, fps, height, phase, done, total, videoMs, startedAt, finishedAt, error, warnings, size, file: file ? path.basename(file) : null, ruta: file };
}

export const getJob = (id: string) => jobs.get(id) ?? null;

/** El último trabajo de un idioma: el editor lo muestra al abrir, esté corriendo o terminado. */
export function lastJob(locale: string): Interno | null {
  let ultimo: Interno | null = null;
  for (const j of jobs.values()) if (j.locale === locale && (!ultimo || j.startedAt > ultimo.startedAt)) ultimo = j;
  return ultimo;
}

const activo = (j: Interno) => j.phase !== "done" && j.phase !== "error" && j.phase !== "cancelled";

/**
 * Siempre 1920 × 1080 a 60 cuadros: el usuario lo pidió así ("todos en 60 fps,
 * ni uno menos en ninguna escena"), y como cada cuadro se espera dibujado, una
 * escena pesada no pierde ninguno — sólo tarda más en exportarse.
 */
export const EXPORT_FPS = 60;
export const EXPORT_HEIGHT = 1080;

export function startExport(locale: string): Interno {
  const previo = lastJob(locale);
  if (previo && activo(previo)) return previo;

  const job: Interno = {
    id: randomUUID(),
    locale,
    fps: EXPORT_FPS,
    height: EXPORT_HEIGHT,
    phase: "queued",
    done: 0,
    total: 0,
    videoMs: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    warnings: [],
    size: 0,
    file: null,
    ruta: null,
    cancelado: false,
    hijo: null,
    browser: null,
  };
  jobs.set(job.id, job);
  cola = cola.then(() => correr(job)).catch(() => undefined);
  return job;
}

export function cancelExport(id: string): Interno | null {
  const job = jobs.get(id);
  if (!job || !activo(job)) return job ?? null;
  job.cancelado = true;
  job.hijo?.kill("SIGKILL");
  void job.browser?.close().catch(() => undefined);
  if (job.phase === "queued") terminar(job, "cancelled");
  return job;
}

function terminar(job: Interno, phase: ExportPhase, error?: string) {
  job.phase = phase;
  job.error = error ?? null;
  job.finishedAt = new Date().toISOString();
  job.hijo = null;
}

class Cancelado extends Error {}

async function correr(job: Interno): Promise<void> {
  if (job.cancelado) return terminar(job, "cancelled");
  const dir = path.join(OUT_DIR, job.id);
  try {
    await mkdir(dir, { recursive: true });
    // Sólo el video de portada se exporta: con varios videos por idioma en la colección, el filtro lo fija.
    const doc: any = await MktVideoVoiceover.findOne(montajeFilter("portada", job.locale)).lean();
    const tracks: Track[] = doc?.tracks ?? [];
    const scenes: Record<string, number> = doc?.scenes ?? {};

    const soloVideo = path.join(dir, "video.mp4");
    await renderFrames(job, scenes, soloVideo);
    if (job.cancelado) throw new Cancelado();

    job.phase = "audio";
    const final = path.join(dir, `roombir-video-${job.locale}.mp4`);
    await mezclarYUnir(job, tracks, soloVideo, final, dir);
    if (job.cancelado) throw new Cancelado();

    // A la carpeta a la vista. Si el archivo anterior está abierto en un
    // reproductor, Windows no deja pisarlo: se deja el nuevo donde está y se avisa.
    let destino = final;
    try {
      await mkdir(DEST_DIR(), { recursive: true });
      const aVista = path.join(DEST_DIR(), path.basename(final));
      await copyFile(final, aVista);
      destino = aVista;
    } catch (err: any) {
      job.warnings.push(`No se pudo guardar en ${DEST_DIR()} (${err?.code ?? err?.message}): ¿está abierto el MP4 anterior? Quedó en ${final}`);
    }
    job.file = destino;
    job.size = (await stat(destino)).size;
    terminar(job, "done");
    await limpiarViejos(job);
  } catch (err: any) {
    if (job.cancelado || err instanceof Cancelado) {
      terminar(job, "cancelled");
    } else {
      console.error("[mktvideo/export]", err);
      terminar(job, "error", String(err?.message ?? err).slice(0, 600));
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    // El navegador se cierra SIEMPRE, también si falló a mitad de los cuadros.
    await job.browser?.close().catch(() => undefined);
    job.browser = null;
  }
}

/**
 * Limpia la carpeta de TRABAJO (la temporal), nunca la de destino: ahí sólo
 * queda algo de este trabajo si no se pudo copiar a la vista, y de los
 * anteriores, lo que dejó una corrida cortada del API.
 */
async function limpiarViejos(job: Interno) {
  const conservar = new Set<string>();
  for (const j of jobs.values()) {
    if (activo(j)) conservar.add(j.id);
    if (j.file && path.dirname(path.dirname(j.file)) === OUT_DIR) conservar.add(path.basename(path.dirname(j.file)));
  }
  for (const nombre of await readdir(OUT_DIR).catch(() => [] as string[])) {
    if (!conservar.has(nombre)) await rm(path.join(OUT_DIR, nombre), { recursive: true, force: true }).catch(() => undefined);
  }
  void job;
}

// ---------------------------------------------------------------------------
// 1 · Los cuadros
// ---------------------------------------------------------------------------

const FFMPEG = () => env("FFMPEG_PATH", "ffmpeg");

/**
 * Qué Chromium usar. `playwright-core` 1.57 pide EXACTAMENTE su build (1200) y
 * en esta máquina está el 1243 de otra versión de Playwright: se busca el más
 * nuevo que haya en la carpeta de navegadores de Playwright. Con
 * `VIDEO_EXPORT_CHROMIUM` se fuerza uno (un chrome.exe cualquiera sirve).
 * Si no hay ninguno, `undefined` deja que Playwright use el suyo.
 */
function buscarChromium(): string | undefined {
  if (process.env.VIDEO_EXPORT_CHROMIUM) return process.env.VIDEO_EXPORT_CHROMIUM;
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));
  let carpetas: string[] = [];
  try {
    carpetas = readdirSync(base);
  } catch {
    return undefined;
  }
  const exes: [RegExp, string[]][] = [
    [/^chromium-(\d+)$/, ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]],
    [/^chromium_headless_shell-(\d+)$/, ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell"]],
  ];
  for (const [re, rutas] of exes) {
    const builds = carpetas
      .map((c) => ({ c, n: Number(re.exec(c)?.[1] ?? NaN) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => b.n - a.n);
    for (const { c } of builds) {
      for (const r of rutas) {
        const p = path.join(base, c, r);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/*
 * Lo que corre ADENTRO de la página va como texto: este API compila para Node,
 * sin los tipos del navegador, y Playwright acepta el código igual.
 */

/** Escucha lo que avisa el embed: los beats (`vo:ready`) y cada instante ya dibujado (`vo:drawn`). */
const INIT_JS = `
  window.__voReadyN = 0;
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "vo:ready") { window.__voReady = m; window.__voReadyN += 1; }
    else if (m.type === "vo:drawn" && window.__onDrawn) window.__onDrawn(m.t);
  });
`;

/*
 * El paso de un cuadro:
 * 1. se manda el instante y se espera el aviso `vo:drawn` del embed (sale de
 *    un layout effect, o sea con el DOM ya cambiado);
 * 2. las animaciones CSS se pausan y se llevan a mano a su tiempo: corren con
 *    el reloj del VIDEO, no con el de la pared, así que salen iguales aunque
 *    el cuadro haya tardado 300 ms en dibujarse;
 * 3. se esperan las imágenes que todavía estén bajando, y un cuadro más para
 *    que todo eso llegue a pintarse.
 */
const FRAME_JS = `
  (() => {
    const nacio = new WeakMap();
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    window.__frame = async (t) => {
      await new Promise((res) => {
        const listo = setTimeout(res, 1500);
        window.__onDrawn = (dt) => { if (dt === t) { clearTimeout(listo); res(); } };
        window.postMessage({ type: "vo:frame", t, epoch: 0, paused: false }, "*");
      });
      await raf();
      for (const a of document.getAnimations()) {
        if (!nacio.has(a)) { nacio.set(a, t); a.pause(); }
        a.currentTime = Math.max(0, t - nacio.get(a));
      }
      const pendientes = [...document.images].filter((i) => !i.complete);
      if (pendientes.length) {
        await Promise.all(pendientes.map((i) => new Promise((r) => {
          i.addEventListener("load", () => r(), { once: true });
          i.addEventListener("error", () => r(), { once: true });
          setTimeout(r, 4000);
        })));
      }
      await raf();
      return true;
    };
  })();
`;

async function renderFrames(job: Interno, scenes: Record<string, number>, salida: string) {
  job.phase = "opening";
  const height = job.height;
  const width = Math.round((height * 16) / 9);

  try {
    job.browser = await chromium.launch({ executablePath: buscarChromium(), headless: true });
  } catch (err: any) {
    throw new Error(
      `No se pudo abrir Chromium para exportar (${String(err?.message ?? err).split("\n")[0]}). ` +
        "Hace falta el navegador de Playwright 1.57 instalado, o VIDEO_EXPORT_CHROMIUM apuntando a un chrome.exe.",
    );
  }
  if (job.cancelado) throw new Cancelado();

  // Viewport del tamaño final con densidad 1: el escenario se ajusta solo
  // (1280 × 720 escalado), y Chrome lo rasteriza ya a ese tamaño. Con densidad
  // 1,5 sobre 1280 la captura directa salía de 1280 igual.
  const ctx = await job.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript({ content: INIT_JS });
  const page = await ctx.newPage();
  const url = `${env("MKT_RENDERER_URL", "http://localhost:6300")}/${job.locale}/video?embed=1`;
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction("!!window.__voReady", undefined, { timeout: 60_000 });
  } catch {
    throw new Error(`El renderer no contestó en ${url}. ¿Está corriendo el mkt-renderer?`);
  }
  // El botón de las herramientas de Next (sólo en desarrollo) no va en el video.
  await page.addStyleTag({ content: "nextjs-portal, #__next-build-watcher, [data-nextjs-toast] { display: none !important; }" });

  // Las escalas de escena del montaje: sin ellas el video dura lo natural y la
  // voz, montada sobre las escenas estiradas, no coincide.
  const n0 = (await page.evaluate("window.__voReadyN")) as number;
  await page.evaluate(`window.postMessage({ type: "vo:scenes", scenes: ${JSON.stringify(scenes)} }, "*")`);
  await page.waitForFunction(`window.__voReadyN > ${n0}`, undefined, { timeout: 10_000 }).catch(() => undefined);
  const total = (await page.evaluate("window.__voReady.total")) as number;
  job.videoMs = total;
  const N = Math.ceil((total / 1000) * job.fps);
  job.total = N;

  // Una pasada rápida por todo el video: monta cada escena una vez para que sus
  // imágenes y fuentes queden bajadas antes de sacar la primera foto. Si no, la
  // primera vez que aparece un ícono sale el hueco.
  job.phase = "warming";
  for (let t = 0; t < total; t += 400) {
    if (job.cancelado) throw new Cancelado();
    await page.evaluate(`window.postMessage({ type: "vo:frame", t: ${t}, epoch: 0, paused: false }, "*")`);
    await page.waitForTimeout(25);
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate("document.fonts.ready.then(() => true)");
  await page.evaluate(FRAME_JS);

  const cdp = await ctx.newCDPSession(page);
  job.phase = "frames";
  const ff = spawn(
    FFMPEG(),
    [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "image2pipe", "-c:v", "png", "-framerate", String(job.fps), "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-r", String(job.fps), salida,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  job.hijo = ff;
  let errFf = "";
  ff.stderr?.on("data", (d) => (errFf = (errFf + String(d)).slice(-2000)));
  const salio = new Promise<number>((res, rej) => {
    ff.on("error", (e) => rej(new Error(`No se pudo correr ffmpeg (${e.message}). ¿Está instalado? Se puede apuntar con FFMPEG_PATH.`)));
    ff.on("close", (code) => res(code ?? 0));
  });
  // Si ffmpeg muere, que no quede la captura escribiendo a un caño cerrado.
  ff.stdin!.on("error", () => undefined);

  for (let k = 0; k < N; k++) {
    if (job.cancelado) break;
    const t = Math.min(total - 1, Math.round((k * 1000) / job.fps));
    await page.evaluate(`window.__frame(${t})`);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
    if (!ff.stdin!.write(Buffer.from(data, "base64"))) await once(ff.stdin!, "drain");
    job.done = k + 1;
  }
  ff.stdin!.end();
  const code = await salio;
  job.hijo = null;
  await job.browser?.close().catch(() => undefined);
  job.browser = null;
  if (job.cancelado) throw new Cancelado();
  if (code !== 0) throw new Error(`ffmpeg falló al codificar el video: ${errFf.trim() || `código ${code}`}`);
}

// ---------------------------------------------------------------------------
// 2 · El audio
// ---------------------------------------------------------------------------

const seg = (ms: number) => (ms / 1000).toFixed(4);
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(5));

/** `atempo` va de 0,5 a 100: por debajo de 0,5 se encadena (0,25 = 0,5 × 0,5). */
function tempo(rate: number): string {
  if (Math.abs(rate - 1) < 1e-6) return "";
  const pasos: number[] = [];
  let r = rate;
  while (r < 0.5) {
    pasos.push(0.5);
    r /= 0.5;
  }
  pasos.push(r);
  return pasos.map((p) => `,atempo=${num(p)}`).join("");
}

/**
 * El instante del cuadro de audio. `volume` lo da en NaN cuando el cuadro no
 * trae marca de tiempo (pasa con los primeros después de un `adelay`), y NaN
 * en la curva deja la ganancia inválida: ffmpeg la baja a 0 y avisa.
 */
const T = "if(isnan(t),0,t)";

/**
 * La ganancia de la pista como expresión de ffmpeg: el fader por la curva, entre
 * 0 y 1, igual que `gainAt` del editor.
 *
 * La curva no se arma con `if` anidados —con cientos de puntos la expresión se
 * hunde—: una curva lineal por tramos es el primer valor más una rampa por
 * tramo, cada una recortada entre 0 y 1. Antes del primer punto vale el
 * primero, después del último vale el último, y dos puntos en el mismo instante
 * son un salto.
 */
function ganancia(track: Track): string {
  const vol = Math.max(0, track.volume ?? 1);
  const pts = [...(track.env ?? [])].sort((a, b) => a.at - b.at);
  if (!pts.length) return num(Math.min(1, vol));
  const partes = [num(pts[0].v)];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dv = b.v - a.v;
    if (Math.abs(dv) < 1e-9) continue;
    const span = b.at - a.at;
    partes.push(
      span <= 0
        ? `${num(dv)}*gte(${T},${seg(b.at)})`
        : `${num(dv)}*clip((${T}-${seg(a.at)})/${seg(span)},0,1)`,
    );
  }
  return `min(1,max(0,${num(vol)}*(${partes.join("+")})))`;
}

/** La ruta en disco de un `src` del montaje (`/audio/voz.mp3?v=…`). */
function archivo(src: string): string | null {
  const limpio = decodeURIComponent((src || "").split("?")[0]);
  if (!limpio.startsWith("/audio/")) return null;
  const p = path.join(AUDIO_DIR, path.basename(limpio));
  return p.startsWith(AUDIO_DIR) && existsSync(p) ? p : null;
}

/**
 * Arma el grafo de ffmpeg del montaje. La entrada 0 es el video; cada fragmento
 * de audio es SU PROPIA entrada, decodificada desde el principio y recortada con
 * `atrim`, que corta por muestra. No se abre ya posicionada (`-ss` antes del
 * `-i`): en un MP3 ffmpeg estima la posición por el bitrate y un fragmento
 * puede caer decenas de ms corrido. Decodificar MP3 es rapidísimo, así que
 * leerlo entero por cada fragmento no se nota.
 *
 * No se abre cada archivo una vez y se reparte con `asplit`: con quince
 * fragmentos de la misma voz, el primero terminaba a los 2,7 s y ffmpeg daba
 * por terminada la mezcla entera ahí — el MP4 salía con 2,7 s de audio.
 * Además cada rama con un `adelay` largo obligaba a guardar en memoria todo el
 * archivo decodificado hasta que le tocara.
 */
export function grafoDeAudio(tracks: Track[], totalMs: number, warnings: string[] = []) {
  const entradas: string[][] = [];
  const lineas: string[] = [];
  const pistas: string[] = [];

  tracks.forEach((track, k) => {
    if (track.muted || !(track.volume > 0)) return;
    const clips: string[] = [];
    let at = 0;
    for (const clip of track.clips ?? []) {
      const start = at;
      at += clip.dur;
      if (clip.kind !== "audio" || !clip.src || start >= totalMs) continue;
      const file = archivo(clip.src);
      if (!file) {
        warnings.push(`No está en disco: ${clip.src} (pista "${track.name}")`);
        continue;
      }
      const rate = rateOf(clip);
      // Lo que el clip tiene CON sonido: si el archivo se acaba antes, el resto es
      // cola muda (el editor tampoco lo reproduce).
      const conSonido = clip.srcDur ? Math.min(clip.dur, Math.max(0, clip.srcDur - clip.trim) / rate) : clip.dur;
      if (conSonido <= 0) continue;
      const entrada = entradas.length + 1;
      entradas.push(["-i", file]);
      const n = entradas.length - 1;
      lineas.push(
        `[${entrada}:a]atrim=start=${seg(clip.trim)}:end=${seg(clip.trim + conSonido * rate)},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${tempo(rate)},` +
          `adelay=delays=${Math.round(start)}:all=1[c${n}]`,
      );
      clips.push(`[c${n}]`);
    }
    if (!clips.length) return;
    const mezcla = clips.length === 1 ? clips[0] : `[m${k}]`;
    if (clips.length > 1) lineas.push(`${clips.join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0:duration=longest[m${k}]`);
    lineas.push(`${mezcla}volume='${ganancia(track)}':eval=frame[p${k}]`);
    pistas.push(`[p${k}]`);
  });

  const Tot = seg(totalMs);
  if (!pistas.length) {
    lineas.push(`anullsrc=r=48000:cl=stereo,atrim=end=${Tot}[aout]`);
  } else {
    const todas = pistas.length === 1 ? pistas[0] : "[mix]";
    if (pistas.length > 1) lineas.push(`${pistas.join("")}amix=inputs=${pistas.length}:normalize=0:dropout_transition=0:duration=longest[mix]`);
    // Exactamente lo que dura el video: se rellena si el montaje termina antes y se corta si sigue.
    lineas.push(`${todas}apad=whole_dur=${Tot},atrim=end=${Tot}[aout]`);
  }
  return { entradas, grafo: lineas.join(";\n") };
}

async function mezclarYUnir(job: Interno, tracks: Track[], video: string, salida: string, dir: string) {
  const { entradas, grafo } = grafoDeAudio(tracks, job.videoMs, job.warnings);
  const script = path.join(dir, "audio.txt");
  await writeFile(script, grafo, "utf8");
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", video,
    ...entradas.flat(),
    // El grafo va en un archivo: con decenas de piezas y curvas no entra en la
    // línea de comandos de Windows.
    "-/filter_complex", script,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-t", seg(job.videoMs),
    "-movflags", "+faststart",
    salida,
  ];
  const ff = spawn(FFMPEG(), args, { stdio: ["ignore", "ignore", "pipe"] });
  job.hijo = ff;
  let errFf = "";
  ff.stderr?.on("data", (d) => (errFf = (errFf + String(d)).slice(-2000)));
  const code = await new Promise<number>((res, rej) => {
    ff.on("error", (e) => rej(new Error(`No se pudo correr ffmpeg (${e.message}).`)));
    ff.on("close", (c) => res(c ?? 0));
  });
  job.hijo = null;
  if (job.cancelado) throw new Cancelado();
  if (code !== 0) throw new Error(`ffmpeg falló al mezclar el audio: ${errFf.trim() || `código ${code}`}`);
}
