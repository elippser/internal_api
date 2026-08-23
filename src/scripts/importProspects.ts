import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDB } from "../shared/db";
import { prospectsService } from "../modules/prospects/prospects.service";
import { Prospect } from "../modules/prospects/prospects.model";

/**
 * Carga la lista de prospectos desde `clients.md` (la raiz del monorepo).
 *
 * El archivo NO es markdown: son dos objetos JSON pegados uno debajo del otro,
 * separados por una linea de emojis. Cada uno es un barrido distinto de los
 * posts guardados de Instagram, y entre los dos hay perfiles repetidos — el
 * mismo alojamiento aparece en varios posts. Por eso el pipeline es:
 *
 *   1. partir el archivo por la linea separadora y parsear cada bloque
 *   2. unificar por handle: un prospecto por perfil, con TODOS sus posts
 *   3. delegar en `prospectsService.importRows`, que normaliza y upsertea
 *
 * Es idempotente: correrlo dos veces no duplica nada y sobre una ficha que ya
 * existe solo completa huecos (nunca pisa etapa, notas, duenio ni seguimiento).
 *
 *   npm run import:prospects              # usa ../../clients.md
 *   npm run import:prospects -- <archivo> # otro archivo
 *   npm run import:prospects -- --dry     # no escribe, solo informa
 */

interface RawProspect {
  perfil?: string | null;
  perfil_url?: string | null;
  nombre?: string | null;
  url_post?: string | null;
  tipo_alojamiento?: string | null;
  ubicacion?: string | null;
  fecha_post?: string | null;
  contacto?: {
    telefono?: string | null;
    web?: string | null;
    email?: string | null;
  } | null;
}

interface RawBlock {
  generado?: string;
  fuente?: string;
  prospectos?: RawProspect[];
}

/**
 * Parte el archivo en bloques JSON. La linea separadora es una fila de emojis
 * sin llaves; se detecta asi y no por el emoji exacto para que un cambio de
 * corazoncito no rompa la carga.
 */
function splitBlocks(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const isSeparator = (line: string) => {
    const t = line.trim();
    if (t.length < 6) return false;
    // Sin caracteres de JSON y con al menos un simbolo fuera del ASCII.
    return !/[{}[\]":]/.test(t) && /[^\x00-\x7F]/.test(t) && !/[a-zA-Z0-9]/.test(t);
  };
  for (const line of lines) {
    if (isSeparator(line)) {
      blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  blocks.push(current.join("\n"));
  return blocks.map((b) => b.trim()).filter((b) => b.startsWith("{"));
}

/** Handle desde `perfil` o desde `perfil_url`, en minusculas y sin arroba. */
function handleOf(row: RawProspect): string | null {
  const fromField = (row.perfil ?? "").trim().toLowerCase().replace(/^@/, "");
  if (fromField) return fromField;
  const m = (row.perfil_url ?? "").match(/instagram\.com\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

interface Merged {
  handle: string;
  name: string;
  handleUrl?: string;
  lodgingType?: string;
  location?: string;
  phone?: string;
  email?: string;
  website?: string;
  posts: Array<{ url: string; postedAt?: string }>;
  lastPostAt?: string;
}

/**
 * Un prospecto por perfil. Del nombre gana el mas descriptivo (los barridos
 * traen a veces solo el handle y a veces el nombre comercial completo), del
 * contacto gana el primer dato no vacio, y los posts se acumulan todos: son la
 * evidencia de que el negocio existe y sigue publicando.
 */
function mergeByHandle(rows: RawProspect[]): Merged[] {
  const byHandle = new Map<string, Merged>();
  for (const row of rows) {
    const handle = handleOf(row);
    if (!handle) continue;
    const name = (row.nombre ?? "").trim() || handle;
    const existing = byHandle.get(handle);
    const post = row.url_post
      ? { url: row.url_post, postedAt: row.fecha_post ?? undefined }
      : null;

    if (!existing) {
      byHandle.set(handle, {
        handle,
        name,
        handleUrl: row.perfil_url ?? undefined,
        lodgingType: row.tipo_alojamiento ?? undefined,
        location: row.ubicacion ?? undefined,
        phone: row.contacto?.telefono ?? undefined,
        email: row.contacto?.email ?? undefined,
        website: row.contacto?.web ?? undefined,
        posts: post ? [post] : [],
        lastPostAt: row.fecha_post ?? undefined,
      });
      continue;
    }

    if (name.length > existing.name.length) existing.name = name;
    existing.handleUrl ??= row.perfil_url ?? undefined;
    existing.location ??= row.ubicacion ?? undefined;
    existing.phone ??= row.contacto?.telefono ?? undefined;
    existing.email ??= row.contacto?.email ?? undefined;
    existing.website ??= row.contacto?.web ?? undefined;
    // "alojamiento" es el cajon de sastre de la fuente: cualquier otro tipo
    // concreto que aparezca en otro post es mejor dato.
    if (
      row.tipo_alojamiento &&
      (!existing.lodgingType || existing.lodgingType === "alojamiento")
    ) {
      existing.lodgingType = row.tipo_alojamiento;
    }
    if (post && !existing.posts.some((p) => p.url === post.url)) {
      existing.posts.push(post);
    }
    if (row.fecha_post && (!existing.lastPostAt || row.fecha_post > existing.lastPostAt)) {
      existing.lastPostAt = row.fecha_post;
    }
  }
  return [...byHandle.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const fileArg = args.find((a) => !a.startsWith("--"));
  const file = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(__dirname, "../../../../clients.md");

  if (!fs.existsSync(file)) {
    throw new Error(`No se encontro el archivo de prospectos: ${file}`);
  }
  console.log(`[import:prospects] leyendo ${file}`);

  const blocks = splitBlocks(fs.readFileSync(file, "utf8"));
  console.log(`[import:prospects] ${blocks.length} bloque(s) JSON en el archivo`);

  const rows: RawProspect[] = [];
  blocks.forEach((block, i) => {
    let parsed: RawBlock;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      console.warn(
        `[import:prospects] bloque ${i + 1} no es JSON valido, se saltea:`,
        (err as Error).message,
      );
      return;
    }
    const list = parsed.prospectos ?? [];
    console.log(
      `[import:prospects]   bloque ${i + 1}: ${list.length} filas · ${parsed.fuente ?? "sin fuente"}`,
    );
    rows.push(...list);
  });

  const merged = mergeByHandle(rows);
  const withPhone = merged.filter((m) => m.phone).length;
  console.log(
    `[import:prospects] ${rows.length} filas -> ${merged.length} perfiles unicos ` +
      `(${rows.length - merged.length} repetidos unificados) · ${withPhone} con telefono`,
  );

  if (dry) {
    console.log("[import:prospects] --dry: no se escribe nada. Muestra de 5:");
    for (const m of merged.slice(0, 5)) {
      console.log(
        `  @${m.handle.padEnd(24)} ${m.name.slice(0, 34).padEnd(34)} ` +
          `${(m.lodgingType ?? "—").padEnd(26)} ${m.phone ?? "sin telefono"}`,
      );
    }
    return;
  }

  await connectDB();

  const batch = `instagram-guardados-${new Date().toISOString().slice(0, 10)}`;
  // De a 200: `importRows` escribe fila por fila (necesita el upsert por
  // handle), y un solo lote de 700 deja la consola muda varios minutos.
  const CHUNK = 200;
  let created = 0;
  let updated = 0;
  const skipped: Array<{ row: number; reason: string }> = [];

  for (let i = 0; i < merged.length; i += CHUNK) {
    const slice = merged.slice(i, i + CHUNK);
    const result = await prospectsService.importRows(
      slice.map((m) => ({
        name: m.name,
        handle: m.handle,
        handleUrl: m.handleUrl,
        lodgingType: m.lodgingType,
        location: m.location,
        phone: m.phone,
        email: m.email,
        website: m.website,
        // `importRows` toma UN post por fila; el resto se agregan abajo, que es
        // donde ya tenemos el documento resuelto.
        postUrl: m.posts[0]?.url,
        postedAt: m.lastPostAt,
      })),
      { source: "instagram_saved", sourceBatch: batch },
    );
    created += result.created;
    updated += result.updated;
    skipped.push(...result.skipped.map((s) => ({ ...s, row: s.row + i })));
    console.log(
      `[import:prospects]   ${Math.min(i + CHUNK, merged.length)}/${merged.length} ` +
        `· creados ${created} · actualizados ${updated}`,
    );
  }

  // Los posts extra de los perfiles que aparecian repetidos. Van en una pasada
  // aparte para no ensuciar el contrato de `importRows`, que es de una fila.
  let postsAdded = 0;
  for (const m of merged.filter((x) => x.posts.length > 1)) {
    const doc = await Prospect.findOne({ handle: m.handle });
    if (!doc) continue;
    const known = new Set((doc.posts ?? []).map((p) => p.url));
    const extra = m.posts
      .filter((p) => !known.has(p.url))
      .map((p) => ({ url: p.url, postedAt: p.postedAt ? new Date(p.postedAt) : undefined }));
    if (!extra.length) continue;
    doc.posts.push(...extra);
    await doc.save();
    postsAdded += extra.length;
  }

  const total = await Prospect.countDocuments();
  const callable = await Prospect.countDocuments({ contactability: "phone" });
  console.log(
    `\n[import:prospects] listo · creados ${created} · actualizados ${updated} · ` +
      `posts extra ${postsAdded} · salteados ${skipped.length}`,
  );
  if (skipped.length) console.log("[import:prospects] salteados:", skipped.slice(0, 10));
  console.log(
    `[import:prospects] en la base: ${total} prospectos · ${callable} con telefono para llamar`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[import:prospects] fallo:", err?.message ?? err);
  process.exit(1);
});
