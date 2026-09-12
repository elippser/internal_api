/**
 * Selección de playbooks: función PURA, sin modelo y sin IO.
 *
 * Evalúa las reglas de cada playbook contra la foto aplanada de la propiedad.
 * Un playbook aplica si cumple TODAS sus reglas; se ordenan por especificidad
 * (suma de pesos de las reglas cumplidas) y se devuelven como mucho 3.
 *
 * Por qué tres: son ~600 tokens de cuerpo cada uno. Con tres, el modelo tiene
 * de dónde elegir y combinar; con seis, el prompt se llena de estrategias que
 * no aplican y el diagnóstico se diluye — que es el problema original.
 */

import type { FlatSnapshot } from "../snapshot/snapshot.types";
import type { ApplicabilityRule, Playbook } from "./growthPlaybook.model";

export const MAX_PLAYBOOKS = Number(process.env.GROWTH_MAX_PLAYBOOKS ?? 3);

export interface PlaybookMatch {
  playbook: Playbook;
  /** Suma de pesos: a más condiciones específicas cumplidas, más arriba. */
  score: number;
  /** Qué reglas lo hicieron aplicar, para el log y para `verify`. */
  matched: string[];
}

function compare(op: ApplicabilityRule["op"], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as never);
    default:
      return false;
  }
}

/**
 * ¿Se cumple esta regla sobre la foto?
 *
 * La distinción clave está en `missing`/`present` y en el `null`: una clave que
 * no está en la foto significa que el bloque no se pudo leer, y una clave con
 * valor `null` significa que se leyó pero no hay dato (p. ej. un hotel sin
 * reseñas no tiene rating). Ninguna de las dos es "cero", y una regla numérica
 * sobre cualquiera de las dos NO se cumple: proponer "tu rating está bajo"
 * porque no hay rating sería inventar el diagnóstico.
 */
export function ruleMatches(rule: ApplicabilityRule, flat: FlatSnapshot): boolean {
  const has = Object.prototype.hasOwnProperty.call(flat, rule.path);
  const actual = has ? flat[rule.path] : undefined;

  if (rule.op === "missing") return !has || actual === null;
  if (rule.op === "present") return has && actual !== null;
  if (!has || actual === null) return false;

  return compare(rule.op, actual, rule.value);
}

export function resolveApplicablePlaybooks(
  playbooks: Playbook[],
  flat: FlatSnapshot,
  limit = MAX_PLAYBOOKS,
): PlaybookMatch[] {
  const matches: PlaybookMatch[] = [];

  for (const playbook of playbooks) {
    // Un playbook sin reglas aplicaría siempre: es un error de seed, no un
    // comodín. Se descarta en silencio acá y `verify:playbook-levers` lo grita.
    if (playbook.applicability.length === 0) continue;

    let score = 0;
    const matched: string[] = [];
    let all = true;
    for (const rule of playbook.applicability) {
      if (!ruleMatches(rule, flat)) {
        all = false;
        break;
      }
      score += rule.weight ?? 1;
      matched.push(`${rule.path} ${rule.op}${rule.value !== undefined ? ` ${JSON.stringify(rule.value)}` : ""}`);
    }
    if (all) matches.push({ playbook, score, matched });
  }

  return matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Empate: orden estable por id, para que dos corridas con la misma foto
      // produzcan el mismo prompt (y por lo tanto peguen en el mismo caché).
      return a.playbook.playbookId.localeCompare(b.playbook.playbookId);
    })
    .slice(0, limit);
}

/**
 * Nivel 1 + nivel 2 JUNTOS, en el bloque dinámico.
 *
 * El spec original proponía traer el cuerpo con `load_skill`, como las
 * habilidades. Acá no conviene y el motivo es aritmético: una carga por
 * `load_skill` cuesta una iteración entera del loop (re-envío de todo el
 * contexto + otra ida y vuelta al proveedor, 3-6 s), mientras que los tres
 * cuerpos juntos son ≤1.800 tokens. Precargar sale más barato y más rápido que
 * una sola carga bajo demanda. `load_skill` sigue existiendo para las 12
 * habilidades, que son muchas más y se usan de a una.
 */
export function renderPlaybooksBlock(matches: PlaybookMatch[]): string {
  if (matches.length === 0) {
    return [
      "## Estrategias aplicables",
      "Ninguna de las estrategias del catálogo aplica a esta propiedad con los datos de la foto.",
      "Diagnosticá igual a partir de la foto y proponé pasos del índice de palancas,",
      "pero NO inventes una estrategia con nombre propio ni cites un playbook que no está acá.",
    ].join("\n");
  }

  const blocks = matches.map((m, idx) => {
    const p = m.playbook;
    return [
      `### ${idx + 1}. ${p.name}  \`${p.playbookId}\``,
      `_${p.summary}_`,
      `Aplica porque: ${m.matched.join("; ")}.`,
      "",
      p.body.trim(),
    ].join("\n");
  });

  return [
    "## Estrategias aplicables (elegidas por el sistema según la foto)",
    "Son las únicas que podés usar. El sistema ya las filtró contra los datos reales de",
    "esta propiedad: no busques otras ni cites playbooks que no estén en esta lista.",
    "Podés combinar pasos de varias si el diagnóstico lo justifica.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}
