/**
 * Lista de modelos seleccionables para la UI, servida desde el catalogo de
 * OpenRouter.
 *
 * Antes esto pegaba a `GET https://api.anthropic.com/v1/models`. Ahora el
 * catalogo lo trae el motor (`engine/llm/providers/openrouterCatalog`), que ya
 * lo mantiene caliente para tarificar y para resolver capacidades: pedirlo de
 * nuevo por nuestra cuenta seria una segunda copia del mismo dato, capaz de
 * quedar desincronizada de la que el motor usa para cobrar.
 */
import {
  isOpenRouterWarm,
  openRouterCatalog,
  warmOpenRouterCatalog,
} from "../../engine/llm/providers/openrouterCatalog";

export interface SelectableModel {
  value: string;
  label: string;
  createdAt?: string;
}

export async function listSelectableModels(): Promise<SelectableModel[]> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY no configurada");
  }
  // El precalentado corre al arrancar el motor; si todavia no termino (o la
  // primera corrida fallo) se fuerza aca en vez de devolver una lista vacia,
  // que en la UI se ve igual que "no hay modelos".
  if (!isOpenRouterWarm()) await warmOpenRouterCatalog();

  return openRouterCatalog().map((m) => ({
    // El id se guarda CUALIFICADO: es lo que el motor sabe resolver a un
    // cliente. Sin el prefijo, `providerOf` lo lee como un modelo de Anthropic
    // y el turno muere buscando una clave que ya no existe.
    value: `openrouter/${m.id}`,
    label: m.name,
  }));
}
