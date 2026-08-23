/**
 * Lista los modelos que expone la API de Anthropic (GET /v1/models). El SDK
 * 0.27.x no tiene `client.models.list()`, asi que pegamos al REST directo.
 *
 * Cacheado en memoria (TTL 1h): el catalogo de modelos cambia con poca
 * frecuencia y no queremos pegarle a Anthropic en cada apertura del editor.
 */

interface AnthropicModel {
  id: string;
  display_name?: string;
  created_at?: string;
}

export interface SelectableModel {
  value: string;
  label: string;
  createdAt?: string;
}

interface ModelsCache {
  at: number;
  data: SelectableModel[];
}

const TTL_MS = 60 * 60 * 1000; // 1h
let cache: ModelsCache | null = null;

export async function listAnthropicModels(): Promise<SelectableModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY no configurada");

  const all: AnthropicModel[] = [];
  let afterId: string | undefined;

  // Paginamos defensivamente (max 10 paginas de 100 = 1000 modelos).
  for (let i = 0; i < 10; i++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);

    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic /v1/models ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: AnthropicModel[];
      has_more?: boolean;
      last_id?: string;
    };
    all.push(...(json.data ?? []));
    if (!json.has_more || !json.last_id) break;
    afterId = json.last_id;
  }

  // Anthropic ya los devuelve del mas nuevo al mas viejo (created_at desc).
  const data: SelectableModel[] = all.map((m) => ({
    value: m.id,
    label: m.display_name || m.id,
    createdAt: m.created_at,
  }));

  cache = { at: Date.now(), data };
  return data;
}
