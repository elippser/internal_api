/**
 * Que hay que volver a verificar en la Academia (ROOMBIR-ACADEMY-SPEC.md §8).
 *
 *   npm run academy:stale            informe
 *   npm run academy:stale -- --strict  sale con 1 si hay algo vencido o roto
 *
 * No toca la base: lee las lecciones (web), el banco (api) y, si esta a mano,
 * el dosier de mercado y los documentos de marca de la raiz del workspace.
 *
 * Plazos:
 *   - C.3 y C.5 (paridad, redes, IA): 90 dias. Son los datos que mas cambian.
 *   - Bloque E (Roombir): 45 dias. El producto cambia cada semana.
 *   - El resto: 365 dias (cifras anuales).
 *   - F.1: ademas, si el Manual o la Identidad se modificaron despues.
 * Y tres chequeos de consistencia: fuentes del dosier que no existen, items mas
 * viejos que su leccion, y lecciones sin ningun item.
 */
import fs from "fs";
import path from "path";
import { BANK } from "../modules/academy/bank/items";

const API_ROOT = path.resolve(__dirname, "../..");
const LESSONS_DIR = path.resolve(API_ROOT, "../web/src/modules/academy/content/es/lessons");
const WORKSPACE = path.resolve(API_ROOT, "../..");
const DOSIER = path.join(WORKSPACE, "ROOMBIR-ACADEMY-DOSIER-MERCADO.md");
const BRAND_DOCS = ["MANUAL-DE-MARCA-ROOMBIR.md", "IDENTIDAD-COMUNICACIONAL-2026.md"].map((f) => path.join(WORKSPACE, f));

const DAY = 86_400_000;
const VOLATILE = new Set(["C.3", "C.5"]);
const maxAgeDays = (id: string, module: string): number => (VOLATILE.has(id) ? 90 : module === "E" ? 45 : 365);

interface LessonMeta {
  id: string;
  module: string;
  title: string;
  verifiedAt: string;
  sources: string[];
  file: string;
}

function readLessons(): LessonMeta[] {
  if (!fs.existsSync(LESSONS_DIR)) return [];
  return fs
    .readdirSync(LESSONS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(LESSONS_DIR, file), "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
      const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
      return {
        id: get("id"),
        module: get("module"),
        title: get("title"),
        verifiedAt: get("verifiedAt"),
        sources: get("sources").split(",").map((s) => s.trim()).filter(Boolean),
        file,
      };
    })
    .filter((l) => l.id);
}

function dosierIds(): Set<string> | null {
  if (!fs.existsSync(DOSIER)) return null;
  const text = fs.readFileSync(DOSIER, "utf8");
  const ids = new Set<string>();
  for (const m of text.matchAll(/^\|\s*(\d+\.\d+)\s*\|/gm)) ids.add(m[1]);
  for (const m of text.matchAll(/^## (\d+)\./gm)) ids.add(m[1]);
  return ids;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const now = Date.now();
  const lessons = readLessons();
  const ids = dosierIds();
  const problems: string[] = [];
  const stale: string[] = [];

  if (!lessons.length) problems.push(`No encontre lecciones en ${LESSONS_DIR}`);

  // 1. Lecciones vencidas.
  for (const l of lessons) {
    const at = Date.parse(l.verifiedAt);
    if (Number.isNaN(at)) {
      problems.push(`${l.id}: verifiedAt invalido ("${l.verifiedAt}")`);
      continue;
    }
    const age = Math.floor((now - at) / DAY);
    const max = maxAgeDays(l.id, l.module);
    if (age > max) stale.push(`${l.id.padEnd(5)} ${l.title} · verificada hace ${age} dias (plazo ${max})`);
  }

  // 2. F.1 contra los documentos de marca.
  const f1 = lessons.find((l) => l.id === "F.1");
  if (f1) {
    for (const doc of BRAND_DOCS) {
      if (!fs.existsSync(doc)) continue;
      const modified = fs.statSync(doc).mtimeMs;
      // Se compara contra el final del dia de verificacion: el mismo dia no cuenta.
      if (modified > Date.parse(f1.verifiedAt) + DAY) {
        stale.push(`F.1   ${path.basename(doc)} cambio el ${new Date(modified).toISOString().slice(0, 10)}, despues de la ultima verificacion (${f1.verifiedAt})`);
      }
    }
  }

  // 3. Fuentes del dosier que no existen.
  if (ids) {
    for (const l of lessons) {
      for (const s of l.sources) {
        if (s.startsWith("dosier:") && !ids.has(s.slice(7))) problems.push(`${l.id}: cita ${s}, que no esta en el dosier`);
      }
    }
    for (const it of BANK) {
      for (const s of it.sources) {
        if (s.startsWith("dosier:") && !ids.has(s.slice(7))) problems.push(`item ${it.id}: cita ${s}, que no esta en el dosier`);
      }
    }
  }

  // 4. Items mas viejos que su leccion, y lecciones sin items.
  const byLesson = new Map(lessons.map((l) => [l.id, l]));
  const outdatedItems = new Map<string, number>();
  for (const it of BANK) {
    const l = byLesson.get(it.lesson);
    if (!l) {
      problems.push(`item ${it.id}: su leccion ${it.lesson} no existe`);
      continue;
    }
    if (Date.parse(it.verifiedAt) < Date.parse(l.verifiedAt)) outdatedItems.set(l.id, (outdatedItems.get(l.id) ?? 0) + 1);
  }
  const withItems = new Set(BANK.map((it) => it.lesson));
  const noItems = lessons.filter((l) => !withItems.has(l.id) && !["0", "E"].includes(l.module) && l.id !== "E.0").map((l) => l.id);
  const eNoItems = lessons.filter((l) => l.module === "E" && l.id !== "E.0" && !withItems.has(l.id)).map((l) => l.id);

  console.log(`Academia: ${lessons.length} lecciones, ${BANK.length} items${ids ? `, ${ids.size} entradas del dosier` : " (dosier no encontrado: no se revisan sus fuentes)"}\n`);

  console.log(stale.length ? `VENCIDO (${stale.length})` : "Nada vencido.");
  stale.forEach((s) => console.log("  " + s));

  if (outdatedItems.size) {
    console.log(`\nITEMS VERIFICADOS ANTES QUE SU LECCION (releer contra el texto actual)`);
    [...outdatedItems.entries()].sort().forEach(([id, n]) => console.log(`  ${id.padEnd(5)} ${n} ${n === 1 ? "item" : "items"}`));
  }
  if (noItems.length || eNoItems.length) console.log(`\nLECCIONES SIN PREGUNTAS: ${[...noItems, ...eNoItems].join(", ")}`);

  console.log(problems.length ? `\nROTO (${problems.length})` : "\nSin referencias rotas.");
  problems.forEach((p) => console.log("  " + p));

  if (strict && (stale.length || problems.length)) process.exit(1);
}

main();
