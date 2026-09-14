/**
 * ¿El usuario preguntó por OTRO lugar que no es la zona de su propiedad?
 *
 * "¿Cómo viene el movimiento en Salta?" desde un hotel de Mendoza no se contesta
 * con los datos de Mendoza, ni se adivina: se aclara y se pregunta. Esto lo
 * detecta sin gastar un pedido: un nombre propio después de "en/de/para/cerca
 * de" que no es la ciudad, la provincia, el país ni el nombre de la propiedad.
 *
 * Es conservador a propósito. Ante la duda NO marca: contestar con la zona de
 * la propiedad y aclararlo es mejor que frenar una pregunta legítima porque
 * mencionó "Semana Santa" o "el Día del Padre".
 */

import { deaccent } from "./format";

const COUNTRY_NAMES: Record<string, string[]> = {
  AR: ["argentina"], UY: ["uruguay"], CL: ["chile"], BR: ["brasil", "brazil"], PY: ["paraguay"],
  BO: ["bolivia"], PE: ["peru"], CO: ["colombia"], MX: ["mexico"], ES: ["espana"],
  US: ["estados unidos", "eeuu", "usa"], EC: ["ecuador"], VE: ["venezuela"], CR: ["costa rica"],
};

/** Palabras que empiezan con mayúscula y no son un lugar. */
const STOP = new Set([
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre",
  "octubre", "noviembre", "diciembre", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
  "semana", "santa", "navidad", "ano", "nuevo", "carnaval", "pascua", "pascuas", "dia", "dias", "del", "de", "la",
  "las", "los", "el", "y", "padre", "madre", "nino", "ninos", "enamorados", "amigo", "primavera", "verano",
  "invierno", "otono", "roombir", "ia", "google", "wikipedia", "booking", "airbnb", "expedia", "instagram",
  "facebook", "whatsapp", "tiktok", "mi", "tu", "su", "mis", "nuestro", "nuestra", "fin", "finde",
]);

/** Si el nombre propio arranca así, es un evento, no un lugar. */
const EVENT_FIRST = new Set([
  "dia", "fiesta", "festival", "feria", "congreso", "semana", "fin", "gran", "mundial", "copa", "expo",
  "noche", "vendimia", "oktoberfest", "maraton", "torneo", "campeonato", "gp", "gran premio",
]);

const CANDIDATE =
  /(?:^|[\s¿¡(,;:])(?:[Ee]n|[Dd]e|[Dd]el|[Pp]ara|[Ss]obre|[Hh]acia|[Cc]erca\s+de)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü.'-]+(?:\s+(?:(?:de|del|la|las|los|el)\s+)?[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü.'-]+){0,3})/g;

const norm = (s: string): string =>
  deaccent(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export interface KnownPlace {
  city?: string | null;
  stateProvince?: string | null;
  countryCode?: string | null;
  name?: string | null;
}

/** Devuelve el lugar mencionado si NO es el de la propiedad; null si no hay o no se sabe. */
export function mentionedOtherPlace(message: string, known: KnownPlace): string | null {
  const knownList = [
    known.city,
    known.stateProvince,
    known.name,
    ...(COUNTRY_NAMES[(known.countryCode ?? "").toUpperCase()] ?? []),
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(norm);

  for (const match of message.matchAll(CANDIDATE)) {
    const raw = match[1].trim();
    const cand = norm(raw);
    if (cand.length < 3) continue;
    const words = cand.split(" ");
    if (words.every((w) => STOP.has(w))) continue;
    if (EVENT_FIRST.has(words[0])) continue;
    if (knownList.some((k) => k.includes(cand) || cand.includes(k))) continue;
    return raw;
  }
  return null;
}
