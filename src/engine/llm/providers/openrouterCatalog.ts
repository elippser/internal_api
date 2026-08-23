/**
 * Catálogo dinámico de OpenRouter (§11.3).
 *
 * A diferencia del catálogo estático de Anthropic, acá hay cientos de modelos
 * de decenas de proveedores y la lista cambia todas las semanas. Hardcodearla
 * sería garantizar que esté desactualizada.
 *
 * El catálogo se PRECALIENTA al arrancar y se cachea con TTL. Eso importa por
 * una razón concreta: `capabilitiesFor()` es SÍNCRONA y está en el camino
 * caliente de cada llamada al modelo (la usa el traductor de razonamiento).
 * Si tuviera que esperar una petición HTTP, cada turno pagaría ese viaje. Con
 * el precalentado, la consulta síncrona lee memoria.
 *
 * Si el precalentado falla, el motor NO se cae: los modelos de OpenRouter caen
 * a un perfil conservador y siguen corriendo. Un catálogo es metadata, no una
 * dependencia dura.
 */
import { createLogger, errField } from "../../core/logger";

const log = createLogger("engine:openrouter:catalog");

const ENDPOINT = "https://openrouter.ai/api/v1/models";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h: la lista cambia por semana, no por hora

export interface OpenRouterModel {
  /** Id completo, con el proveedor de origen: `anthropic/claude-opus-5`. */
  id: string;
  name: string;
  /** Familia de origen (`openai`, `google`, `meta-llama`...). */
  vendor: string;
  contextLength: number;
  maxOutputTokens: number | null;
  vision: boolean;
  /** Acepta herramientas. Un agente con tools contra uno que no, no sirve. */
  tools: boolean;
  /** Acepta el parámetro de razonamiento. */
  reasoning: boolean;
  /** USD por millón de tokens, ya convertido desde el precio por token. */
  promptPerMTok: number;
  completionPerMTok: number;
}

interface CacheEntry {
  at: number;
  byId: Map<string, OpenRouterModel>;
  list: OpenRouterModel[];
}

let cache: CacheEntry | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Estado de la CLAVE, separado del catálogo.
 *
 * La separación no es cosmética: el listado de modelos de OpenRouter es
 * público, así que carga igual con una clave inválida — o con una que no sirve
 * para inferir. Sin esta verificación, el motor arranca "verde", el selector
 * muestra 400 modelos y el problema recién aparece cuando una corrida real
 * devuelve 401. Falso verde es peor que rojo.
 */
export interface KeyStatus {
  valid: boolean;
  /** Puede llamar a `/chat/completions`. Una clave de gestión NO puede. */
  canInfer: boolean;
  label?: string;
  reason?: string;
}

let keyStatus: KeyStatus = { valid: false, canInfer: false, reason: "sin verificar" };

/**
 * Verifica la clave contra el endpoint de auth. Distingue el caso que confunde
 * a todo el mundo: una clave de APROVISIONAMIENTO autentica (200) pero no
 * puede inferir, así que todo parece configurado hasta la primera corrida.
 */
async function checkKey(apiKey: string): Promise<KeyStatus> {
  try {
    const res = await fetch(`${(process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/auth/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });

    if (res.status === 401) {
      return { valid: false, canInfer: false, reason: "La clave es inválida o fue revocada." };
    }
    if (!res.ok) {
      return {
        valid: false,
        canInfer: false,
        reason: `El proveedor respondió ${res.status} al verificar la clave.`,
      };
    }

    const body = (await res.json()) as {
      data?: { label?: string; is_management_key?: boolean; is_provisioning_key?: boolean };
    };
    const data = body.data ?? {};
    const isManagement = Boolean(data.is_management_key || data.is_provisioning_key);

    if (isManagement) {
      return {
        valid: true,
        canInfer: false,
        label: data.label,
        reason:
          "Es una clave de APROVISIONAMIENTO (gestión), no de inferencia: autentica pero no " +
          "puede llamar al modelo. Generá una clave normal en openrouter.ai/keys.",
      };
    }

    return { valid: true, canInfer: true, label: data.label };
  } catch (err) {
    return {
      valid: false,
      canInfer: false,
      reason: `No se pudo verificar la clave: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function openRouterKeyStatus(): KeyStatus {
  return keyStatus;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapModel(raw: Record<string, unknown>): OpenRouterModel | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;

  const architecture = (raw.architecture ?? {}) as Record<string, unknown>;
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const topProvider = (raw.top_provider ?? {}) as Record<string, unknown>;
  const supported = Array.isArray(raw.supported_parameters)
    ? (raw.supported_parameters as string[])
    : [];

  const modality = String(architecture.modality ?? architecture.input_modalities ?? "");
  const inputModalities = Array.isArray(architecture.input_modalities)
    ? (architecture.input_modalities as string[])
    : [];

  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    vendor: id.includes("/") ? id.slice(0, id.indexOf("/")) : "openrouter",
    contextLength: num(raw.context_length) || num(topProvider.context_length) || 8_192,
    maxOutputTokens: num(topProvider.max_completion_tokens) || null,
    vision: modality.includes("image") || inputModalities.includes("image"),
    tools: supported.includes("tools") || supported.includes("tool_choice"),
    reasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
    // OpenRouter publica el precio POR TOKEN en dólares. Se convierte a la
    // unidad del motor (por millón) acá, para que el resto no tenga que saberlo.
    promptPerMTok: num(pricing.prompt) * 1_000_000,
    completionPerMTok: num(pricing.completion) * 1_000_000,
  };
}

async function fetchCatalog(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        // La clave es opcional para listar, pero mandarla da los modelos
        // habilitados para ESTA cuenta y no el catálogo público entero.
        ...(process.env.OPENROUTER_API_KEY
          ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
          : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter respondió ${res.status}`);

    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const list = (body.data ?? [])
      .map(mapModel)
      .filter((m): m is OpenRouterModel => m !== null)
      // Los ids que empiezan con `~` son alias y variantes de vista previa del
      // proveedor. Van ÚLTIMOS: con el orden alfabético quedaban arriba de todo
      // y eran lo primero que veía alguien abriendo el selector, que es
      // exactamente lo que nadie quiere por defecto.
      .sort((a, b) => {
        const aAlias = a.id.startsWith("~");
        const bAlias = b.id.startsWith("~");
        if (aAlias !== bAlias) return aAlias ? 1 : -1;
        return a.id.localeCompare(b.id);
      });

    cache = { at: Date.now(), byId: new Map(list.map((m) => [m.id, m])), list };
    log.info("catálogo de OpenRouter precalentado", { models: list.length });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Precalienta el catálogo. Se llama al arrancar y REINTENTA una vez ante una
 * obtención parcial: el catálogo alimenta el selector de modelos de la consola
 * y un arranque sin él deja la pantalla vacía sin explicación.
 */
export async function warmOpenRouterCatalog(): Promise<boolean> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    keyStatus = { valid: false, canInfer: false, reason: "OPENROUTER_API_KEY no está configurada." };
    log.debug("OPENROUTER_API_KEY no configurada; se omite el precalentado");
    return false;
  }
  if (inFlight) {
    await inFlight;
    return isOpenRouterWarm();
  }

  inFlight = (async () => {
    // La clave se verifica ANTES del catálogo. Si no sirve para inferir, traer
    // 400 modelos sólo sirve para que alguien elija uno y falle después.
    keyStatus = await checkKey(apiKey);
    if (!keyStatus.canInfer) {
      log.warn("la clave de OpenRouter no sirve para inferencia", { reason: keyStatus.reason });
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fetchCatalog();
        return;
      } catch (err) {
        if (attempt === 1) {
          log.warn("no se pudo precalentar el catálogo de OpenRouter", errField(err));
        }
      }
    }
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
  return isOpenRouterWarm();
}

/** Piso entre reintentos cuando el catálogo está FRÍO, para no martillar. */
const COLD_RETRY_MS = 60_000;
let lastColdAttempt = 0;

/**
 * Refresca en segundo plano. Nunca bloquea al llamador.
 *
 * Cubre DOS casos, y el segundo era un agujero real: si el precalentado del
 * arranque falló (clave ausente, red caída, o la clave se configuró DESPUÉS de
 * levantar el proceso), el catálogo quedaba frío para siempre y la única salida
 * era reiniciar. Ahora reintenta solo, con un piso de un minuto entre intentos
 * para no golpear al proveedor en cada consulta de capacidades.
 */
function refreshIfStale(): void {
  if (!cache) {
    if (Date.now() - lastColdAttempt < COLD_RETRY_MS) return;
    lastColdAttempt = Date.now();
    void warmOpenRouterCatalog();
    return;
  }
  if (Date.now() - cache.at < TTL_MS) return;
  void warmOpenRouterCatalog();
}

/**
 * Fuerza una recarga, ignorando el caché y el piso de reintento. La usa el
 * endpoint de la consola: cuando un operador acaba de configurar la clave,
 * esperar un minuto (o reiniciar) para verlo es una fricción evitable.
 */
export async function forceRefreshOpenRouterCatalog(): Promise<{
  ok: boolean;
  models: number;
  reason?: string;
}> {
  cache = null;
  lastColdAttempt = 0;
  const ok = await warmOpenRouterCatalog();
  return {
    ok,
    models: cache ? (cache as CacheEntry).list.length : 0,
    reason: ok ? undefined : keyStatus.reason,
  };
}

/** Lectura SÍNCRONA desde el caché precalentado. Null si todavía no está. */
export function openRouterModel(id: string): OpenRouterModel | null {
  refreshIfStale();
  return cache?.byId.get(id) ?? null;
}

export function openRouterCatalog(): OpenRouterModel[] {
  refreshIfStale();
  return cache?.list ?? [];
}

/**
 * "Caliente" exige catálogo Y una clave que pueda inferir. Devolver true con
 * una clave de gestión mostraría 400 modelos elegibles que fallan todos.
 */
export function isOpenRouterWarm(): boolean {
  return cache !== null && keyStatus.canInfer;
}

/** Sólo para pruebas. */
export function primeOpenRouterCatalog(models: OpenRouterModel[]): void {
  cache = { at: Date.now(), byId: new Map(models.map((m) => [m.id, m])), list: models };
}
