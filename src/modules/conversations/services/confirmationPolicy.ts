/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * QUÉ EXIGE UNA CONFIRMACIÓN DURA (tarjeta) Y QUÉ ALCANZA CON LA PROSA.
 *
 * Historia, porque importa: el runtime tuvo una vez un gate de doble pasada
 * sobre TODA tool con `requiresConfirmation` y se sacó — se acumulaba con la
 * pregunta en prosa del agente y el usuario terminaba confirmando dos y tres
 * veces, hasta que el modelo se perdía y decía "listo" sin haber ejecutado
 * nada. No hay que repetir ese error: 203 de las tools del catálogo tienen
 * `requiresConfirmation`, y ponerle un botón a cada una vuelve el chat un
 * formulario.
 *
 * La línea que sí se sostiene es otra: **lo que no se puede deshacer no puede
 * depender de que el modelo haya preguntado bien**. Entonces:
 *
 *   - `irreversible: true`  → tarjeta CON confirmación reforzada: el usuario
 *     tiene que escribir el valor del argumento que nombra `confirmSubject`
 *     (el patrón de GitHub para borrar un repo). Vaciar un sitio, confirmar
 *     una migración de moneda, quitar un dominio.
 *   - borrado real (`isDestructive` + método DELETE, o una tool cruda a la que
 *     el modelo le pasó DELETE) → tarjeta con botón Confirmar.
 *   - el resto de las escrituras → sigue como hoy: el agente describe y
 *     pregunta en prosa, y ejecuta cuando el usuario dice que sí. Un check-in
 *     no merece un modal.
 *
 * El gate vive en dos lugares y los dos usan esta función: el runner del chat
 * (arma la tarjeta en vez de ejecutar) y `executeAction` (verifica que la
 * confirmación pendiente sea la que se está ejecutando).
 */

export type ConfirmationLevel = "none" | "card" | "typed";

export interface ConfirmationRequirement {
  level: ConfirmationLevel;
  /** Sólo en "typed": argumento cuyo valor hay que re-escribir. */
  subjectArg?: string;
  /** Sólo en "typed": el valor exacto que se espera. */
  subjectValue?: string;
  /** Motivo legible, para la tarjeta y para el log. */
  reason: string;
}

type ToolLike = {
  name: string;
  displayName?: string | null;
  category?: string;
  execution: { method: string };
  permissions?: {
    isDestructive?: boolean;
    irreversible?: boolean;
    confirmSubject?: string;
  } | null;
};

/** Método efectivo: las tools crudas lo eligen por argumento. */
export function effectiveMethod(tool: ToolLike, args: Record<string, unknown>): string {
  if (tool.category === "raw_write") {
    const m = typeof args.method === "string" ? args.method.toUpperCase() : "";
    return m || "POST";
  }
  return String(tool.execution?.method ?? "GET").toUpperCase();
}

export function confirmationFor(
  tool: ToolLike,
  args: Record<string, unknown>,
): ConfirmationRequirement {
  const perms = tool.permissions ?? {};

  if (perms.irreversible) {
    const subjectArg = perms.confirmSubject || "";
    const raw = subjectArg ? args[subjectArg] : undefined;
    const subjectValue =
      typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    return {
      level: "typed",
      subjectArg: subjectArg || undefined,
      // Sin un valor concreto que re-escribir, la confirmación reforzada se
      // degrada a la palabra ELIMINAR: pedir que tipeen "undefined" no protege
      // a nadie.
      subjectValue: subjectValue || "ELIMINAR",
      reason: "Acción irreversible: no hay forma de deshacerla.",
    };
  }

  const method = effectiveMethod(tool, args);
  if (method === "DELETE" && perms.isDestructive) {
    return {
      level: "card",
      reason: "Borra información de forma permanente.",
    };
  }

  return { level: "none", reason: "" };
}

/** ¿La respuesta escrita por el usuario habilita ejecutar? */
export function typedAnswerMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  return given.trim().toLowerCase() === String(expected).trim().toLowerCase();
}
