/**
 * Párrafos del panel "Mi estatus turístico", uno por faceta.
 *
 * Una sola llamada al tier barato por VERSIÓN del dossier, no por apertura del
 * panel: el resultado se guarda con la huella de cuándo se leyó cada hub y se
 * reutiliza hasta que algún dato cambie. Si la llamada falla, el panel se
 * muestra igual, sólo con los datos.
 *
 * Mismo principio que la tarjeta: los números van arriba del párrafo, puestos
 * por el código; el modelo sólo explica qué significan.
 */

import { createHash } from "crypto";
import type { ExperienceLevel } from "../../shared/agentAuth/userScope";
import {
  getLlmClient,
  modelFor,
  thinkingBlockFor,
  withReasoningHeadroom,
} from "../../shared/llm/provider";
import { renderTourismBlock } from "./render";
import {
  TOURISM_FACETS,
  TOURISM_HUBS,
  type HubEnvelope,
  type StoredNarratives,
  type TourismDossier,
  type TourismFacet,
} from "./tourism.types";

/** Huella de la versión del dossier: cambia cuando se relee cualquier hub. */
export function narrativesStamp(d: TourismDossier): string {
  const parts = TOURISM_HUBS.map((hub) => {
    const env = d.hubs[hub] as HubEnvelope | undefined;
    return `${hub}:${env ? `${env.computedAt}:${env.data ? 1 : 0}` : "-"}`;
  });
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

const SYSTEM = [
  'Escribís el panel "Mi estatus turístico" de un alojamiento, para un hotelero promedio (no un experto).',
  "Recibís los datos reales de la zona del alojamiento, leídos por el sistema.",
  "Devolvé SOLO un objeto JSON, sin texto antes ni después, con estas claves:",
  '- "movimiento": el interés online en el destino y las vacaciones de los mercados que viajan hasta ahí.',
  '- "eventos": los eventos cercanos y qué demanda pueden traer.',
  '- "entorno": cómo es el barrio a pie para un huésped.',
  '- "estacionalidad": feriados, fines de semana largos, recesos escolares y clima de la temporada.',
  "Cada valor es un párrafo de 40 a 80 palabras que explica qué significan esos datos para ESTE alojamiento y qué conviene tener en cuenta.",
  "Reglas:",
  "- Usá sólo los datos del bloque. Nunca agregues conocimiento general sobre la zona.",
  "- No repitas las cifras: el usuario las ve justo arriba del párrafo. Interpretalas.",
  "- Lo marcado [estimado] es una referencia general, no un dato en vivo: si lo usás, decilo.",
  "- Si una sección no tiene datos en el bloque, su valor es null.",
  "- Frases cortas, tono cercano, sin jerga de revenue management (nada de ADR, RevPAR ni pace).",
].join("\n");

const MAX_CHARS = 900;

export function parseNarratives(text: string): Partial<Record<TourismFacet, string>> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const out: Partial<Record<TourismFacet, string>> = {};
    for (const facet of TOURISM_FACETS) {
      const v = obj[facet];
      if (typeof v === "string" && v.trim()) out[facet] = v.trim().slice(0, MAX_CHARS);
    }
    return out;
  } catch {
    return {};
  }
}

export interface NarrativesResult {
  narratives: StoredNarratives;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export async function generateNarratives(
  d: TourismDossier,
  level: ExperienceLevel,
): Promise<NarrativesResult | null> {
  const model = process.env.LLM_MODEL_TOURISM_NARRATIVES ?? modelFor("cheap");
  const t0 = Date.now();
  try {
    const thinking = thinkingBlockFor(model, { enabled: false });
    const res = await getLlmClient().messages.create({
      model,
      max_tokens: withReasoningHeadroom(model, 1200),
      ...(thinking ? { thinking } : {}),
      system: SYSTEM,
      messages: [{ role: "user", content: renderTourismBlock(d, TOURISM_FACETS, { level }) }],
    });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const byFacet = parseNarratives(text);
    if (Object.keys(byFacet).length === 0) {
      console.warn("[tourism] las narrativas volvieron sin un JSON utilizable");
      return null;
    }
    const usage = res.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      narratives: {
        stamp: narrativesStamp(d),
        model,
        level,
        createdAt: new Date().toISOString(),
        byFacet,
      },
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ms: Date.now() - t0,
    };
  } catch (err) {
    console.warn("[tourism] no se pudieron generar las narrativas:", err instanceof Error ? err.message : err);
    return null;
  }
}
