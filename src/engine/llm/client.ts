/**
 * Enrutado de proveedores LLM (§11.3).
 *
 * El nombre de modelo se guarda como `proveedor/modelo` y se resuelve acá por
 * prefijo. La forma del archivo sigue la receta de extensión §34: agregar un
 * proveedor es agregar una entrada al registro (clave de entorno + fábrica de
 * cliente). La fábrica de grafos no se toca, el corredor no se toca.
 *
 * En esta entrega el único proveedor con SDK cableado es Anthropic, que es el
 * que usa la plataforma. Los demás quedan DECLARADOS y fallan con un error
 * tipado que nombra el punto de extensión exacto, en vez de resolver a
 * `undefined` y explotar tres capas más abajo con "cannot read property
 * 'messages' of undefined".
 */
import Anthropic from "@anthropic-ai/sdk";
import { NotImplementedError } from "../core/errors";
import { providerOf, stripProvider } from "./catalog";
import { createOpenRouterClient } from "./providers/openrouter";

/** Cliente mínimo que el motor necesita. Deliberadamente chico. */
export interface LlmClient {
  readonly provider: string;
  /** Crea un mensaje en modo streaming y devuelve el objeto de stream del SDK. */
  stream(body: Record<string, unknown>): AnthropicStreamLike;
}

/**
 * Forma del stream del SDK que el corredor consume. Se tipa acá y no se importa
 * del SDK porque la versión instalada (0.27.x) no tipa `thinking` adaptativo ni
 * `output_config`, y el motor emite ambos: el cuerpo va como bolsa y la
 * respuesta se lee de forma defensiva.
 */
export interface AnthropicStreamLike {
  on(event: "text", cb: (delta: string) => void): unknown;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  finalMessage(): Promise<AnthropicMessageLike>;
  abort?: () => void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Presente en modelos de razonamiento; no lo tipa el SDK viejo. */
  reasoning_output_tokens?: number;
}

export interface AnthropicMessageLike {
  id?: string;
  model?: string;
  content: Array<Record<string, unknown>>;
  stop_reason?: string | null;
  stop_details?: { type?: string; category?: string | null; explanation?: string } | null;
  usage?: AnthropicUsageLike;
}

interface ProviderEntry {
  /** Variable de entorno con la clave. Se valida perezosamente, al primer uso. */
  envKey: string;
  create: (apiKey: string) => LlmClient;
}

/** MAPA 1 — proveedor -> clave de entorno + fábrica. */
const PROVIDERS: Record<string, ProviderEntry> = {
  /**
   * Gateway agregador (§11.3). Se instancia por un RAMAL ESPECIAL: URL base
   * propia, cabeceras de atribución y traducción de protocolo, en vez de por el
   * inicializador genérico. No es un proveedor más — es un enrutador a decenas
   * de proveedores detrás de un solo protocolo, y su id de modelo lleva el
   * proveedor de origen adentro (`openrouter/google/gemini-2.5-pro`).
   */
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    create: (apiKey) => createOpenRouterClient(apiKey),
  },

  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    create: (apiKey) => {
      const sdk = new Anthropic({ apiKey });
      return {
        provider: "anthropic",
        stream: (body) =>
          // El SDK 0.27.x no tipa los parámetros nuevos (`thinking` adaptativo,
          // `output_config`, variantes 2026 de las server tools). Se manda la
          // bolsa tal cual: el alambre los acepta, el tipado local va atrás.
          sdk.messages.stream(body as never) as unknown as AnthropicStreamLike,
      };
    },
  },
};

/**
 * MAPA 2 — alias de prefijo. Permite renombrar familias sin romper agentes ya
 * guardados: un agente que dice `claude/...` sigue funcionando.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  claude: "anthropic",
  "anthropic-api": "anthropic",
};

const clientCache = new Map<string, LlmClient>();

/**
 * Resuelve el cliente y el id de modelo desnudo para un nombre cualificado.
 * Un proveedor declarado pero sin cablear lanza 501 con el punto de extensión.
 */
export function resolveModel(qualifiedModel: string): { client: LlmClient; model: string; provider: string } {
  const rawProvider = providerOf(qualifiedModel);
  const provider = PROVIDER_ALIASES[rawProvider] ?? rawProvider;
  const model = stripProvider(qualifiedModel);

  const cached = clientCache.get(provider);
  if (cached) return { client: cached, model, provider };

  const entry = PROVIDERS[provider];
  if (!entry) {
    throw new NotImplementedError(
      `El proveedor LLM "${provider}"`,
      "engine/llm/client.ts -> PROVIDERS (clave de entorno + fábrica de cliente)",
    );
  }

  const apiKey = process.env[entry.envKey];
  if (!apiKey) {
    throw new NotImplementedError(
      `La clave del proveedor "${provider}" (${entry.envKey}) no está configurada`,
      `variable de entorno ${entry.envKey}`,
    );
  }

  const client = entry.create(apiKey);
  clientCache.set(provider, client);
  return { client, model, provider };
}

/** Proveedores cableados. Lo publica el endpoint de vocabulario de autoría. */
export function listProviders(): string[] {
  return Object.keys(PROVIDERS);
}

/** Sólo para pruebas. */
export function resetClientCache(): void {
  clientCache.clear();
}
