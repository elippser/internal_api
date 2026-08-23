/**
 * Identificadores ordenables en el tiempo (UUID v7).
 *
 * Invariante estructural: TODA fila del motor lleva un id v7 como clave de
 * negocio. Mongo ya da un `_id` ordenable (ObjectId), pero ese id es interno y
 * no viaja por la API; el id v7 sí. Ordenables en el tiempo importa de verdad
 * en dos lugares: el reclamo del bucle de trabajo (que ordena por antigüedad
 * para que la cola sea FIFO) y el diario de eventos (que se reproduce en orden).
 *
 * Se usa v7 y no v4 a propósito: con v4 un índice por `executionId` degenera en
 * escrituras aleatorias sobre el B-tree; con v7 el prefijo es el timestamp y las
 * inserciones son casi apend-only.
 */
import { randomBytes } from "crypto";

// Contador monotónico dentro del mismo milisegundo. Sin esto, dos ids generados
// en el mismo ms quedan ordenados por azar y el diario de eventos se reproduce
// desordenado (`seq` lo cubre para eventos, pero no para pasos).
let lastMs = 0;
let seqInMs = 0;

/** UUID v7 crudo (formato canónico con guiones). */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms === lastMs) {
    seqInMs += 1;
    // Desbordamos los 12 bits de `rand_a`: empujamos al ms siguiente en vez de
    // repetir un id. Prefiero un id "del futuro" por 1ms a una colisión.
    if (seqInMs > 0xfff) {
      ms += 1;
      lastMs = ms;
      seqInMs = 0;
    }
  } else {
    lastMs = ms;
    seqInMs = 0;
  }

  const bytes = randomBytes(16);

  // 48 bits de timestamp en milisegundos (big-endian).
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Versión 7 + los 12 bits de secuencia monotónica.
  bytes[6] = 0x70 | ((seqInMs >> 8) & 0x0f);
  bytes[7] = seqInMs & 0xff;

  // Variante RFC 4122.
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  const hex = bytes.toString("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

/** Id de dominio con prefijo legible: `exec-0192f0a1-...`. */
export function newId(prefix: string): string {
  return `${prefix}-${uuidv7()}`;
}

/**
 * Marca de tiempo embebida en un id v7 (o null si no es v7). Sirve para ordenar
 * o auditar sin ir a la base.
 */
export function timestampOf(id: string): Date | null {
  // El UUID se extrae por PATRÓN y no cortando por el primer guion: todo UUID
  // canónico lleva guiones, así que "cortar por el primero" parte al UUID a la
  // mitad cuando el id viene sin prefijo. Anclado al final para que funcione
  // igual con `exec-0192...` que con `0192...`.
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id);
  if (!match) return null;

  const hex = match[0].replace(/-/g, "");
  const version = parseInt(hex.slice(12, 13), 16);
  if (version !== 7) return null;

  const ms = parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
